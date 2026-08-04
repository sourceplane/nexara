// Measurement windows. Three of them, and every one is half-open.
//
// Design §5.3 case 1: "Rolling-twelve-month window is half-open:
// `>= start AND < end`. Never `BETWEEN`." Every window this module produces
// obeys that, and the aggregation query in `@saas/db/nexus` compares
// `occurred_at >= $start AND occurred_at < $end` to match.
//
// The window is computed from the jurisdiction's calendar, then expressed as
// UTC instants for the query. Both are returned: the instants are what the
// database compares against, the dates are what a reader of the evidence
// recognises, and the console must not have to re-derive one from the other.

import type { MeasurementPeriod, MeasurementWindow } from "@saas/contracts/nexus";

import { addDays, addMonths, startOfYear, yearOf } from "./dates.js";
import { assertKnownTimeZone, dateInZone, startOfDayInZone } from "./zones.js";

/**
 * The trailing twelve months, **including the day of `asOf`**.
 *
 * `[D − 12 months + 1 day, D + 1 day)` in the jurisdiction's calendar, where
 * `D` is `asOf`'s local date. For D = 2026-08-04 that is 2025-08-05 through
 * 2026-08-04 inclusive — exactly twelve months of days, ending today.
 *
 * The `+ 1 day` on both ends is not decoration. A window of
 * `[D − 12 months, D)` excludes today, and a product whose entire promise is
 * "says so on the day it is crossed" cannot measure a window that ends
 * yesterday.
 */
export function rollingWindow(asOf: Date, timeZone: string): MeasurementWindow {
  const today = dateInZone(asOf, timeZone);
  const startDate = addDays(addMonths(today, -12), 1);
  const endDate = addDays(today, 1);
  return build(startDate, endDate, timeZone);
}

/** The calendar year `asOf` falls in, in the jurisdiction's calendar. */
export function calendarYearWindow(asOf: Date, timeZone: string): MeasurementWindow {
  const year = yearOf(dateInZone(asOf, timeZone));
  return build(startOfYear(year), startOfYear(year + 1), timeZone);
}

/**
 * The calendar year **before** the one `asOf` falls in.
 *
 * On 1 January the answer changes discontinuously — a seller who was measured
 * against all of 2026 is now measured against all of 2025 — and that is
 * correct, not a bug (design §5.3 case 2). States that use this basis
 * genuinely do reset on the turn of the year, and a product that smoothed it
 * would be reporting something no state asked for.
 */
export function previousCalendarYearWindow(
  asOf: Date,
  timeZone: string,
): MeasurementWindow {
  const year = yearOf(dateInZone(asOf, timeZone));
  return build(startOfYear(year - 1), startOfYear(year), timeZone);
}

/** Dispatch on the rule's declared period. Total over the union. */
export function windowFor(
  period: MeasurementPeriod,
  asOf: Date,
  timeZone: string,
): MeasurementWindow {
  switch (period) {
    case "rolling_12m":
      return rollingWindow(asOf, timeZone);
    case "calendar_year":
      return calendarYearWindow(asOf, timeZone);
    case "previous_calendar_year":
      return previousCalendarYearWindow(asOf, timeZone);
    default: {
      // Exhaustiveness: adding a period to the contract without handling it
      // here is a compile error, not a runtime surprise.
      const unreachable: never = period;
      throw new RangeError(`Unknown measurement period: ${String(unreachable)}`);
    }
  }
}

/**
 * Group jurisdictions by the window they need (design §5.2).
 *
 * Measurement periods differ per jurisdiction but there are only three of
 * them, and jurisdictions in the same period *and the same zone* share a
 * window exactly. The evaluator issues one aggregate query per distinct
 * window — in practice a handful, covering all forty-eight states. A
 * per-jurisdiction query loop is the obvious wrong answer and is called out
 * here so nobody writes it.
 *
 * The key is `period|timeZone|start|end`; the caller reads `window` off the
 * group rather than recomputing it.
 */
export function groupByWindow<T extends { measurementPeriod: MeasurementPeriod; measurementTimezone: string }>(
  rules: readonly T[],
  asOf: Date,
): Array<{ key: string; window: MeasurementWindow; rules: T[] }> {
  const groups = new Map<string, { key: string; window: MeasurementWindow; rules: T[] }>();
  for (const rule of rules) {
    const window = windowFor(rule.measurementPeriod, asOf, rule.measurementTimezone);
    const key = `${rule.measurementPeriod}|${rule.measurementTimezone}|${window.start}|${window.end}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rules.push(rule);
    } else {
      groups.set(key, { key, window, rules: [rule] });
    }
  }
  // Stable order so a replay of the same rule set issues the same queries in
  // the same sequence — which is what makes a slow evaluation debuggable.
  return [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function build(startDate: string, endDate: string, timeZone: string): MeasurementWindow {
  assertKnownTimeZone(timeZone);
  return {
    start: startOfDayInZone(startDate, timeZone).toISOString(),
    end: startOfDayInZone(endDate, timeZone).toISOString(),
    startDate,
    // The window is half-open, so `endDate` is the first day NOT measured.
    // Reported as-is rather than as `endDate − 1`: the console labels it "up
    // to, not including", and an off-by-one here would be invisible in the UI
    // and wrong in the evidence.
    endDate,
  };
}
