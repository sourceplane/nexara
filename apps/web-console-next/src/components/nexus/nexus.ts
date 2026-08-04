/**
 * Pure presentation logic for the nexus surfaces.
 *
 * Dependency-free (no React, no icons) so every rule about how a position is
 * *shown* is unit-testable in isolation — and the rules here are not cosmetic.
 * Two of them are the product:
 *
 *   1. **`no_obligation` never renders like `clear`, and a null meter never
 *      renders as 0%.** `clear` means measured and below the line;
 *      `no_obligation` means there is no line. A board that renders them alike
 *      has lost the distinction the `threshold_logic = 'none'` rule row exists
 *      to carry — and "no data" would then look identical to both.
 *   2. **An unverified rule set renders a banner instead of a status.** Design
 *      §11's gate is enforced in the engine's caller, not here; this is the
 *      *presentation* half, and it must never be the only half.
 */

import type {
  DeterminationStatus,
  MeasurementBasis,
  MeasurementPeriod,
  MarketplaceTreatment,
  PublicJurisdictionExposure,
  ThresholdLogic,
} from "@saas/contracts/nexus";

// ── Money and numbers ────────────────────────────────────────

/**
 * Integer cents → a display amount.
 *
 * Cents in, string out; there is no float in between. `formatCents` is the
 * only place this codebase turns money into text, so a change to how amounts
 * read is one edit rather than a search.
 */
export function formatCents(cents: number, currency = "USD"): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  const grouped = whole.toLocaleString("en-US");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${negative ? "−" : ""}${symbol}${grouped}.${frac}`;
}

/** A compact amount for a dense card: `$512.3k`, `$1.2M`. Never for evidence. */
export function formatCentsCompact(cents: number, currency = "USD"): string {
  const abs = Math.abs(cents) / 100;
  const symbol = currency === "USD" ? "$" : `${currency} `;
  const sign = cents < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${symbol}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${symbol}${abs.toFixed(0)}`;
}

/**
 * The meter's percentage, or null when there is nothing to be a percentage of.
 *
 * **Null is not zero.** A `threshold_logic = 'none'` jurisdiction, and one that
 * has never been evaluated, both return null and render as text rather than as
 * an empty bar. 0% reads as "measured, and nowhere near the line", which is a
 * claim neither case supports.
 */
export function meterPercent(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  return Math.max(0, fraction * 100);
}

/** The bar's width, clamped — the *label* is never clamped. */
export function meterWidth(fraction: number | null): number {
  const pct = meterPercent(fraction);
  return pct === null ? 0 : Math.min(100, pct);
}

// ── Status presentation ──────────────────────────────────────

export type StatusTone = "neutral" | "muted" | "warning" | "danger" | "success";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  /** One sentence a merchant can act on. Never a legal conclusion. */
  description: string;
}

/**
 * How a status reads.
 *
 * The copy never states a legal conclusion (R1). "Crossed" says a measurement
 * passed a threshold; it does not say the seller owes tax, because that is
 * advice and this product does not give advice.
 */
export function presentStatus(status: DeterminationStatus): StatusPresentation {
  switch (status) {
    case "no_obligation":
      return {
        label: "Out of scope",
        // Deliberately NOT "clear" and deliberately NOT a percentage. This
        // jurisdiction enforces no economic-nexus threshold at all.
        tone: "muted",
        description: "This jurisdiction enforces no economic-nexus threshold.",
      };
    case "clear":
      return {
        label: "Clear",
        tone: "neutral",
        description: "Measured activity is below this jurisdiction's threshold.",
      };
    case "approaching":
      return {
        label: "Approaching",
        tone: "warning",
        description: "Measured activity is nearing this jurisdiction's threshold.",
      };
    case "crossed":
      return {
        label: "Crossed",
        tone: "danger",
        description:
          "Measured activity has passed this jurisdiction's threshold. Review the registration deadline.",
      };
    case "registered":
      return {
        label: "Registered",
        tone: "success",
        description: "You have recorded an active registration in this jurisdiction.",
      };
    default:
      return { label: status, tone: "neutral", description: "" };
  }
}

/** Board ordering: the things that need attention first, then alphabetical. */
const STATUS_RANK: Record<DeterminationStatus, number> = {
  crossed: 0,
  approaching: 1,
  registered: 2,
  clear: 3,
  no_obligation: 4,
};

