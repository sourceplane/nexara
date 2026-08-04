// The nexus support view — behaviour, and the read-only guarantee.
//
// The acceptance criterion for NX8 is that the support view "renders a foreign
// tenant's determination history and exposes no mutation, **asserted by a test
// rather than by inspection**". The last block in this file is that assertion:
// it reads the handler and router sources and fails if a write ever appears on
// this surface. Everything above it is the behaviour that makes the surface
// worth having.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { handleNexusSupportView } from "@admin-worker/handlers/nexus-support";
import type { NexusSupportDeps } from "@admin-worker/handlers/nexus-support";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const ORG_UUID = "7c82f1a0-1111-4222-8333-444455556666";
const ORG_PUBLIC = "org_7c82f1a0111142228333444455556666";
const OTHER_ORG_UUID = "9d93e2b1-2222-4333-8444-555566667777";

const env = { PLATFORM_DB: undefined } as never;

function determination(over: Record<string, unknown> = {}) {
  return {
    id: "det-1",
    orgId: ORG_UUID,
    jurisdiction: "US-TX",
    evaluatedAt: new Date("2026-08-04T00:00:00Z"),
    ruleSetVersion: "2026.08.01",
    ruleId: "rule-1",
    engineVersion: "1.0.0",
    periodStart: new Date("2025-08-05T00:00:00Z"),
    periodEnd: new Date("2026-08-05T00:00:00Z"),
    measuredSalesCents: 512_300_00,
    measuredTransactions: 1_204,
    thresholdSalesCents: 500_000_00,
    thresholdTransactions: null,
    status: "crossed",
    crossedOn: "2026-07-30",
    registrationDueOn: "2026-09-01",
    inputs: { asOf: "2026-08-04T00:00:00Z", approachingFraction: 0.8 },
    internalOnly: false,
    ...over,
  };
}

function channel(over: Record<string, unknown> = {}) {
  return {
    id: "chan-1",
    orgId: ORG_UUID,
    provider: "shopify",
    externalAccountId: "acme.myshopify.com",
    displayName: "Acme",
    status: "connected",
    credentialsRef: "secret://provider/shopify/chan-1",
    backfillStartedAt: new Date("2026-07-01T00:00:00Z"),
    backfillCompletedAt: new Date("2026-07-02T00:00:00Z"),
    backfillCursor: null,
    lookbackFloor: "2023-07-01",
    lastEventAt: new Date("2026-08-03T00:00:00Z"),
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-08-03T00:00:00Z"),
    revokedAt: null,
    ...over,
  };
}

function delivery(over: Record<string, unknown> = {}) {
  return {
    id: "dlv-1",
    orgId: ORG_UUID,
    channelId: "chan-1",
    provider: "shopify",
    providerDeliveryId: "wh_1",
    payload: { customer: { name: "Jane Doe", address: "1 Main St" } },
    signatureVerified: true,
    status: "applied",
    attempts: 1,
    nextAttemptAt: null,
    lastError: null,
    receivedAt: new Date("2026-08-03T00:00:00Z"),
    appliedAt: new Date("2026-08-03T00:00:01Z"),
    purgedAt: null,
    ...over,
  };
}

interface Calls {
  determinationOrgIds: string[];
  channelOrgIds: string[];
  deliveryOrgIds: string[];
  registrationOrgIds: string[];
}

function makeDeps(
  over: {
    determinations?: ReturnType<typeof determination>[];
    channels?: ReturnType<typeof channel>[];
    deliveries?: ReturnType<typeof delivery>[];
  } = {},
): { deps: NexusSupportDeps; calls: Calls } {
  const calls: Calls = {
    determinationOrgIds: [],
    channelOrgIds: [],
    deliveryOrgIds: [],
    registrationOrgIds: [],
  };
  const deps = {
    nexusRepo: {
      listDeterminationsPaged: async (orgId: string) => {
        calls.determinationOrgIds.push(orgId);
        return {
          ok: true as const,
          value: { items: over.determinations ?? [determination()], nextCursor: null },
        };
      },
      listRegistrations: async (orgId: string) => {
        calls.registrationOrgIds.push(orgId);
        return {
          ok: true as const,
          value: [
            {
              id: "reg-1",
              orgId,
              jurisdiction: "US-TX",
              status: "active",
              registeredOn: "2026-08-01",
              permitRef: "TX-123",
              notes: null,
              createdAt: new Date("2026-08-01T00:00:00Z"),
              updatedAt: new Date("2026-08-01T00:00:00Z"),
            },
          ],
        };
      },
    },
    channelsRepo: {
      listChannels: async (orgId: string) => {
        calls.channelOrgIds.push(orgId);
        return { ok: true as const, value: over.channels ?? [channel()] };
      },
      listDeliveries: async (orgId: string) => {
        calls.deliveryOrgIds.push(orgId);
        return { ok: true as const, value: over.deliveries ?? [delivery()] };
      },
    },
    eventsRepo: { appendEventWithAudit: async () => ({ ok: true as const, value: undefined }) },
    now: () => new Date("2026-08-04T12:00:00Z"),
    generateId: () => "00000000-0000-4000-8000-000000000001",
  } as unknown as NexusSupportDeps;
  return { deps, calls };
}

