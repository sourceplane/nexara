import type { PublicPlan } from "@saas/contracts/billing";

/**
 * Pure (no-React) helpers for the billing actions UI, kept separate so the
 * selection/formatting logic is unit-testable without a DOM.
 */

/**
 * The plans a user can upgrade to via self-serve checkout: active, recurring,
 * and priced strictly above the current plan. Excludes Free (price 0),
 * Enterprise (billingInterval "none" — contact sales), and any plan at or below
 * the current price (downgrades go through the customer portal, not checkout).
 * Sorted by price asc.
 */
export function selectUpgradePlans(
  plans: PublicPlan[],
  activePlanCode: string | null,
): PublicPlan[] {
  const current = activePlanCode ? plans.find((p) => p.code === activePlanCode) : undefined;
  const currentPrice = current?.priceAmountCents ?? 0;
  return plans
    .filter(
      (p) =>
        p.status === "active" &&
        p.billingInterval !== "none" &&
        (p.priceAmountCents ?? 0) > 0 &&
        p.code !== activePlanCode &&
        (p.priceAmountCents ?? 0) > currentPrice,
    )
    .sort((a, b) => (a.priceAmountCents ?? 0) - (b.priceAmountCents ?? 0));
}

/**
 * The lower **paid** plans an existing subscriber can downgrade to: active,
 * recurring, priced strictly below the current plan but still > 0. Excludes Free
 * (that's "Cancel plan") and Enterprise (contact sales). Sorted by price desc, so
 * the nearest-lower tier comes first. Empty for free/unpriced current plans.
 */
export function selectDowngradePlans(
  plans: PublicPlan[],
  activePlanCode: string | null,
): PublicPlan[] {
  const current = activePlanCode ? plans.find((p) => p.code === activePlanCode) : undefined;
  const currentPrice = current?.priceAmountCents ?? 0;
  if (currentPrice <= 0) return []; // free/unpriced has no paid tier below it
  return plans
    .filter(
      (p) =>
        p.status === "active" &&
        p.billingInterval !== "none" &&
        (p.priceAmountCents ?? 0) > 0 &&
        p.code !== activePlanCode &&
        (p.priceAmountCents ?? 0) < currentPrice,
    )
    .sort((a, b) => (b.priceAmountCents ?? 0) - (a.priceAmountCents ?? 0));
}

/** Short human price, e.g. "$20/mo". Empty string when unpriced. */
export function formatPlanPrice(plan: PublicPlan): string {
  if (plan.priceAmountCents == null) return "";
  const amount = plan.priceAmountCents / 100;
  const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const symbol = plan.priceCurrency.toLowerCase() === "usd" ? "$" : `${plan.priceCurrency.toUpperCase()} `;
  const per = plan.billingInterval === "year" ? "/yr" : plan.billingInterval === "month" ? "/mo" : "";
  return `${symbol}${num}${per}`;
}

/** Whether the org has a paid subscription worth surfacing a "Manage billing" portal for. */
export function hasManageableSubscription(activePlanCode: string | null): boolean {
  return activePlanCode !== null && activePlanCode !== "free";
}

/**
 * All active plans ordered for the change-plan grid: Free → paid (price asc) →
 * contact-sales (`billingInterval: "none"`) last.
 */
export function orderedPlans(plans: PublicPlan[]): PublicPlan[] {
  const rank = (p: PublicPlan) => (p.billingInterval === "none" ? Number.MAX_SAFE_INTEGER : p.priceAmountCents ?? 0);
  return plans.filter((p) => p.status === "active").sort((a, b) => rank(a) - rank(b));
}

export type PlanChangeAction = "current" | "checkout" | "change" | "cancel" | "contact";

/**
 * What selecting `targetCode` does, given the current plan. First purchase →
 * checkout; an existing provider-managed paid sub switching plans → change;
 * moving to Free → cancel; a contact-sales plan → contact; same plan → current.
 */
export function planChangeAction(opts: {
  target: PublicPlan;
  currentCode: string | null;
  /** True when there's a provider-managed paid subscription we can change/cancel. */
  manageable: boolean;
}): PlanChangeAction {
  const current = opts.currentCode ?? "free";
  if (opts.target.code === current) return "current";
  if (opts.target.billingInterval === "none") return "contact";
  const targetIsFree = (opts.target.priceAmountCents ?? 0) === 0;
  if (targetIsFree) return "cancel";
  return opts.manageable ? "change" : "checkout";
}

/**
 * Curated, safe-to-display feature bullets per plan code for the change-plan
 * cards.
 *
 * These are transcribed from the real entitlements in
 * `apps/billing-worker/src/plan-catalog.ts`, not written as marketing copy.
 * A plan card that promises a limit the catalog does not grant is a bug that
 * only surfaces after someone has paid, so the numbers here are the numbers
 * the gate enforces:
 *
 *   free       jurisdictions 10, channels 1,  members 5
 *   pro        jurisdictions ∞,  channels 3,  members 20
 *   business   jurisdictions ∞,  channels ∞,  members 50
 *   enterprise all unlimited
 *
 * Jurisdictions lead because that is the dimension the product is bought for
 * and the one the board visibly locks. If the catalog changes, change this.
 */
export function planFeatureLines(code: string): string[] {
  switch (code) {
    case "free":
      return ["10 monitored jurisdictions", "1 sales channel", "Up to 5 members"];
    case "pro":
      return [
        "Unlimited monitored jurisdictions",
        "3 sales channels",
        "Up to 20 members",
        "Priority support",
      ];
    case "business":
      return [
        "Unlimited monitored jurisdictions",
        "Unlimited sales channels",
        "Up to 50 members",
        "Multiple organizations",
      ];
    case "enterprise":
      return ["Everything unlimited", "SSO & advanced security", "Dedicated support"];
    default:
      return [];
  }
}

export interface PollPlanChangeOptions {
  /** Re-read the current plan code (e.g. from the billing summary). */
  fetchPlanCode: () => Promise<string | null>;
  /** The plan the buyer was on before checkout. */
  fromPlanCode: string | null;
  /** How many times to poll before giving up. */
  attempts: number;
  /** Delay between polls. */
  intervalMs: number;
  /** Injectable delay (tests pass a no-op). */
  sleep: (ms: number) => Promise<void>;
}

/**
 * After an embedded checkout succeeds, the plan is applied asynchronously by the
 * provider webhook (seconds later) — not by the checkout call. Poll the billing
 * summary until the plan code changes from what the buyer started on (or the
 * attempt budget is exhausted), so the console can mask the webhook lag with a
 * "finalizing…" state instead of showing the stale plan. Pure + injectable so
 * it unit-tests without real timers. Transient fetch errors are swallowed and
 * retried; a thrown predicate never escapes.
 */
export async function pollForPlanChange(
  opts: PollPlanChangeOptions,
): Promise<{ changed: boolean; planCode: string | null }> {
  let planCode = opts.fromPlanCode;
  for (let i = 0; i < opts.attempts; i++) {
    await opts.sleep(opts.intervalMs);
    try {
      planCode = await opts.fetchPlanCode();
    } catch {
      continue; // transient — keep polling
    }
    if (planCode !== opts.fromPlanCode) {
      return { changed: true, planCode };
    }
  }
  return { changed: false, planCode };
}
