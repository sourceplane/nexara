// The internal usage-recording seam (`POST /v1/internal/metering/usage`).
//
// This route deliberately does NOT resolve an actor, because its callers are a
// scheduled job and a webhook drain that have no session to resolve one from.
// Dropping an authorization check is the kind of change that deserves tests
// asserting exactly what replaced it, so this file pins:
//
//   - the service-binding allow-list, failing CLOSED on absent/unknown/
//     malformed callers, and before any repository access;
//   - that no actor headers are required (the point of the seam) and that
//     supplying attacker-controlled ones changes nothing;
//   - the validation the public path also applies, since a malformed metric
//     from a cron is exactly as wrong as one from a user;
//   - that the route path is not org-scoped, so the api-edge metering facade's
//     `/v1/organizations/…` patterns cannot match it (asserted from the edge's
//     own side in `tests/api-edge/src/metering-internal-seam.test.ts`, which is
//     where that alias lives).

import { route } from "@metering-worker/router";
import type { Env } from "@metering-worker/env";
import { isAllowedInternalCaller } from "@metering-worker/internal-callers";

const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const PATH = "http://metering-worker/v1/internal/metering/usage";

/**
 * An Env with NO membership or policy binding at all. If the handler ever
 * regains an authorization path it will fail loudly here rather than quietly
 * authorizing against a stub that happens to say yes.
 */
function envWithoutAuthBindings(overrides?: Partial<Record<string, unknown>>): Env {
  const base: Record<string, unknown> = {
    PLATFORM_DB: { connectionString: "postgres://fake" },
    ENVIRONMENT: "test",
  };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as Env;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const AS_CRON = { "x-internal-caller": "nexus-worker" };

const VALID_BODY = {
  orgId: TEST_ORG_PUBLIC,
  metric: "jurisdictions_monitored",
  quantity: 12,
  idempotencyKey: "nexus:org_1:jurisdictions_monitored:2026-08-05T11",
};

describe("internal-caller allow-list", () => {
  it("accepts only the two bound nexus callers", () => {
    expect(isAllowedInternalCaller("nexus-worker")).toBe(true);
    expect(isAllowedInternalCaller("channels-worker")).toBe(true);
  });

  it("rejects absent, unknown, and malformed callers", () => {
    expect(isAllowedInternalCaller(null)).toBe(false);
    expect(isAllowedInternalCaller("")).toBe(false);
    expect(isAllowedInternalCaller("api-edge")).toBe(false); // allowed by billing, not here
    expect(isAllowedInternalCaller("Nexus-Worker")).toBe(false); // case matters
    expect(isAllowedInternalCaller("nexus-worker ")).toBe(false);
    expect(isAllowedInternalCaller("*")).toBe(false);
    expect(isAllowedInternalCaller("../nexus-worker")).toBe(false);
  });
});

describe("POST /v1/internal/metering/usage — provenance", () => {
  it("403s with no internal-caller header, before touching the database", async () => {
    // PLATFORM_DB absent: if the gate ran after repository access this would
    // surface as a 503 misconfiguration instead of a 403.
    const res = await route(post(VALID_BODY), envWithoutAuthBindings({ PLATFORM_DB: undefined }));
    expect(res.status).toBe(403);
  });

  it("403s for an unknown caller", async () => {
    const res = await route(post(VALID_BODY, { "x-internal-caller": "web-console" }), envWithoutAuthBindings());
    expect(res.status).toBe(403);
  });

  it("405s a non-POST even for an allowed caller", async () => {
    const res = await route(
      new Request(PATH, { method: "GET", headers: AS_CRON }),
      envWithoutAuthBindings(),
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/internal/metering/usage — no actor required", () => {
  it("gets past authorization with no actor headers and no membership/policy bindings", async () => {
    const res = await route(post(VALID_BODY, AS_CRON), envWithoutAuthBindings());
    // Not 401/403: the seam authorizes on provenance, not identity. It fails
    // later on the fake DB, which is past the point this test is about.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("ignores caller-supplied actor headers entirely", async () => {
    // A forged actor must not be able to widen anything, because nothing here
    // reads one. Same outcome as the call without them.
    const withActor = await route(
      post(VALID_BODY, { ...AS_CRON, "x-actor-subject-id": "usr_attacker", "x-actor-subject-type": "user" }),
      envWithoutAuthBindings(),
    );
    const without = await route(post(VALID_BODY, AS_CRON), envWithoutAuthBindings());
    expect(withActor.status).toBe(without.status);
  });
});

describe("POST /v1/internal/metering/usage — validation", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["missing orgId", { ...VALID_BODY, orgId: undefined }],
    ["a raw UUID instead of the public id", { ...VALID_BODY, orgId: "11111111-1111-1111-1111-111111111111" }],
    ["a project id in the org field", { ...VALID_BODY, orgId: "prj_11111111111111111111111111111111" }],
    ["missing metric", { ...VALID_BODY, metric: undefined }],
    ["a non-snake_case metric", { ...VALID_BODY, metric: "Jurisdictions-Monitored" }],
    ["missing idempotencyKey", { ...VALID_BODY, idempotencyKey: undefined }],
    ["a negative quantity", { ...VALID_BODY, quantity: -1 }],
    ["a non-finite quantity", { ...VALID_BODY, quantity: Number.POSITIVE_INFINITY }],
    ["an unparseable recordedAt", { ...VALID_BODY, recordedAt: "last tuesday" }],
  ];

  for (const [label, body] of cases) {
    it(`rejects ${label}`, async () => {
      const res = await route(post(body, AS_CRON), envWithoutAuthBindings());
      expect(res.status).toBe(400);
    });
  }

  it("rejects a negative quantity specifically — it would silently shrink a rollup", async () => {
    const res = await route(post({ ...VALID_BODY, quantity: -5 }, AS_CRON), envWithoutAuthBindings());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(JSON.stringify(body)).toContain("non-negative");
  });

  it("accepts quantity 0 — a seller monitoring nothing this hour is a real fact", async () => {
    const res = await route(post({ ...VALID_BODY, quantity: 0 }, AS_CRON), envWithoutAuthBindings());
    expect(res.status).not.toBe(400);
  });
});