export function sortExposure(
  rows: readonly PublicJurisdictionExposure[],
): PublicJurisdictionExposure[] {
  return [...rows].sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    // Within a status, the closest to its line first — a seller triaging six
    // `approaching` states wants the nearest one at the top.
    const fa = a.fractionOfThreshold ?? -1;
    const fb = b.fractionOfThreshold ?? -1;
    if (fb !== fa) return fb - fa;
    return a.jurisdictionName.localeCompare(b.jurisdictionName);
  });
}

export interface ExposureTotals {
  crossed: number;
  approaching: number;
  registered: number;
  clear: number;
  outOfScope: number;
}

export function summarizeExposure(
  rows: readonly PublicJurisdictionExposure[],
): ExposureTotals {
  const totals: ExposureTotals = {
    crossed: 0, approaching: 0, registered: 0, clear: 0, outOfScope: 0,
  };
  for (const row of rows) {
    if (row.status === "crossed") totals.crossed += 1;
    else if (row.status === "approaching") totals.approaching += 1;
    else if (row.status === "registered") totals.registered += 1;
    else if (row.status === "clear") totals.clear += 1;
    else totals.outOfScope += 1;
  }
  return totals;
}

// ── Rule presentation ────────────────────────────────────────

export function describeBasis(basis: MeasurementBasis): string {
  switch (basis) {
    case "gross":
      return "gross sales";
    case "retail":
      return "retail sales";
    case "taxable":
      return "taxable sales";
    default:
      return basis;
  }
}

export function describePeriod(period: MeasurementPeriod): string {
  switch (period) {
    case "rolling_12m":
      return "the trailing twelve months";
    case "calendar_year":
      return "the current calendar year";
    case "previous_calendar_year":
      return "the previous calendar year";
    default:
      return period;
  }
}

export function describeMarketplace(treatment: MarketplaceTreatment): string {
  return treatment === "include"
    ? "marketplace-facilitated sales count toward this threshold"
    : "marketplace-facilitated sales are excluded from this threshold";
}

export function describeLogic(
  logic: ThresholdLogic,
  salesCents: number | null,
  transactions: number | null,
): string {
  switch (logic) {
    case "none":
      return "This jurisdiction enforces no economic-nexus threshold.";
    case "sales_only":
      return `Crossed at ${salesCents === null ? "—" : formatCents(salesCents)} in sales.`;
    case "transactions_only":
      return `Crossed at ${transactions ?? "—"} transactions.`;
    case "either":
      return `Crossed at ${salesCents === null ? "—" : formatCents(salesCents)} in sales OR ${transactions ?? "—"} transactions — whichever comes first.`;
    case "both":
      return `Crossed only when BOTH ${salesCents === null ? "—" : formatCents(salesCents)} in sales AND ${transactions ?? "—"} transactions are met.`;
    default:
      return "";
  }
}

/**
 * The measured window, as a reader recognises it.
 *
 * The stored `periodEnd` is **exclusive** — it is the first instant not
 * measured. Rendering it as the last day would be off by one in the evidence,
 * so it is rendered as "up to, not including".
 */
export function describeWindow(periodStart: string, periodEnd: string): string {
  if (!periodStart || !periodEnd) return "Not yet evaluated";
  return `${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)} (up to, not including)`;
}

