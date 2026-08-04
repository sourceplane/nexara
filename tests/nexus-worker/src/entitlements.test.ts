// Plan limits on the nexus surfaces (design §9).
//
// The gate is pure, so the commercial rule is asserted directly rather than
// through a handler. The block that matters most is the last one: it pins the
// *shape* of the jurisdiction limit — everything ingested, the excess named
// but not evaluated — because the three alternatives are each a way of losing
// or hiding a seller's own data, and a future edit that "simplifies" this
// would reintroduce one of them.

import {
  CHANNELS_LIMIT_KEY,
  JURISDICTIONS_LIMIT_KEY,
  decideChannelsLimit,
  decideQuantityGate,
  lockedNotice,
  monitoredLimitFrom,
  splitByLimit,
} from "@nexus-worker/entitlements";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

const ORG = "org_1";

const allowed = (limitValue: number | null): CheckBillingEntitlementResponse => ({
  allowed: true,
  orgId: ORG,
  entitlementKey: JURISDICTIONS_LIMIT_KEY,
  valueType: "quantity",
  limitValue,
  source: "plan",
  subscriptionId: null,
});

const denied = (reason: "disabled" | "not_configured"): CheckBillingEntitlementResponse => ({
  allowed: false,
  orgId: ORG,
  entitlementKey: JURISDICTIONS_LIMIT_KEY,
  reason,
});

const MESSAGES = {
  disabled: "disabled",
  notConfigured: "not configured",
  malformed: "malformed",
  limitReached: "limit reached",
};

describe("decideQuantityGate", () => {
  it("allows below the limit and denies at it", () => {
    expect(decideQuantityGate(allowed(10), 9, MESSAGES).kind).toBe("allow");
    expect(decideQuantityGate(allowed(10), 10, MESSAGES).kind).toBe("deny");
    expect(decideQuantityGate(allowed(10), 11, MESSAGES).kind).toBe("deny");
  });

  it("treats a null limit as unlimited", () => {
    const gate = decideQuantityGate(allowed(null), 10_000, MESSAGES);
    expect(gate).toEqual({ kind: "allow", limit: null });
  });

  it("carries billing's own reason through a denial", () => {
    const gate = decideQuantityGate(denied("disabled"), 0, MESSAGES);
    expect(gate).toMatchObject({ kind: "deny", reason: "disabled" });
    expect(decideQuantityGate(denied("not_configured"), 0, MESSAGES)).toMatchObject({
      reason: "not_configured",
    });
  });

  it("reports the limit and the current count, so the console can draw the bar", () => {
    const gate = decideQuantityGate(allowed(10), 10, MESSAGES);
    expect(gate).toMatchObject({ kind: "deny", reason: "limit_reached", limit: 10, current: 10 });
  });

  // Fails closed on every shape it does not understand, so a billing bug
  // cannot be a free upgrade.
  it.each([
    ["a boolean entitlement", { ...allowed(1), valueType: "boolean" as const }],
    ["a negative limit", allowed(-1)],
    ["a non-finite limit", allowed(Number.POSITIVE_INFINITY)],
  ])("denies %s as malformed", (_what, decision) => {
    expect(decideQuantityGate(decision as CheckBillingEntitlementResponse, 0, MESSAGES)).toMatchObject({
      kind: "deny",
      reason: "malformed_limit",
    });
  });

  it("reports a service error on a nonsensical current count", () => {
    expect(decideQuantityGate(allowed(10), Number.NaN, MESSAGES).kind).toBe("service_error");
    expect(decideQuantityGate(allowed(10), -1, MESSAGES).kind).toBe("service_error");
  });
});

describe("decideChannelsLimit", () => {
  it("says existing channels keep ingesting — a denial is not a disconnection", () => {
    const gate = decideChannelsLimit(allowed(1), 1);
    expect(gate.kind).toBe("deny");
    if (gate.kind !== "deny") return;
    expect(gate.message).toMatch(/keep ingesting/i);
    expect(gate.message).toMatch(/upgrade/i);
  });

  it("uses its own entitlement key, not the jurisdiction one", () => {
    expect(CHANNELS_LIMIT_KEY).not.toBe(JURISDICTIONS_LIMIT_KEY);
  });
});

describe("monitoredLimitFrom — a billing outage must not stop monitoring", () => {
  it("reads a numeric limit", () => {
    expect(monitoredLimitFrom(allowed(10))).toBe(10);
  });

  it("returns null (unlimited) when billing is unreachable or unhelpful", () => {
    // Deliberately fails OPEN, unlike the authorization gate. "May this person
    // see this" and "have they paid for more of it" are different questions,
    // and getting the second one wrong during a billing outage would silently
    // stop measuring a seller's tax exposure.
    expect(monitoredLimitFrom(null)).toBeNull();
    expect(monitoredLimitFrom(denied("not_configured"))).toBeNull();
    expect(monitoredLimitFrom({ ...allowed(5), valueType: "boolean" } as CheckBillingEntitlementResponse)).toBeNull();
    expect(monitoredLimitFrom(allowed(null))).toBeNull();
  });
});

describe("splitByLimit — everything ingested, the excess named but not evaluated", () => {
  const seniority = ["US-CA", "US-TX", "US-NY", "US-WA", "US-FL"];

  it("monitors the first N by seniority and locks the rest", () => {
    const split = splitByLimit(seniority, 3);
    expect(split.monitored).toEqual(["US-CA", "US-TX", "US-NY"]);
    expect(split.locked).toEqual(["US-WA", "US-FL"]);
    expect(split.limit).toBe(3);
  });

  // The property that makes the whole design defensible: nothing is dropped.
  // A seller over their limit can still see that they trade into every one of
  // these jurisdictions — they just do not get a measurement for the excess.
  it("never loses a jurisdiction — monitored ∪ locked is the whole input", () => {
    for (const limit of [0, 1, 3, 5, 9]) {
      const split = splitByLimit(seniority, limit);
      expect([...split.monitored, ...split.locked]).toEqual(seniority);
    }
  });

  it("monitors everything when the plan is unlimited", () => {
    const split = splitByLimit(seniority, null);
    expect(split.monitored).toEqual(seniority);
    expect(split.locked).toEqual([]);
  });

  it("is stable — the same input order gives the same split every time", () => {
    // Ranking by exposure instead would drop a jurisdiction out of monitoring
    // the month it got busy, which is backwards, and would make the monitored
    // set flicker week to week.
    expect(splitByLimit(seniority, 3)).toEqual(splitByLimit(seniority, 3));
  });

  it("handles a limit of zero without throwing", () => {
    const split = splitByLimit(seniority, 0);
    expect(split.monitored).toEqual([]);
    expect(split.locked).toEqual(seniority);
  });

  it("handles a limit larger than the input", () => {
    const split = splitByLimit(seniority, 50);
    expect(split.monitored).toEqual(seniority);
    expect(split.locked).toEqual([]);
  });
});

describe("lockedNotice", () => {
  it("says the sales are still recorded and an upgrade closes no gap", () => {
    const notice = lockedNotice(10);
    expect(notice).toContain("10 jurisdictions");
    expect(notice).toMatch(/still recorded/i);
    // The promise that makes the limit fair: upgrading measures from the
    // ledger they already have, so the limit costs them monitoring rather
    // than history.
    expect(notice).toMatch(/no gap/i);
  });

  it("agrees with itself in the singular", () => {
    expect(lockedNotice(1)).toContain("1 jurisdiction.");
  });
});
