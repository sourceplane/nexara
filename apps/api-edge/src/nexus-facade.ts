// Edge facade for `nexus-worker`.
//
// Registered in the dispatch chain **before** `isOrgRoute`, because every
// route here lives under `/v1/organizations/:orgId/…` and the org facade's
// pattern would otherwise swallow them. That ordering is load-bearing and it
// is asserted by a test rather than by a comment alone.

import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const EXPOSURE_RE = /^\/v1\/organizations\/[^/]+\/nexus\/exposure$/;
const JURISDICTION_RE = /^\/v1\/organizations\/[^/]+\/nexus\/jurisdictions\/[^/]+$/;
const EVALUATE_RE = /^\/v1\/organizations\/[^/]+\/nexus\/evaluate$/;
const LEDGER_RE = /^\/v1\/organizations\/[^/]+\/ledger$/;
const LEDGER_IMPORT_RE = /^\/v1\/organizations\/[^/]+\/ledger\/import$/;
const REGISTRATIONS_RE = /^\/v1\/organizations\/[^/]+\/registrations$/;
const CHANNELS_RE = /^\/v1\/organizations\/[^/]+\/channels$/;
const CHANNEL_ID_RE = /^\/v1\/organizations\/[^/]+\/channels\/[^/]+$/;
const CHANNEL_CONNECT_RE = /^\/v1\/organizations\/[^/]+\/channels\/connect(\/complete)?$/;
const CHANNEL_DELIVERIES_RE = /^\/v1\/organizations\/[^/]+\/channels\/deliveries$/;

/** The signature-verified provider ingress. No session; see below. */
const CHANNEL_WEBHOOK_RE = /^\/v1\/channels\/[^/]+\/webhook$/;

const FORWARDED_HEADERS = [
  "content-type",
  "x-request-id",
  "traceparent",
  "idempotency-key",
];

/** Method allow-list per route, so a wrong verb is a 405 at the edge rather
 *  than a 404 from the worker's router. */
const ROUTES: Array<{ re: RegExp; methods: ReadonlySet<string> }> = [
  { re: EXPOSURE_RE, methods: new Set(["GET"]) },
  { re: JURISDICTION_RE, methods: new Set(["GET"]) },
  { re: EVALUATE_RE, methods: new Set(["POST"]) },
  { re: LEDGER_IMPORT_RE, methods: new Set(["POST"]) },
  { re: LEDGER_RE, methods: new Set(["GET"]) },
  { re: REGISTRATIONS_RE, methods: new Set(["GET", "PUT"]) },
  // Order matters: the literal sub-paths before CHANNEL_ID_RE, or
  // `/channels/connect` is read as a channel whose id is "connect".
  { re: CHANNEL_CONNECT_RE, methods: new Set(["POST"]) },
  { re: CHANNEL_DELIVERIES_RE, methods: new Set(["GET"]) },
  { re: CHANNELS_RE, methods: new Set(["GET", "POST"]) },
  { re: CHANNEL_ID_RE, methods: new Set(["DELETE"]) },
];

/** Routes served by `channels-worker` rather than `nexus-worker`. */
const CHANNEL_ROUTES = [
  CHANNEL_CONNECT_RE, CHANNEL_DELIVERIES_RE, CHANNELS_RE, CHANNEL_ID_RE,
];

function isChannelRoute(pathname: string): boolean {
  return CHANNEL_ROUTES.some((re) => re.test(pathname));
}

/**
 * The provider webhook ingress.
 *
 * Matched **before** the authenticated facade and dispatched without
 * `resolveActor`: provider webhooks carry a signature, not a session, and
 * `verifyInboundSignature` in `channels-worker` is the gate. This is the only
 * new trust path in the epic.
 */
export function isChannelIngressRoute(pathname: string): boolean {
  return CHANNEL_WEBHOOK_RE.test(pathname);
}

export async function handleChannelIngressRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  if (!env.CHANNELS_WORKER) {
    return errorResponse("internal_error", "Channels service unavailable", 503, requestId);
  }

  // The raw body is forwarded untouched. Every provider signs the bytes as
  // sent, and any re-serialisation here would break every signature for
  // reasons that look like a key problem.
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  try {
    const target = new URL(pathname, "https://channels.internal");
    const downstream = await env.CHANNELS_WORKER.fetch(target.toString(), {
      method: "POST",
      headers,
      body: request.body,
    });
    return new Response(downstream.body, {
      status: downstream.status,
      headers: downstream.headers,
    });
  } catch {
    return errorResponse("internal_error", "Channels service unavailable", 503, requestId);
  }
}

export function isNexusRoute(pathname: string): boolean {
  return ROUTES.some((r) => r.re.test(pathname));
}

export async function handleNexusRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const matched = ROUTES.find((r) => r.re.test(pathname));
  if (matched && !matched.methods.has(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  // "nexus" is its own idempotency namespace. Sharing one with `project` would
  // let a caller's `Idempotency-Key` collide across two unrelated resources
  // and replay the wrong stored response.
  return replayOrExecute(request, requestId, env, "nexus", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    const downstreamBinding = isChannelRoute(pathname) ? env.CHANNELS_WORKER : env.NEXUS_WORKER;
    if (!downstreamBinding) {
      return errorResponse("internal_error", "Nexus service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () =>
      resolveActor(request, env, requestId),
    );
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(
      pathname + url.search,
      isChannelRoute(pathname) ? "https://channels.internal" : "https://nexus.internal",
    );

    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST" || request.method === "PUT") {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        downstreamBinding.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.nexus", timings);
    } catch {
      return errorResponse("internal_error", "Nexus service unavailable", 503, requestId);
    }
  });
}