/** ISO date/instant → a short display date, without a timezone shift. */
export function formatDate(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

// ── The §11 gate, on the presentation side ───────────────────

export interface UnverifiedNotice {
  title: string;
  body: string;
}

/**
 * The banner that replaces a status when the rule set is unverified.
 *
 * This is the *presentation* half of design §11 and it must never be the only
 * half — the engine's caller already marks such determinations internal-only
 * and suppresses the alert. A UI-only gate is not a gate; a gate with no UI is
 * a gate a merchant cannot see.
 */
export function unverifiedNotice(ruleSetVersion: string): UnverifiedNotice {
  return {
    title: "This rule set is not verified",
    body:
      `Rule set ${ruleSetVersion} has not been verified against primary tax sources. ` +
      "These positions are shown for internal review only. They are not a compliance " +
      "determination and no alerts are being sent from them.",
  };
}

/** True when the board should show the banner rather than headline statuses. */
export function shouldWarnUnverified(ruleSetVerified: boolean): boolean {
  return !ruleSetVerified;
}

// ── Ledger presentation ──────────────────────────────────────

export function describeJurisdictionSource(source: string): string {
  switch (source) {
    case "shipping_address":
      return "Ship-to address";
    case "billing_address":
      // R4: a poor proxy for where a service was consumed, and the row says so
      // rather than laundering it into a fact.
      return "Billing address (fallback)";
    case "tax_lines":
      return "Implied by tax lines (fallback)";
    case "declared":
      return "Declared at import";
    default:
      return source;
  }
}

/** True when this ledger row reverses another — rendered as a linked reversal,
 *  never as a mutation of the original. */
export function isReversal(event: { kind: string; reversesEventId: string | null }): boolean {
  return event.kind === "refund" && event.reversesEventId !== null;
}

/** Tone → the `Badge` variant the design system already ships. One mapping,
 *  so a new tone cannot be introduced by a component picking its own colour. */
export function toneVariant(
  tone: StatusTone,
): "default" | "secondary" | "destructive" | "warning" | "success" | "outline" {
  switch (tone) {
    case "danger":
      return "destructive";
    case "warning":
      return "warning";
    case "success":
      return "success";
    case "muted":
      return "outline";
    default:
      return "secondary";
  }
}

// ── Channel presentation ─────────────────────────────────────

export interface ChannelHealth {
  label: string;
  tone: StatusTone;
  detail: string;
}

/**
 * How a channel reads on the board.
 *
 * `backfilling` with no `backfillCompletedAt` is **not** an error and **not**
 * "connected" — it is honestly "still ingesting", and conflating it with
 * connected is how a partial ledger comes to look complete (design §12).
 */
export function presentChannel(channel: {
  status: string;
  backfillCompletedAt: string | null;
  lastEventAt: string | null;
}): ChannelHealth {
  if (channel.status === "revoked") {
    return {
      label: "Revoked",
      tone: "muted",
      detail: "No longer ingesting. Existing ledger rows are unaffected.",
    };
  }
  if (channel.status === "degraded") {
    return {
      label: "Quiet",
      tone: "warning",
      // R3: absence of data reads identically to absence of sales, so the copy
      // says which one we cannot tell.
      detail: "No events for longer than this channel's usual cadence. This may be a stalled connection rather than a quiet period.",
    };
  }
  if (channel.backfillCompletedAt === null) {
    return {
      label: "Backfilling",
      tone: "warning",
      detail: "Historical orders are still being imported. Positions are incomplete until this finishes.",
    };
  }
  return {
    label: "Connected",
    tone: "success",
    detail: channel.lastEventAt
      ? `Last event ${formatDate(channel.lastEventAt)}.`
      : "Connected. No events yet.",
  };
}

// ── Delivery presentation ────────────────────────────────────

/**
 * How an inbox row reads.
 *
 * `received` with attempts > 0 is *retrying*, not *new* — a seller looking at
 * a stalled ingestion needs those two separated, because one is a queue depth
 * and the other is a problem.
 */
export function presentDelivery(delivery: {
  status: string;
  attempts: number;
}): { label: string; tone: StatusTone } {
  switch (delivery.status) {
    case "applied":
      return { label: "Applied", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
    default:
      return delivery.attempts > 0
        ? { label: "Retrying", tone: "warning" }
        : { label: "Queued", tone: "neutral" };
  }
}

/**
 * How much of the backfill is done, in the only terms we can honestly give.
 *
 * Deliberately **not** a percentage. `nexus.channels.backfill_cursor` is a
 * provider-opaque page token — Stripe's `starting_after`, Shopify's
 * `page_info` — not a date, so there is no ratio to compute and any number
 * shown here would be invented. What *is* known is real and is what a seller
 * actually needs: how far back the walk goes, and the instant from which live
 * capture is already covering them.
 */
export function describeBackfill(channel: {
  backfillStartedAt: string | null;
  backfillCompletedAt: string | null;
  lookbackFloor: string;
}): { done: boolean; detail: string } {
  if (channel.backfillCompletedAt !== null) {
    return {
      done: true,
      detail: `History imported back to ${channel.lookbackFloor}, finished ${formatDate(channel.backfillCompletedAt)}.`,
    };
  }
  if (channel.backfillStartedAt === null) {
    return { done: false, detail: "Not started." };
  }
  return {
    done: false,
    detail:
      `Importing history back to ${channel.lookbackFloor}. Live orders from ` +
      `${formatDate(channel.backfillStartedAt)} onward are already being captured, so nothing ` +
      `is missed while this runs — but positions are incomplete until it finishes.`,
  };
}