const agent = { actor: { subjectId: "usr-1", subjectType: "user" }, supportRoleClaim: "support_agent", systemOverride: false };
const anonymous = { actor: null, supportRoleClaim: null, systemOverride: false };
const roleless = { actor: { subjectId: "usr-2", subjectType: "user" }, supportRoleClaim: null, systemOverride: false };

async function body(res: Response): Promise<Record<string, never>> {
  return (await res.json()) as Record<string, never>;
}

describe("nexus support view — authorization", () => {
  it("denies a caller with no actor", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", anonymous, ORG_PUBLIC, undefined, deps);
    expect(res.status).toBe(403);
  });

  it("denies an authenticated caller with no support role — deny by default", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", roleless, ORG_PUBLIC, undefined, deps);
    expect(res.status).toBe(403);
    // The denial happens BEFORE any read. A 403 that still touched the
    // database has already leaked timing about whether the org exists.
    expect(calls.determinationOrgIds).toEqual([]);
    expect(calls.channelOrgIds).toEqual([]);
  });

  it("allows a recognised support role", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    expect(res.status).toBe(200);
  });

  it("rejects a malformed org id as not-found, not as a validation error", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", agent, "not-an-org", undefined, deps);
    expect(res.status).toBe(404);
  });
});

describe("nexus support view — a foreign tenant's history", () => {
  it("renders determinations for the target org with the reproducibility triple intact", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    const json = await body(res);
    const dets = (json as unknown as { data: { determinations: Record<string, unknown>[] } }).data
      .determinations;
    expect(dets).toHaveLength(1);
    expect(dets[0]).toMatchObject({
      jurisdiction: "US-TX",
      ruleSetVersion: "2026.08.01",
      ruleId: "rule-1",
      engineVersion: "1.0.0",
      status: "crossed",
    });
  });

  it("includes the stored inputs verbatim, so support sees what the merchant saw", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    const json = (await res.json()) as { data: { determinations: { inputs: unknown }[] } };
    expect(json.data.determinations[0]!.inputs).toEqual({
      asOf: "2026-08-04T00:00:00Z",
      approachingFraction: 0.8,
    });
  });

  it("scopes every read to exactly one org — support reads a foreign tenant, never across tenants", async () => {
    const { deps, calls } = makeDeps();
    await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    for (const list of [
      calls.determinationOrgIds,
      calls.channelOrgIds,
      calls.deliveryOrgIds,
      calls.registrationOrgIds,
    ]) {
      expect(list).toEqual([ORG_UUID]);
      expect(list).not.toContain(OTHER_ORG_UUID);
    }
  });

  it("shows the channel and backfill state", async () => {
    const { deps } = makeDeps({
      channels: [channel({ status: "backfilling", backfillCompletedAt: null })],
    });
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    const json = (await res.json()) as { data: { channels: Record<string, unknown>[] } };
    expect(json.data.channels[0]).toMatchObject({
      status: "backfilling",
      backfillCompletedAt: null,
      lookbackFloor: "2023-07-01",
    });
  });

  it("never returns a credentials pointer", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    expect(await res.text()).not.toContain("credentialsRef");
  });

  it("puts failed deliveries first — the reason a ticket exists is usually there", async () => {
    const { deps } = makeDeps({
      deliveries: [
        delivery({ id: "dlv-ok", status: "applied" }),
        delivery({ id: "dlv-bad", status: "failed", attempts: 5, lastError: "append_failed_internal" }),
      ],
    });
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    const json = (await res.json()) as { data: { deliveries: { id: string }[] } };
    expect(json.data.deliveries.map((d) => d.id)).toEqual(["dlv-bad", "dlv-ok"]);
  });

  // The retention policy of Q6 is worthless if a support surface hands the
  // bytes out. This asserts the projection drops them, with a payload that
  // carries a recognisable name in it.
  it("never returns a delivery payload", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(env, "req-1", agent, ORG_PUBLIC, undefined, deps);
    const text = await res.text();
    expect(text).not.toContain("Jane Doe");
    expect(text).not.toContain("1 Main St");
    expect(text).not.toContain('"payload"');
    // But it does say whether the payload is gone — that is the answer to
    // "can you look at what the provider actually sent me?".
    expect(text).toContain("payloadPurged");
  });
});

