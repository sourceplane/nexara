// The determination engine.
//
// This directory is the product's only real IP and its only hard promise:
// given the same inputs and the same rule, this code returns the same answer,
// forever, on any machine. That is what a seller's determination record is
// worth when a state sends a notice years from now.
//
// The rules that keep the promise, and are enforced by
// `engine-purity.test.ts`:
//
//   * these files import **only types** from `@saas/contracts` — never
//     `@saas/db`, never `Env`, never `fetch`;
//   * every function is synchronous and total;
//   * there is no `Date.now()`, no `new Date()` without an argument, and no
//     `Math.random()`. `asOf` is always a parameter, because a function that
//     reads the clock cannot be replayed.
//
// `ENGINE_VERSION` is semver and it is a contract. Any change to how a status
// is derived is a **major** bump; stored determinations continue to name the
// version that produced them, and `reproducibility.test.ts` fails if a change
// moves an answer without one.

import type {
  DeterminationInputs,
  DeterminationOutcome,
  Rule,
} from "@saas/contracts/nexus";

import { registrationDueOn } from "./deadline.js";
import { measure } from "./measure.js";
import { DEFAULT_APPROACHING_FRACTION, evaluateThreshold } from "./threshold.js";
import { dateInZone } from "./zones.js";

export const ENGINE_VERSION = "1.0.0";

export {
  addDays,
  addMonths,
  endOfMonth,
  isCivilDate,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  yearOf,
} from "./dates.js";
export { assertKnownTimeZone, dateInZone, startOfDayInZone } from "./zones.js";
export {
  calendarYearWindow,
  groupByWindow,
  previousCalendarYearWindow,
  rollingWindow,
  windowFor,
} from "./periods.js";
export { emptyAggregate, measure } from "./measure.js";
export {
  DEFAULT_APPROACHING_FRACTION,
  evaluateThreshold,
  type ThresholdVerdict,
} from "./threshold.js";
export { registrationDueOn } from "./deadline.js";

/**
 * Evaluate one jurisdiction against one rule.
 *
 * `inputs.window` is **used, not recomputed**. The caller computed it with
 * `windowFor` and the database was queried with those exact boundaries; if
 * this function recomputed the window it would be answering a question the
 * aggregate did not measure, and a replay years later — when `asOf` is long
 * past — would silently measure a different span.
 */
export function evaluate(
  inputs: DeterminationInputs,
  rule: Rule,
): DeterminationOutcome {
  const asOf = new Date(inputs.asOf);
  if (Number.isNaN(asOf.getTime())) {
    throw new RangeError(`inputs.asOf is not a valid instant: ${inputs.asOf}`);
  }

  const approachingFraction =
    typeof inputs.approachingFraction === "number" &&
    inputs.approachingFraction > 0
      ? inputs.approachingFraction
      : DEFAULT_APPROACHING_FRACTION;

  const measured = measure(inputs.aggregate, rule);
  const verdict = evaluateThreshold(measured, rule, approachingFraction);

  // `"no_obligation"` is terminal. No measurement is reported against a
  // threshold that does not exist — reporting 0 measured against null would
  // let a UI render a meter, and there is nothing to meter.
  if (verdict.status === "no_obligation") {
    return {
      status: "no_obligation",
      measuredSalesCents: 0,
      measuredTransactions: 0,
      thresholdSalesCents: null,
      thresholdTransactions: null,
      crossedOn: null,
      registrationDueOn: null,
      fractionOfThreshold: null,
    };
  }

  // The jurisdiction-local date of `asOf` — the date on which the measurement
  // was first observed to cross, not a claim about the legal instant of
  // crossing. See `DeterminationOutcome.crossedOn`; the console says the same
  // thing in words.
  const crossedOn =
    verdict.status === "crossed"
      ? dateInZone(asOf, rule.measurementTimezone)
      : null;

  return {
    status: verdict.status,
    measuredSalesCents: measured.salesCents,
    measuredTransactions: measured.transactions,
    thresholdSalesCents: verdict.thresholdSalesCents,
    thresholdTransactions: verdict.thresholdTransactions,
    crossedOn,
    registrationDueOn:
      crossedOn === null
        ? null
        : registrationDueOn(crossedOn, rule.registrationDeadlineRule),
    fractionOfThreshold: verdict.fractionOfThreshold,
  };
}

/**
 * Evaluate a window that a rule change splits (design §5.3 case 3).
 *
 * When a rule's `effectiveFrom` falls inside the measurement window, the
 * window has two rules in force over different parts of it, and measuring the
 * whole span under either one is wrong. Each segment is evaluated under its
 * own rule against its own aggregate, and the **later** segment's rule governs
 * the reported position — that is the rule in force today, and it is the one a
 * state would apply.
 *
 * The caller supplies one `(rule, inputs)` pair per segment, ordered oldest
 * first; the aggregates are per-segment, so summing them would be the caller
 * re-deriving what it already has.
 */
export function evaluateSegmented(
  segments: ReadonlyArray<{ rule: Rule; inputs: DeterminationInputs }>,
): DeterminationOutcome {
  if (segments.length === 0) {
    throw new RangeError("evaluateSegmented requires at least one segment");
  }

  const outcomes = segments.map((s) => evaluate(s.inputs, s.rule));
  const governing = outcomes[outcomes.length - 1]!;
  const governingRule = segments[segments.length - 1]!.rule;

  if (governing.status === "no_obligation") {
    return governing;
  }

  // Totals accumulate across the whole window; the governing rule decides what
  // they mean. A seller does not get a fresh start because a threshold changed
  // mid-year.
  const measuredSalesCents = outcomes.reduce(
    (sum, o) => sum + o.measuredSalesCents,
    0,
  );
  const measuredTransactions = outcomes.reduce(
    (sum, o) => sum + o.measuredTransactions,
    0,
  );

  const verdict = evaluateThreshold(
    { salesCents: measuredSalesCents, transactions: measuredTransactions },
    governingRule,
    segments[segments.length - 1]!.inputs.approachingFraction,
  );

  // The crossing date is the earliest segment that reported one — a seller who
  // crossed in March did not un-cross because a later segment was evaluated.
  const firstCrossing = outcomes.find((o) => o.crossedOn !== null)?.crossedOn ?? null;
  const crossedOn =
    verdict.status === "crossed"
      ? (firstCrossing ??
        dateInZone(
          new Date(segments[segments.length - 1]!.inputs.asOf),
          governingRule.measurementTimezone,
        ))
      : null;

  return {
    status: verdict.status,
    measuredSalesCents,
    measuredTransactions,
    thresholdSalesCents: verdict.thresholdSalesCents,
    thresholdTransactions: verdict.thresholdTransactions,
    crossedOn,
    registrationDueOn:
      crossedOn === null
        ? null
        : registrationDueOn(crossedOn, governingRule.registrationDeadlineRule),
    fractionOfThreshold: verdict.fractionOfThreshold,
  };
}
