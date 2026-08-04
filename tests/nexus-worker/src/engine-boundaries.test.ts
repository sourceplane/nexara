// The two §5.3 boundaries that are about how the ledger reaches the engine
// rather than about the engine's own arithmetic: refunds (case 5) and a
// mid-window rule change (case 3).

import { evaluate, evaluateSegmented } from "@nexus-worker/engine";
import { emptyAggregate } from "@nexus-worker/engine/measure";
import { rollingWindow, calendarYearWindow } from "@nexus-worker/engine/periods";
import { startOfDayInZone } from "@nexus-worker/engine/zones";

import { USD, aggregateFixture, inputsFixture, ruleFixture } from "./fixtures.js";

const CHICAGO = "America/Chicago";

describe("§5.3 case 5 — a refund reduces the window it lands in", () => {
  // The ledger stores a refund as a negative row dated by the PROVIDER's
  // refund timestamp, not by the original sale's. So a Q4 sale refunded in Q1
  // reduces Q1's measurement and leaves Q4's alone — which is what a state
  // would compute from the same facts, and which falls out of the schema for
  // free because SUM is sign-blind and the aggregate is per-window.

  const rule = ruleFixture({
    measurementPeriod: "calendar_year",
    salesThresholdCents: USD(100_000),
  });

  it("leaves the earlier period's total untouched", () => {
    // 2025: $120k of sales. The refund happened in 2026 and is not in this
    // window's rows at all.
    const outcome = evaluate(
      inputsFixture({
        asOf: "2025-12-15T12:00:00.000Z",
        window: calendarYearWindow(startOfDayInZone("2025-12-15", CHICAGO), CHICAGO),
        aggregate: aggregateFixture({
          directGrossCents: USD(120_000),
          directRetailCents: USD(120_000),
          directTaxableCents: USD(120_000),
          directTransactions: 400,
        }),
      }),
      rule,
    );
    expect(outcome.measuredSalesCents).toBe(USD(120_000));
    expect(outcome.status).toBe("crossed");
  });

  it("reduces the later period, and can pull it back below the line", () => {
    // 2026: $105k of sales and a −$40k refund of a 2025 order. The aggregate
    // the database returns is already netted, because the refund is a negative
    // row inside this window. $65k → clear.
    const outcome = evaluate(
      inputsFixture({
        asOf: "2026-03-01T12:00:00.000Z",
        window: calendarYearWindow(startOfDayInZone("2026-03-01", CHICAGO), CHICAGO),
        aggregate: aggregateFixture({
          directGrossCents: USD(105_000) - USD(40_000),
          directRetailCents: USD(105_000) - USD(40_000),
          directTaxableCents: USD(105_000) - USD(40_000),
          directTransactions: 350 - 1,
        }),
      }),
      rule,
    );
    expect(outcome.measuredSalesCents).toBe(USD(65_000));
    expect(outcome.status).toBe("clear");
  });

  it("handles a net-negative window without producing a negative fraction bug", () => {
    // A month of nothing but refunds is legal and the meter must not go
    // strange — a negative fraction should read as negative, not as NaN and
    // not as approaching.
    const outcome = evaluate(
      inputsFixture({
        aggregate: aggregateFixture({
          directGrossCents: -USD(5_000),
          directRetailCents: -USD(5_000),
          directTaxableCents: -USD(5_000),
          directTransactions: -20,
        }),
      }),
      ruleFixture({ salesThresholdCents: USD(100_000) }),
    );
    expect(outcome.status).toBe("clear");
    expect(outcome.fractionOfThreshold).toBeLessThan(0);
    expect(Number.isNaN(outcome.fractionOfThreshold!)).toBe(false);
  });

  it("nets a full reversal back to exactly zero", () => {
    // Integer cents, so a sale and its exact reversal cancel precisely. Under
    // floats this is where a residue of 0.000001 would appear and then
    // accumulate across a year of orders.
    const outcome = evaluate(
      inputsFixture({
        aggregate: aggregateFixture({
          directGrossCents: USD(1_234.56) - USD(1_234.56),
          directTransactions: 1 - 1,
        }),
      }),
      ruleFixture({ salesThresholdCents: USD(100_000) }),
    );
    expect(outcome.measuredSalesCents).toBe(0);
    expect(outcome.measuredTransactions).toBe(0);
  });
});