describe("nexus support view — bounds", () => {
  it("rejects an out-of-range limit rather than scanning unbounded", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(
      env,
      "req-1",
      agent,
      ORG_PUBLIC,
      new URL("https://internal/x?limit=5000"),
      deps,
    );
    expect(res.status).toBe(422);
  });

  it("rejects a malformed jurisdiction filter", async () => {
    const { deps } = makeDeps();
    const res = await handleNexusSupportView(
      env,
      "req-1",
      agent,
      ORG_PUBLIC,
      new URL("https://internal/x?jurisdiction=DROP%20TABLE"),
      deps,
    );
    expect(res.status).toBe(422);
  });
});

// ── The read-only guarantee, asserted rather than inspected ──

describe("the support view exposes no mutation", () => {
  const handlerSrc = readFileSync(
    resolve(REPO_ROOT, "apps/admin-worker/src/handlers/nexus-support.ts"),
    "utf8",
  );
  const routerSrc = readFileSync(resolve(REPO_ROOT, "apps/admin-worker/src/router.ts"), "utf8");

  /** Strip comments so prose describing a write is not mistaken for one. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  const handlerCode = stripComments(handlerSrc);

  it("depends on no repository method that writes", () => {
    // The handler's declared dependency surface is a `Pick<>` of exactly the
    // read methods. A mutation could only arrive by widening it, and widening
    // it fails here.
    expect(handlerCode).toContain(
      'Pick<NexusRepository, "listDeterminationsPaged" | "listRegistrations">',
    );
    expect(handlerCode).toContain('Pick<ChannelsRepository, "listChannels" | "listDeliveries">');
  });

  it("calls no writing repository method", () => {
    const writers = [
      "appendSaleEvents",
      "insertDetermination",
      "upsertRegistration",
      "insertAlertOnce",
      "createChannel",
      "revokeChannel",
      "advanceBackfill",
      "markDeliveryApplied",
      "receiveDelivery",
      "claimDueDeliveries",
      "purgeExpiredPayloads",
      "setWatermark",
    ];
    for (const w of writers) {
      // Word-bounded: `createChannelsRepository` is a factory, not a write,
      // and a substring match would flag it.
      expect(handlerCode).not.toMatch(new RegExp(`\\b${w}\\b`));
    }
  });

  it("issues no SQL of its own", () => {
    // Belt and braces with the db tenancy scan, which already forbids
    // nexus./channels. SQL outside the repository modules.
    expect(handlerCode).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i);
  });

  it("is routed on GET only", () => {
    const route = stripComments(routerSrc)
      .split("\n")
      .findIndex((l) => l.includes("NEXUS_SUPPORT_RE.exec"));
    expect(route).toBeGreaterThan(-1);
    const nearby = stripComments(routerSrc).split("\n").slice(route - 1, route + 4).join("\n");
    expect(nearby).toContain('method === "GET"');
    for (const verb of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(nearby).not.toContain(`method === "${verb}"`);
    }
  });

  it("exports exactly one handler, and it is the read", () => {
    const exported = [...handlerCode.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
    expect(exported).toEqual(["handleNexusSupportView"]);
  });

  // A guard that cannot fail is not a guard: prove the checks above would
  // catch a real regression rather than passing on any input.
  it("would catch a mutation if one were added", () => {
    const mutated = handlerCode.replace(
      "channelsRepo.listChannels(targetOrgUuid)",
      "channelsRepo.revokeChannel(targetOrgUuid, id, now)",
    );
    expect(mutated).not.toBe(handlerCode);
    expect(mutated).toContain("revokeChannel");

    const withSql = `${handlerCode}\nconst q = "UPDATE nexus.determinations SET status = $1";`;
    expect(withSql).toMatch(/\bUPDATE\b/i);
  });
});
