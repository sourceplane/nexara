// Plan limits on the nexus surfaces (design §9).
//
// Two dimensions are gated: how many jurisdictions an org has monitored, and
// how many channels it has connected. The channel gate is the easy one — a
// human clicks Connect, so a denial has an obvious moment to happen in.
//
// The jurisdiction gate is the interesting one, and the shape below is a
// product decision that deserves stating plainly, because the obvious
// implementations are all wrong:
//
//   * **Refusing the ledger row** would drop revenue data a seller sent us.
//     Their ledger would then be permanently and silently incomplete, and no
//     later upgrade could repair it. A billing limit must never cost a
//     customer their own history.
//   * **Erroring the whole board** punishes the seller for growing, hides the
//     nine jurisdictions they *are* entitled to see, and reads as an outage.
//   * **Hiding the excess jurisdictions entirely** is the worst of the three.
//     A compliance product that knows a seller is trading into Texas and does
//     not say so has chosen to conceal the thing it exists to surface.
//
// So: **everything is ingested, the excess is named but not evaluated.** The
// board lists every jurisdiction the seller trades into; the ones beyond the
// plan limit render as locked, by name, with an upgrade prompt instead of a
// position. The seller always knows the jurisdiction exists — they just do not
// get the measurement until they pay for it. That is a fair trade to state out
// loud, and it is the only one of the four that never withholds a fact.
//
// Selection is by **seniority — the jurisdictions the seller traded into
// first**. Ranking by exposure would be more useful right up until a
// jurisdiction fell out of the monitored set the month it got busy, which is
// precisely backwards, and it would make the monitored set flicker week to
// week. Seniority is stable, explainable in one sentence, and the console says
// which rule it used.

import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

export const JURISDICTIONS_LIMIT_KEY = "limit.jurisdictions_monitored";
export const CHANNELS_LIMIT_KEY = "limit.channels_connected";

/** Metered dimensions reported to `metering-worker` (design §9). */
export const METRIC_JURISDICTIONS = "jurisdictions_monitored";
export const METRIC_SALE_EVENTS = "sale_events_ingested";
export const METRIC_CHANNELS = "channels_connected";

export type EntitlementGate =
  | { kind: "allow"; limit: number | null }
  | { kind: "deny"; reason: string; message: string; limit: number | null; current: number }
  | { kind: "service_error" };

/**
 * Interpret a quantity entitlement, failing closed on every unexpected shape.
 *
 * Mirrors `projects-worker`'s `decideQuantityGate` deliberately rather than
 * importing it: that function lives in another bounded context's worker, and a
 * cross-app import would couple two deploy units to make one `if` shorter.
 * The semantics are the platform's, so they are matched exactly:
 *
 *   allowed:false                          → deny (billing's own reason)
 *   allowed:true, valueType ≠ "quantity"   → deny (malformed_limit)
 *   allowed:true, limitValue null          → allow (unlimited)
 *   allowed:true, current  < limitValue    → allow
 *   allowed:true, current >= limitValue    → deny (limit_reached)
 */
export function decideQuantityGate(
  decision: CheckBillingEntitlementResponse,
  current: number,
  messages: { disabled: string; notConfigured: string; malformed: string; limitReached: string },
): EntitlementGate {
  if (!decision.allowed) {
    return {
      kind: "deny",
      reason: decision.reason,
      message: decision.reason === "disabled" ? messages.disabled : messages.notConfigured,
      limit: null,
      current,
    };
  }
  if (decision.valueType !== "quantity") {
    return { kind: "deny", reason: "malformed_limit", message: messages.malformed, limit: null, current };
  }
  if (decision.limitValue === null) {
    return { kind: "allow", limit: null };
  }
  if (
    typeof decision.limitValue !== "number" ||
    !Number.isFinite(decision.limitValue) ||
    decision.limitValue < 0
  ) {
    return { kind: "deny", reason: "malformed_limit", message: messages.malformed, limit: null, current };
  }
  if (!Number.isFinite(current) || current < 0) {
    return { kind: "service_error" };
  }
  if (current < decision.limitValue) {
    return { kind: "allow", limit: decision.limitValue };
  }
  return {
    kind: "deny",
    reason: "limit_reached",
    message: messages.limitReached,
    limit: decision.limitValue,
    current,
  };
}

export function decideChannelsLimit(
  decision: CheckBillingEntitlementResponse,
  connectedCount: number,
): EntitlementGate {
  return decideQuantityGate(decision, connectedCount, {
    disabled: "Connecting sales channels is disabled by your current plan",
    notConfigured: "Connecting sales channels is not available for this organization",
    malformed: "Connecting sales channels is not permitted by your current plan",
    limitReached:
      "Your plan's connected-channel limit is reached. Existing channels keep ingesting; " +
      "upgrade to connect another.",
  });
}

/**
 * How many jurisdictions this org may have *evaluated*.
 *
 * Null means unlimited. A billing failure returns null rather than zero — the
 * gate is a commercial control, and a billing outage must not silently stop
 * monitoring a seller's tax exposure. Failing *open* here is the deliberate
 * opposite of how the authorization gate fails, and the two are different
 * questions: one asks "may this person see this", the other asks "have they
 * paid for more of it".
 */
export function monitoredLimitFrom(decision: CheckBillingEntitlementResponse | null): number | null {
  if (!decision || !decision.allowed) return null;
  if (decision.valueType !== "quantity") return null;
  if (decision.limitValue === null) return null;
  if (!Number.isFinite(decision.limitValue) || decision.limitValue < 0) return null;
  return decision.limitValue;
}

export interface MonitoredSplit {
  /** Evaluated and shown with a position. */
  monitored: string[];
  /** Named on the board, not evaluated, rendered with an upgrade prompt. */
  locked: string[];
  /** The plan's limit, or null when unlimited. */
  limit: number | null;
}

/**
 * Split a seller's jurisdictions into monitored and locked.
 *
 * `jurisdictions` must be ordered by seniority — first traded into, first
 * monitored. The repository returns them in a stable order for exactly this
 * reason; sorting them here by anything else would reintroduce the flicker
 * the seniority rule exists to avoid.
 */
export function splitByLimit(
  jurisdictions: readonly string[],
  limit: number | null,
): MonitoredSplit {
  if (limit === null) {
    return { monitored: [...jurisdictions], locked: [], limit: null };
  }
  return {
    monitored: jurisdictions.slice(0, limit),
    locked: jurisdictions.slice(limit),
    limit,
  };
}

/** Copy for a locked jurisdiction card. Names the jurisdiction; never hides it. */
export function lockedNotice(limit: number): string {
  return (
    `Your plan monitors ${limit} jurisdiction${limit === 1 ? "" : "s"}. This one is not being ` +
    `measured — its sales are still recorded, and upgrading starts monitoring it from your ` +
    `existing ledger with no gap.`
  );
}
