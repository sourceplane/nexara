// Threshold evaluation. The one function whose output a state might one day
// read back to us.

import type {
  EngineStatus,
  MeasuredTotals,
  Rule,
  ThresholdLogic,
} from "@saas/contracts/nexus";

/** Fraction of the threshold at which a position becomes `"approaching"`. */
export const DEFAULT_APPROACHING_FRACTION = 0.8;

export interface ThresholdVerdict {
  status: EngineStatus;
  /**
   * Progress toward the **binding** threshold, or null when there is none to
   * be a fraction of. Never clamped: a seller at 240% of the line should see
   * 240%, not 100%.
   */
  fractionOfThreshold: number | null;
  thresholdSalesCents: number | null;
  thresholdTransactions: number | null;
}

/**
 * Compare a measurement to the rule in force.
 *
 * **The comparator is `>=`, deliberately.** State statutes split between
 * "exceeds $100,000" (strictly greater) and "$100,000 or more" (at least), and
 * the schema carries no per-rule comparator. `>=` is the conservative
 * direction for a *monitoring* product: telling a seller they are at the line
 * when the state would say they are one cent short costs them a conversation
 * with their accountant, and the reverse costs them penalties. This is an
 * engine convention pinned by `ENGINE_VERSION` — changing it is a major bump,
 * and making it per-rule data is a named follow-on rather than a silent edit.
 */
export function evaluateThreshold(
  measured: MeasuredTotals,
  rule: Pick<
    Rule,
    "thresholdLogic" | "salesThresholdCents" | "transactionThreshold"
  >,
  approachingFraction: number = DEFAULT_APPROACHING_FRACTION,
): ThresholdVerdict {
  const logic: ThresholdLogic = rule.thresholdLogic;

  // `"none"` is terminal and is checked first, before any measurement is
  // interpreted. Forty-eight jurisdictions enforce a threshold; the rest
  // enforce none, and they get an explicit rule row saying so. Returning
  // `clear` at 0% here — or dividing by a null threshold — would render "no
  // obligation" and "no data" identically, and the first is the answer while
  // the second is a bug in our rule set (design §3.3, §5.3 case 8).
  if (logic === "none") {
    return {
      status: "no_obligation",
      fractionOfThreshold: null,
      thresholdSalesCents: null,
      thresholdTransactions: null,
    };
  }

  const salesThreshold = rule.salesThresholdCents;
  const txnThreshold = rule.transactionThreshold;

  const salesApplies = logic !== "transactions_only" && salesThreshold !== null;
  const txnApplies = logic !== "sales_only" && txnThreshold !== null;

  // A rule whose logic names a test it carries no threshold for is
  // unevaluable. The DB constraint `nexus_rules_threshold_logic_ck` makes such
  // a row unwritable; this is the belt to that braces, because an engine that
  // divides by null renders a confident 0% and confident-and-wrong is the one
  // output this product cannot ship.
  if (!salesApplies && !txnApplies) {
    throw new RangeError(
      `Rule declares threshold_logic="${logic}" but carries no usable threshold`,
    );
  }

  const salesCrossed = salesApplies && measured.salesCents >= salesThreshold!;
  const txnCrossed = txnApplies && measured.transactions >= txnThreshold!;

  const crossed =
    logic === "both"
      ? salesApplies && txnApplies && salesCrossed && txnCrossed
      : salesCrossed || txnCrossed;

  const fraction = fractionOf(measured, logic, salesThreshold, txnThreshold);

  const status: EngineStatus = crossed
    ? "crossed"
    : fraction !== null && fraction >= approachingFraction
      ? "approaching"
      : "clear";

  return {
    status,
    fractionOfThreshold: fraction,
    thresholdSalesCents: salesApplies ? salesThreshold : null,
    thresholdTransactions: txnApplies ? txnThreshold : null,
  };
}

/**
 * Progress toward whichever threshold actually binds.
 *
 * - `sales_only` / `transactions_only` — the one that applies.
 * - `either` — the **maximum**. A seller crosses as soon as one does, so
 *   progress is governed by whichever they are closest to.
 * - `both` — the **minimum**. A seller crosses only when both do, so progress
 *   is governed by the laggard. Reporting the max here would show a meter at
 *   100% next to a status of `clear`, which reads as a bug in the product
 *   rather than as the rule doing its job.
 */
function fractionOf(
  measured: MeasuredTotals,
  logic: ThresholdLogic,
  salesThreshold: number | null,
  txnThreshold: number | null,
): number | null {
  const salesFraction =
    logic !== "transactions_only" && salesThreshold !== null && salesThreshold > 0
      ? measured.salesCents / salesThreshold
      : null;
  const txnFraction =
    logic !== "sales_only" && txnThreshold !== null && txnThreshold > 0
      ? measured.transactions / txnThreshold
      : null;

  if (salesFraction === null) return txnFraction;
  if (txnFraction === null) return salesFraction;
  return logic === "both"
    ? Math.min(salesFraction, txnFraction)
    : Math.max(salesFraction, txnFraction);
}