describe("§5.3 case 3 — a rule change mid-window splits the window", () => {
  // A state raises its threshold from $100k to $500k effective 1 July 2026,
  // and the seller is measured on the calendar year. Measuring the whole year
  // under either rule alone is wrong: under the old rule it over-reports, and
  // under the new one it under-reports the first half's exposure.
  //
  // The engine's contract is that the caller splits the window and hands one
  // (rule, inputs) pair per segment. The LATER rule governs the reported
  // position, because that is the rule in force today and the one a state
  // would apply — but the totals accumulate across the whole window, because a
  // seller does not get a fresh start because a threshold changed in July.

  const oldRule = ruleFixture({
    id: "rul_old",
    effectiveFrom: "2020-01-01",
    effectiveTo: "2026-07-01",
    measurementPeriod: "calendar_year",
    salesThresholdCents: USD(100_000),
  });
  const newRule = ruleFixture({
    id: "rul_new",
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    measurementPeriod: "calendar_year",
    salesThresholdCents: USD(500_000),
  });

  const firstHalf = inputsFixture({
    asOf: "2026-06-30T12:00:00.000Z",
    window: {
      start: "2026-01-01T06:00:00.000Z",
      end: "2026-07-01T05:00:00.000Z",
      startDate: "2026-01-01",
      endDate: "2026-07-01",
    },
    aggregate: aggregateFixture({
      directGrossCents: USD(180_000),
      directTransactions: 600,
    }),
  });

  const secondHalf = inputsFixture({
    asOf: "2026-11-01T12:00:00.000Z",
    window: {
      start: "2026-07-01T05:00:00.000Z",
      end: "2027-01-01T06:00:00.000Z",
      startDate: "2026-07-01",
      endDate: "2027-01-01",
    },
    aggregate: aggregateFixture({
      directGrossCents: USD(150_000),
      directTransactions: 500,
    }),
  });

  it("evaluates each segment under its own rule", () => {
    expect(evaluate(firstHalf, oldRule).status).toBe("crossed"); // 180k ≥ 100k
    expect(evaluate(secondHalf, newRule).status).toBe("clear"); // 150k < 500k
  });

  it("accumulates totals across the whole window", () => {
    const outcome = evaluateSegmented([
      { rule: oldRule, inputs: firstHalf },
      { rule: newRule, inputs: secondHalf },
    ]);
    expect(outcome.measuredSalesCents).toBe(USD(330_000));
    expect(outcome.measuredTransactions).toBe(1_100);
  });

  it("lets the later rule govern the reported position", () => {
    // $330k is over the old $100k line and under the new $500k one. The
    // position today is measured against the rule in force today.
    const outcome = evaluateSegmented([
      { rule: oldRule, inputs: firstHalf },
      { rule: newRule, inputs: secondHalf },
    ]);
    expect(outcome.status).toBe("clear");
    expect(outcome.thresholdSalesCents).toBe(USD(500_000));
  });

  it("keeps the crossing date from the segment that crossed", () => {
    // A seller who crossed in June did not un-cross because July's rule is
    // more generous — if the accumulated total still crosses, the ORIGINAL
    // date stands. Here the total crosses even the new $500k line.
    const bigSecondHalf = {
      ...secondHalf,
      aggregate: aggregateFixture({
        directGrossCents: USD(400_000),
        directTransactions: 900,
      }),
    };
    const outcome = evaluateSegmented([
      { rule: oldRule, inputs: firstHalf },
      { rule: newRule, inputs: bigSecondHalf },
    ]);
    expect(outcome.status).toBe("crossed");
    expect(outcome.measuredSalesCents).toBe(USD(580_000));
    // 2026-06-30T12:00Z is 2026-06-30 in Chicago — the first segment's asOf.
    expect(outcome.crossedOn).toBe("2026-06-30");
  });

  it("collapses to a single evaluation when only one rule was in force", () => {
    const single = evaluateSegmented([{ rule: newRule, inputs: secondHalf }]);
    expect(single).toEqual(evaluate(secondHalf, newRule));
  });

  it("refuses an empty segment list rather than inventing a position", () => {
    expect(() => evaluateSegmented([])).toThrow(/at least one segment/);
  });
});

describe("a jurisdiction with no rows at all", () => {
  it("is clear at zero, not absent", () => {
    // A state a seller has never shipped to still gets a card. An absent card
    // reads as "we are not watching", which is the opposite of the product.
    const outcome = evaluate(
      inputsFixture({ aggregate: emptyAggregate("US-VT") }),
      ruleFixture({ jurisdiction: "US-VT", salesThresholdCents: USD(100_000) }),
    );
    expect(outcome.status).toBe("clear");
    expect(outcome.measuredSalesCents).toBe(0);
    expect(outcome.fractionOfThreshold).toBe(0);
  });
});

describe("the engine uses the window it was given", () => {
  it("does not recompute the window from asOf", () => {
    // If the engine recomputed, a replay years later — when asOf is long past
    // — would measure a different span from the one the aggregate came from,
    // and the stored determination would stop reproducing. Here the stored
    // window deliberately disagrees with what asOf would produce today; the
    // outcome must be unaffected, because the engine never looks.
    const stale = inputsFixture({
      asOf: "2026-08-04T12:00:00.000Z",
      window: {
        start: "2001-01-01T00:00:00.000Z",
        end: "2001-02-01T00:00:00.000Z",
        startDate: "2001-01-01",
        endDate: "2001-02-01",
      },
      aggregate: aggregateFixture({ directGrossCents: USD(600_000) }),
    });
    const outcome = evaluate(stale, ruleFixture());
    expect(outcome.status).toBe("crossed");
    // And what a fresh computation WOULD have produced is different, proving
    // the assertion above is not vacuous.
    expect(rollingWindow(new Date(stale.asOf), CHICAGO).startDate).not.toBe(
      stale.window.startDate,
    );
  });

  it("rejects an unparseable asOf rather than silently using the epoch", () => {
    expect(() => evaluate(inputsFixture({ asOf: "yesterday" }), ruleFixture())).toThrow(
      /not a valid instant/,
    );
  });
});
