// The nexus edge facade.
//
// `nexus-facade.ts` used to claim its position before `isOrgRoute` was
// load-bearing because the org facade "would otherwise swallow" these routes.
// Writing this file disproved that: `org-facade` enumerates its paths exactly
// and never matched them. The comment is corrected and the first block below
// asserts the property that IS true and IS worth protecting — the two facades
// claim disjoint sets, so a future catch-all in either one fails here instead
// of silently capturing the other's API.
//
// Two other properties are load-bearing and are pinned here:
//
//   * the `/channels` sub-tree routes to a DIFFERENT downstream binding than
//     the rest of nexus, and `/channels/connect` must not be read as a channel
//     whose id is "connect";
//   * the provider webhook ingress is dispatched WITHOUT `resolveActor` —
//     it carries a signature, not a session — and its raw body is forwarded
//     untouched, because every provider signs the bytes as sent.

import {
  handleChannelIngressRoute,
  handleNexusRoute,
  isChannelIngressRoute,
  isNexusRoute,
} from "@api-edge/nexus-facade";
import { isOrgRoute } from "@api-edge/org-facade";

const ORG = "org_11111111111111111111111111111111";
const BASE = `/v1/organizations/${ORG}`;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetcher(body: unknown = { exposure: [] }): {
  fetcher: Fetcher;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        Response.json({ data: body, meta: { requestId: "req_inner", cursor: null } }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function sessionFetcher(userId: string): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "seller@acme.test" },
              session: { id: "ses_abc" },
              user: { id: userId, email: "seller@acme.test", displayName: "Seller" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ data: {}, meta: { requestId: "req_x", cursor: null } }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv() {
  const nexus = fakeFetcher();
  const channels = fakeFetcher({ channels: [] });
  return {
    env: {
      IDENTITY_WORKER: sessionFetcher("usr_abc123"),
      NEXUS_WORKER: nexus.fetcher,
      CHANNELS_WORKER: channels.fetcher,
      ENVIRONMENT: "test",
    } as never,
    nexusCalls: nexus.calls,
    channelCalls: channels.calls,
  };
}

const authed = (path: string, method = "GET", body?: string) =>
  new Request(`https://edge.test${path}`, {
    method,
    headers: { authorization: "Bearer tok_123", "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });

describe("facade disjointness — what the dispatch order protects", () => {
  it.each([
    `${BASE}/nexus/exposure`,
    `${BASE}/nexus/jurisdictions/US-TX`,
    `${BASE}/nexus/evaluate`,
    `${BASE}/nexus/alert-contact`,
    `${BASE}/ledger`,
    `${BASE}/ledger/import`,
    `${BASE}/registrations`,
    `${BASE}/channels`,
    `${BASE}/channels/connect`,
    `${BASE}/channels/connect/complete`,
    `${BASE}/channels/deliveries`,
    `${BASE}/channels/chn_1111`,
  ])("%s is claimed by the nexus facade and by no other", (path) => {
    expect(isNexusRoute(path)).toBe(true);
    // The half that protects the ordering: if `org-facade` ever widens to a
    // catch-all under `/v1/organizations/:id/`, this flips and the failure
    // names the collision, instead of the symptom being 404s from a worker
    // that never saw the request.
    expect(isOrgRoute(path)).toBe(false);
  });

  it("leaves the org facade's own paths alone, in both directions", () => {
    for (const path of [
      "/v1/organizations",
      `/v1/organizations/${ORG}`,
      `${BASE}/members`,
      `${BASE}/invitations/accept`,
      `${BASE}/api-keys`,
    ]) {
      expect(isOrgRoute(path)).toBe(true);
      expect(isNexusRoute(path)).toBe(false);
    }
  });

  it("does not claim routes belonging to other facades", () => {
    expect(isNexusRoute(`${BASE}/members`)).toBe(false);
    expect(isNexusRoute(`${BASE}/webhooks/endpoints`)).toBe(false);
    expect(isNexusRoute(`${BASE}/projects/prj_1/environments`)).toBe(false);
    expect(isNexusRoute("/v1/organizations")).toBe(false);
  });

  it("does not claim near-misses that would be a different resource", () => {
    expect(isNexusRoute(`${BASE}/nexus/exposure/extra`)).toBe(false);
    expect(isNexusRoute(`${BASE}/ledger/import/extra`)).toBe(false);
    expect(isNexusRoute(`${BASE}/channels/chn_1/deliveries`)).toBe(false);
  });
});

describe("method allow-list", () => {
  it.each([
    [`${BASE}/nexus/exposure`, "POST"],
    [`${BASE}/nexus/evaluate`, "GET"],
    [`${BASE}/ledger`, "DELETE"],
    [`${BASE}/registrations`, "POST"],
    [`${BASE}/nexus/alert-contact`, "POST"],
  ])("405s %s %s at the edge rather than 404ing from the worker", async (path, method) => {
    const { env, nexusCalls } = createEnv();
    const res = await handleNexusRoute(authed(path, method), env, "req_1", path);
    expect(res.status).toBe(405);
    expect(nexusCalls).toHaveLength(0);
  });

  it("accepts every verb the alert contact supports", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const { env, nexusCalls } = createEnv();
      const path = `${BASE}/nexus/alert-contact`;
      const body = method === "PUT" ? JSON.stringify({ email: "a@b.co" }) : undefined;
      const res = await handleNexusRoute(authed(path, method, body), env, "req_1", path);
      expect(res.status).toBe(200);
      expect(nexusCalls).toHaveLength(1);
    }
  });
});

describe("downstream routing — two workers behind one facade", () => {
  it("sends nexus routes to NEXUS_WORKER", async () => {
    const { env, nexusCalls, channelCalls } = createEnv();
    const path = `${BASE}/nexus/exposure`;
    await handleNexusRoute(authed(path), env, "req_1", path);
    expect(nexusCalls).toHaveLength(1);
    expect(channelCalls).toHaveLength(0);
    expect(new URL(nexusCalls[0]!.url).host).toBe("nexus.internal");
  });

  it("sends channel routes to CHANNELS_WORKER", async () => {
    const { env, nexusCalls, channelCalls } = createEnv();
    const path = `${BASE}/channels`;
    await handleNexusRoute(authed(path), env, "req_1", path);
    expect(channelCalls).toHaveLength(1);
    expect(nexusCalls).toHaveLength(0);
    expect(new URL(channelCalls[0]!.url).host).toBe("channels.internal");
  });

  it("routes /channels/connect to channels, not to a channel whose id is 'connect'", async () => {
    const { env, channelCalls } = createEnv();
    const path = `${BASE}/channels/connect`;
    const res = await handleNexusRoute(
      authed(path, "POST", JSON.stringify({ provider: "stripe", redirectUri: "https://x.test" })),
      env,
      "req_1",
      path,
    );
    // A channel id would only accept DELETE. Reaching the worker at all with
    // POST proves the literal sub-path won the match.
    expect(res.status).toBe(200);
    expect(new URL(channelCalls[0]!.url).pathname).toBe(path);
  });

  it("preserves the query string on the way down", async () => {
    const { env, nexusCalls } = createEnv();
    const path = `${BASE}/ledger`;
    await handleNexusRoute(
      new Request(`https://edge.test${path}?jurisdiction=US-TX&limit=25`, {
        headers: { authorization: "Bearer tok_123" },
      }),
      env,
      "req_1",
      path,
    );
    const target = new URL(nexusCalls[0]!.url);
    expect(target.searchParams.get("jurisdiction")).toBe("US-TX");
    expect(target.searchParams.get("limit")).toBe("25");
  });

  it("pins the actor headers from the resolved session, not from the request", async () => {
    const { env, nexusCalls } = createEnv();
    const path = `${BASE}/nexus/exposure`;
    await handleNexusRoute(
      new Request(`https://edge.test${path}`, {
        headers: {
          authorization: "Bearer tok_123",
          // A client trying to name itself. The facade builds a fresh Headers
          // and only copies from a fixed allow-list, so this cannot survive.
          "x-actor-subject-id": "usr_attacker",
          "x-actor-subject-type": "system",
        },
      }),
      env,
      "req_1",
      path,
    );
    const headers = new Headers(nexusCalls[0]!.init.headers);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123");
    expect(headers.get("x-actor-subject-type")).toBe("user");
  });

  it("401s without a bearer token, before any downstream call", async () => {
    const { env, nexusCalls, channelCalls } = createEnv();
    const path = `${BASE}/nexus/exposure`;
    const res = await handleNexusRoute(
      new Request(`https://edge.test${path}`),
      env,
      "req_1",
      path,
    );
    expect(res.status).toBe(401);
    expect(nexusCalls).toHaveLength(0);
    expect(channelCalls).toHaveLength(0);
  });

  it("503s rather than 500s when the downstream binding is absent", async () => {
    const { env } = createEnv();
    const path = `${BASE}/nexus/exposure`;
    const res = await handleNexusRoute(
      authed(path),
      { ...(env as object), NEXUS_WORKER: undefined } as never,
      "req_1",
      path,
    );
    expect(res.status).toBe(503);
  });
});

describe("the provider webhook ingress — the only new trust path in the epic", () => {
  const WEBHOOK = "/v1/channels/shopify/webhook";

  it("is matched as ingress and NOT as an authenticated nexus route", () => {
    expect(isChannelIngressRoute(WEBHOOK)).toBe(true);
    // If it were also a nexus route, dispatch order alone would decide whether
    // a signed webhook got asked for a session it does not have.
    expect(isNexusRoute(WEBHOOK)).toBe(false);
  });

  it("matches only the exact webhook shape", () => {
    expect(isChannelIngressRoute("/v1/channels/stripe/webhook")).toBe(true);
    expect(isChannelIngressRoute("/v1/channels/stripe/webhook/extra")).toBe(false);
    expect(isChannelIngressRoute("/v1/channels/webhook")).toBe(false);
    expect(isChannelIngressRoute(`${BASE}/channels`)).toBe(false);
  });

  it("forwards without consulting identity — a signature is not a session", async () => {
    const { env, channelCalls } = createEnv();
    const identityCalls: string[] = [];
    const watched = {
      ...(env as object),
      IDENTITY_WORKER: {
        fetch(input: string | Request | URL) {
          identityCalls.push(String(input));
          return Promise.resolve(Response.json({ data: {} }));
        },
        connect() {
          throw new Error("not implemented");
        },
      },
    } as never;

    const res = await handleChannelIngressRoute(
      new Request(`https://edge.test${WEBHOOK}`, {
        method: "POST",
        headers: { "shopify-hmac-sha256": "sig" },
        body: '{"id":1}',
      }),
      watched,
      "req_1",
      WEBHOOK,
    );

    expect(res.status).toBe(200);
    expect(identityCalls).toEqual([]);
    expect(channelCalls).toHaveLength(1);
  });

  it("forwards the provider's own signature header untouched", async () => {
    const { env, channelCalls } = createEnv();
    await handleChannelIngressRoute(
      new Request(`https://edge.test${WEBHOOK}`, {
        method: "POST",
        headers: { "shopify-hmac-sha256": "abc123" },
        body: '{"id":1}',
      }),
      env,
      "req_1",
      WEBHOOK,
    );
    const headers = new Headers(channelCalls[0]!.init.headers);
    expect(headers.get("shopify-hmac-sha256")).toBe("abc123");
  });

  it("405s a non-POST rather than forwarding it", async () => {
    const { env, channelCalls } = createEnv();
    const res = await handleChannelIngressRoute(
      new Request(`https://edge.test${WEBHOOK}`),
      env,
      "req_1",
      WEBHOOK,
    );
    expect(res.status).toBe(405);
    expect(channelCalls).toHaveLength(0);
  });

  it("503s when channels-worker is unbound", async () => {
    const { env } = createEnv();
    const res = await handleChannelIngressRoute(
      new Request(`https://edge.test${WEBHOOK}`, { method: "POST", body: "{}" }),
      { ...(env as object), CHANNELS_WORKER: undefined } as never,
      "req_1",
      WEBHOOK,
    );
    expect(res.status).toBe(503);
  });
});
