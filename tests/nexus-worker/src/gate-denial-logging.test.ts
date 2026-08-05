// Deny-as-404 is right for the response and was wrong for the record.
//
// Every authorization failure on a nexus surface returns an identical 404 —
// deliberately, so a denial is not a membership oracle (design §7.1). The cost
// is that the three underlying causes are indistinguishable, and until the gate
// logged anything they were indistinguishable to the *operator* too. A board
// that 404s for every user of an organization looked exactly like one seller
// missing a role, and neither left a trace.
//
// That is design §12's "silent failure mode" in its purest form, and it stayed
// silent until it had to be debugged from a screenshot of a red `not_found`.
//
// So: the reason is written down and never returned. This file pins both
// halves — the log tells an operator which remedy applies, and the response
// still tells the caller nothing.

import { requireOrgAction } from "@nexus-worker/handlers/gate";
import type { Env } from "@nexus-worker/env";
import { asUuid } from "@saas/db/ids";

const ORG_UUID = "11111111-1111-1111-1111-111111111111";
const ORG_PUBLIC = "org_11111111111111111111111111111111";
const ACTOR = { subjectId: "usr_abc", subjectType: "user" };

/** Membership worker that returns the given role, or fails outright. */
function membershipStub(role: string | null, fail = false): Fetcher {
  return {
    async fetch(): Promise<Response> {
      if (fail) return new Response("upstream down", { status: 503 });
      if (!role) return Response.json({ data: { memberships: [] } });
      return Response.json({
        data: {
          memberships: [
            { kind: "role_assignment", role, scope: { kind: "organization", orgId: ORG_UUID } },
          ],
        },
      });
    },
  } as unknown as Fetcher;
}

function policyStub(allow: boolean): Fetcher {
  return {
    async fetch(): Promise<Response> {
      return Response.json({ data: { allow, reason: allow ? "owner" : "no_matching_role" } });
    },
  } as unknown as Fetcher;
}

function envWith(membership: Fetcher, policy: Fetcher): Env {
  return {
    PLATFORM_DB: {} as Hyperdrive,
    MEMBERSHIP_WORKER: membership,
    POLICY_WORKER: policy,
    ENVIRONMENT: "test",
  };
}

/** Capture the structured warn lines the gate emits. */
function captureWarnings(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      /* not one of ours */
    }
  };
  return { lines, restore: () => { console.warn = original; } };
}

describe("the gate records why it denied", () => {
  let cap: ReturnType<typeof captureWarnings>;
  beforeEach(() => { cap = captureWarnings(); });
  afterEach(() => { cap.restore(); });

  it("logs policy_denied when the role is genuinely too narrow", async () => {
    const result = await requireOrgAction(
      envWith(membershipStub("viewer"), policyStub(false)),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      "organization.nexus.evaluate",
    );
    expect(result.ok).toBe(false);
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({
      msg: "nexus.authz_denied",
      reason: "policy_denied",
      action: "organization.nexus.evaluate",
      orgId: ORG_PUBLIC,
      requestId: "req_1",
    });
  });

  it("logs membership_unavailable when the membership lookup yields nothing usable", async () => {
    const result = await requireOrgAction(
      envWith(membershipStub(null, true), policyStub(true)),
      "req_2",
      ACTOR,
      asUuid(ORG_UUID),
      "organization.nexus.read",
    );
    expect(result.ok).toBe(false);
    expect(cap.lines[0]).toMatchObject({ reason: "membership_unavailable" });
  });

  // The distinction is the whole point: it says whether to look at the role
  // assignment or at the policy matrix.
  it("distinguishes the two reasons a screenshot cannot", async () => {
    await requireOrgAction(
      envWith(membershipStub(null, true), policyStub(true)),
      "req_a", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    await requireOrgAction(
      envWith(membershipStub("viewer"), policyStub(false)),
      "req_b", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    expect(cap.lines.map((l) => l.reason)).toEqual(["membership_unavailable", "policy_denied"]);
  });

  it("logs the org as a public id, never a raw UUID", async () => {
    await requireOrgAction(
      envWith(membershipStub("viewer"), policyStub(false)),
      "req_3", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    expect(cap.lines[0]!.orgId).toBe(ORG_PUBLIC);
    expect(JSON.stringify(cap.lines[0])).not.toContain(ORG_UUID);
  });

  it("logs ids and an enum only — no membership facts, no payload", async () => {
    await requireOrgAction(
      envWith(membershipStub("viewer"), policyStub(false)),
      "req_4", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    expect(Object.keys(cap.lines[0]!).sort()).toEqual(
      ["action", "level", "msg", "orgId", "reason", "requestId", "subjectId", "subjectType"].sort(),
    );
  });

  it("says nothing at all when the request is allowed", async () => {
    const result = await requireOrgAction(
      envWith(membershipStub("owner"), policyStub(true)),
      "req_5",
      ACTOR,
      asUuid(ORG_UUID),
      "organization.nexus.read",
    );
    expect(result.ok).toBe(true);
    expect(cap.lines).toHaveLength(0);
  });
});

describe("the response still tells the caller nothing", () => {
  let cap: ReturnType<typeof captureWarnings>;
  beforeEach(() => { cap = captureWarnings(); });
  afterEach(() => { cap.restore(); });

  it("returns a byte-identical 404 for both reasons", async () => {
    const denied = await requireOrgAction(
      envWith(membershipStub("viewer"), policyStub(false)),
      "req_x", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    const missing = await requireOrgAction(
      envWith(membershipStub(null, true), policyStub(true)),
      "req_x", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    expect(denied.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (denied.ok || missing.ok) throw new Error("unreachable");

    expect(denied.response.status).toBe(404);
    expect(missing.response.status).toBe(404);
    // Same body, so the reason cannot be inferred from the wire.
    expect(await denied.response.text()).toBe(await missing.response.text());
  });

  it("never leaks the reason enum into the response", async () => {
    const denied = await requireOrgAction(
      envWith(membershipStub("viewer"), policyStub(false)),
      "req_y", ACTOR, asUuid(ORG_UUID), "organization.nexus.read",
    );
    if (denied.ok) throw new Error("unreachable");
    const body = await denied.response.text();
    expect(body).not.toContain("policy_denied");
    expect(body).not.toContain("membership_unavailable");
  });
});
