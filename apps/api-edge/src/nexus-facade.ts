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
];

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
    if (!env.NEXUS_WORKER) {
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
    const target = new URL(pathname + url.search, "https://nexus.internal");

    const init: RequestInit = { method: request.method, headers };
    if (request.method === "POST" || request.method === "PUT") {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.NEXUS_WORKER!.fetch(target.toString(), init),
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
