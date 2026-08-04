// Registration deadlines.
//
// Once a threshold is crossed, states give a seller some window before they
// must be registered. The forms differ — "the first of the following month",
// "30 days", "the next quarter" — and each is a variant of the tagged union
// `RegistrationDeadlineRule`, so this function is total over it rather than
// parsing free text.
//
// Pure civil-date arithmetic: in a date, out a date. No timezone is needed
// because the crossing date has already been resolved in the jurisdiction's
// calendar by `zones.ts`, and a deadline expressed in days or months does not
// re-enter instant space.

import type { RegistrationDeadlineRule } from "@saas/contracts/nexus";

import {
  addDays,
  addMonths,
  endOfMonth,
  startOfMonth,
  startOfQuarter,
} from "./dates.js";

/**
 * When the seller must be registered, given the date they crossed.
 *
 * Returns null when the rule defines no deadline — which is a real answer for
 * some jurisdictions and must not be rendered as "due today".
 */
export function registrationDueOn(
  crossedOn: string,
  rule: RegistrationDeadlineRule,
): string | null {
  switch (rule.kind) {
    case "none":
      return null;

    case "days_after_crossing":
      return addDays(crossedOn, requirePositiveDays(rule.days));

    case "first_of_next_month":
      return addMonths(startOfMonth(crossedOn), 1);

    case "end_of_next_month":
      return endOfMonth(addMonths(startOfMonth(crossedOn), 1));

    case "first_of_next_quarter":
      // Quarter starts are the 1st of Jan/Apr/Jul/Oct, so "+3 months from the
      // start of this quarter" is the start of the next one, and it wraps the
      // year correctly without a special case for Q4.
      return addMonths(startOfQuarter(crossedOn), 3);

    case "first_of_month_after_days": {
      // "You have N days, and then it is due at the start of the following
      // month" — the two-part form several states use. Composed from the
      // simpler rules rather than reimplemented, so a fix to either applies
      // here too.
      const settled = addDays(crossedOn, requirePositiveDays(rule.days));
      return addMonths(startOfMonth(settled), 1);
    }

    default: {
      // Exhaustiveness: a new variant in the contract is a compile error here,
      // not a deadline silently returned as null in production.
      const unreachable: never = rule;
      throw new RangeError(
        `Unknown registration deadline rule: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

function requirePositiveDays(days: number): number {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`Deadline rule days must be a non-negative integer, got ${days}`);
  }
  return days;
}
