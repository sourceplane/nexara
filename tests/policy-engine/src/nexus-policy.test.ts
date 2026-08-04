// NX1 — the nine nexus/channels RBAC actions of design §7.2.
//
// Two things are asserted here that are easy to get half-right:
//
//   1. Every action is in the flat validation Set as well as the per-role
//      arrays. An action missing from `ALL_KNOWN_ACTIONS` is denied with
//      `unknown_action` no matter which role asks, and because the platform
//      convention is deny-as-404 the symptom is a 404 that looks like a
//      routing bug. That failure mode is why this test exists.
//   2. Connecting and revoking a payment-processor account is an owner/admin
//      act. A `builder` runs the product; they do not attach the money.

import {
  authorize,
  listEffectivePermissions,
} from "@saas/policy-engine";
import type {
  AuthorizationRequest,
  MembershipFact,
  OrganizationRole,
  PolicySubject,
} from "@saas/contracts/policy";

const subject: PolicySubject = { type: "user", id: "usr_1" };
const ORG = "org_1";

function orgFact(role: OrganizationRole): MembershipFact {
  return {
    kind: "role_assignment",
    role,
    scope: { kind: "organization", orgId: ORG },
  } as MembershipFact;
}

function ask(role: OrganizationRole, action: string): boolean {
  const input: AuthorizationRequest = {
    subject,
    action,
    resource: { kind: "organization", orgId: ORG },
    context: { memberships: [orgFact(role)] },
  };
  return authorize(input).allow;
}

const NEXUS_ACTIONS = [
  "organization.nexus.read",
  "organization.nexus.evaluate",
  "organization.ledger.read",
  "organization.ledger.import",
  "organization.channel.read",
  "organization.channel.connect",
  "organization.channel.revoke",
  "organization.registration.read",
  "organization.registration.write",
] as const;

// design §7.2, transcribed. If this table and the doc disagree, one of them
// is a bug and the disagreement is the finding.
const MATRIX: Record<
  (typeof NEXUS_ACTIONS)[number],
  Record<"owner" | "admin" | "builder" | "viewer", boolean>
> = {
  "organization.nexus.read": { owner: true, admin: true, builder: true, viewer: true },
  "organization.nexus.evaluate": { owner: true, admin: true, builder: true, viewer: false },
  "organization.ledger.read": { owner: true, admin: true, builder: true, viewer: true },
  "organization.ledger.import": { owner: true, admin: true, builder: true, viewer: false },
  "organization.channel.read": { owner: true, admin: true, builder: true, viewer: true },
  "organization.channel.connect": { owner: true, admin: true, builder: false, viewer: false },
  "organization.channel.revoke": { owner: true, admin: true, builder: false, viewer: false },
  "organization.registration.read": { owner: true, admin: true, builder: true, viewer: true },
  "organization.registration.write": { owner: true, admin: true, builder: true, viewer: false },
};

describe("nexus RBAC actions (design §7.2)", () => {
  describe("the role matrix", () => {
    for (const action of NEXUS_ACTIONS) {
      for (const role of ["owner", "admin", "builder", "viewer"] as const) {
        const expected = MATRIX[action][role];
        it(`${role} ${expected ? "may" : "may not"} ${action}`, () => {
          expect(ask(role, action)).toBe(expected);
        });
      }
    }
  });

  it("registers every action in the flat validation set", () => {
    // An action absent from ALL_KNOWN_ACTIONS denies with `unknown_action` for
    // *every* role — including owner. Asking as owner isolates that failure
    // from an ordinary permission miss.
    for (const action of NEXUS_ACTIONS) {
      const result = authorize({
        subject,
        action,
        resource: { kind: "organization", orgId: ORG },
        context: { memberships: [orgFact("owner")] },
      });
      expect({ action, reason: result.reason }).not.toEqual({
        action,
        reason: "unknown_action",
      });
    }
  });

  it("resolves exactly four read actions for a viewer", () => {
    const allowed = listEffectivePermissions({
      subject,
      resource: { kind: "organization", orgId: ORG },
      context: { memberships: [orgFact("viewer")] },
    })
      .permissions.filter((p) => p.allow)
      .map((p) => p.action)
      .filter((a) => (NEXUS_ACTIONS as readonly string[]).includes(a));

    expect(allowed.sort()).toEqual([
      "organization.channel.read",
      "organization.ledger.read",
      "organization.nexus.read",
      "organization.registration.read",
    ]);
  });

  it("resolves exactly seven actions for a builder", () => {
    const allowed = listEffectivePermissions({
      subject,
      resource: { kind: "organization", orgId: ORG },
      context: { memberships: [orgFact("builder")] },
    })
      .permissions.filter((p) => p.allow)
      .map((p) => p.action)
      .filter((a) => (NEXUS_ACTIONS as readonly string[]).includes(a));

    expect(allowed).toHaveLength(7);
    // The two a builder must NOT have are the money-attaching ones.
    expect(allowed).not.toContain("organization.channel.connect");
    expect(allowed).not.toContain("organization.channel.revoke");
  });

  it("grants a billing_admin none of them", () => {
    for (const action of NEXUS_ACTIONS) {
      expect(ask("billing_admin", action)).toBe(false);
    }
  });

  it("denies every action to a member of a different organization", () => {
    for (const action of NEXUS_ACTIONS) {
      const result = authorize({
        subject,
        action,
        resource: { kind: "organization", orgId: "org_other" },
        context: { memberships: [orgFact("owner")] },
      });
      expect(result.allow).toBe(false);
    }
  });
});
