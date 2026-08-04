// Registration deadlines — every variant of the tagged union, and the month
// and year boundaries where each one is easiest to get wrong.

import { registrationDueOn } from "@nexus-worker/engine/deadline";
import { evaluate } from "@nexus-worker/engine";

import { USD, aggregateFixture, inputsFixture, ruleFixture } from "./fixtures.js";

describe("registrationDueOn", () => {
  it.each([
    // days_after_crossing
    ["30 days, mid-month", "2026-03-04", { kind: "days_after_crossing", days: 30 }, "2026-04-03"],
    ["60 days across a year end", "2026-12-01", { kind: "days_after_crossing", days: 60 }, "2027-01-30"],
    ["30 days from a leap day", "2024-02-29", { kind: "days_after_crossing", days: 30 }, "2024-03-30"],
    ["0 days is due the same day", "2026-05-05", { kind: "days_after_crossing", days: 0 }, "2026-05-05"],

    // first_of_next_month
    ["first of next month", "2026-03-04", { kind: "first_of_next_month" }, "2026-04-01"],
    ["from the last day of a month", "2026-01-31", { kind: "first_of_next_month" }, "2026-02-01"],
    ["across a year end", "2026-12-15", { kind: "first_of_next_month" }, "2027-01-01"],
    ["from 31 Jan does not skip February", "2026-01-31", { kind: "first_of_next_month" }, "2026-02-01"],

    // end_of_next_month
    ["end of next month", "2026-03-04", { kind: "end_of_next_month" }, "2026-04-30"],
    ["end of next month lands on 28 Feb", "2026-01-15", { kind: "end_of_next_month" }, "2026-02-28"],
    ["end of next month lands on 29 Feb in a leap year", "2024-01-15", { kind: "end_of_next_month" }, "2024-02-29"],
    ["end of next month across a year end", "2026-12-15", { kind: "end_of_next_month" }, "2027-01-31"],

    // first_of_next_quarter
    ["Q1 → Q2", "2026-02-14", { kind: "first_of_next_quarter" }, "2026-04-01"],
    ["Q2 → Q3", "2026-06-30", { kind: "first_of_next_quarter" }, "2026-07-01"],
    ["Q3 → Q4", "2026-07-01", { kind: "first_of_next_quarter" }, "2026-10-01"],
    ["Q4 wraps the year", "2026-11-20", { kind: "first_of_next_quarter" }, "2027-01-01"],
    ["the first day of a quarter still goes to the NEXT one", "2026-04-01", { kind: "first_of_next_quarter" }, "2026-07-01"],

    // first_of_month_after_days
    ["30 days then the 1st", "2026-03-04", { kind: "first_of_month_after_days", days: 30 }, "2026-05-01"],
    ["the days push it into the next month", "2026-03-25", { kind: "first_of_month_after_days", days: 30 }, "2026-05-01"],
    ["and can cross a year end", "2026-12-20", { kind: "first_of_month_after_days", days: 30 }, "2027-02-01"],
  ] as const)("%s", (_name, crossedOn, rule, expected) => {
    expect(registrationDueOn(crossedOn, rule)).toBe(expected);
  });

  it("returns null when the jurisdiction defines no deadline", () => {
    // Null must not render as "due today", which is what a naive
    // `?? crossedOn` fallback would produce.
    expect(registrationDueOn("2026-03-04", { kind: "none" })).toBeNull();
  });

  it("rejects a negative or fractional day count", () => {
    expect(() =>
      registrationDueOn("2026-03-04", { kind: "days_after_crossing", days: -1 }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      registrationDueOn("2026-03-04", { kind: "days_after_crossing", days: 1.5 }),
    ).toThrow(/non-negative integer/);
  });

  it("is total over the union — an unknown kind throws rather than returning null", () => {
    // A silent null here is a missed registration deadline, which is the exact
    // harm the product exists to prevent.
    expect(() =>
      registrationDueOn("2026-03-04", { kind: "whenever" } as never),
    ).toThrow(/Unknown registration deadline rule/);
  });
});

describe("deadlines through the engine", () => {
  const crossingAggregate = aggregateFixture({
    directGrossCents: USD(600_000),
    directRetailCents: USD(600_000),
    directTaxableCents: USD(600_000),
    directTransactions: 2_000,
  });

  it("computes the deadline from the crossing date, not from asOf's UTC date", () => {
    // asOf is 2026-01-01T04:30Z, which is 2025-12-31 in Chicago. The deadline
    // must run from the crossing date IN THE JURISDICTION, so the first of the
    // next month is 1 January 2026, not 1 February.
    const outcome = evaluate(
      inputsFixture({
        asOf: "2026-01-01T04:30:00.000Z",
        aggregate: crossingAggregate,
      }),
      ruleFixture({ registrationDeadlineRule: { kind: "first_of_next_month" } }),
    );
    expect(outcome.crossedOn).toBe("2025-12-31");
    expect(outcome.registrationDueOn).toBe("2026-01-01");
  });

  it("sets neither crossedOn nor registrationDueOn while clear", () => {
    const outcome = evaluate(inputsFixture(), ruleFixture());
    expect(outcome.status).toBe("clear");
    expect(outcome.crossedOn).toBeNull();
    expect(outcome.registrationDueOn).toBeNull();
  });

  it("sets crossedOn but not registrationDueOn under a 'none' deadline rule", () => {
    const outcome = evaluate(
      inputsFixture({ aggregate: crossingAggregate }),
      ruleFixture({ registrationDeadlineRule: { kind: "none" } }),
    );
    expect(outcome.status).toBe("crossed");
    expect(outcome.crossedOn).not.toBeNull();
    expect(outcome.registrationDueOn).toBeNull();
  });
});
