// Reproducibility is a test, not a claim.
//
// This is the epic's additional verification bar, stated in the README:
//
//   > `reproducibility.test.ts` re-runs the pinned `ENGINE_VERSION` against a
//   > stored `inputs` payload and its `rule_id`, and asserts the stored
//   > `status`, `crossed_on`, and `registration_due_on` come back
//   > byte-identical. A change that breaks it is a breaking change and
//   > requires an `ENGINE_VERSION` bump, not a patched expectation.
//
// The vectors below are what a `nexus.determinations` row looks like on disk:
// the exact JSONB `inputs`, the rule that was in force, and the three fields
// the row committed to. They are frozen. **If one of these fails, do not edit
// the expectation.** Either the change was unintended, or it is a deliberate
// change to how a status is derived — in which case bump `ENGINE_VERSION`'s
// major and add a new vector alongside, leaving the old one asserting against
// the old version.

import { ENGINE_VERSION, evaluate } from "@nexus-worker/engine";
import type { DeterminationInputs, Rule } from "@saas/contracts/nexus";

interface StoredDetermination {
  readonly name: string;
  /** The `engine_version` column of the stored row. */
  readonly engineVersion: string;
  /** The rule the stored `rule_id` resolves to. */
  readonly rule: Rule;
  /** The `inputs` JSONB column, verbatim. */
  readonly inputs: DeterminationInputs;
  /** The three columns the row committed to. */
  readonly status: string;
  readonly crossedOn: string | null;
  readonly registrationDueOn: string | null;
  /** Also stored, and also part of the promise. */
  readonly measuredSalesCents: number;
  readonly measuredTransactions: number;
}

const STORED: readonly StoredDetermination[] = [
  {
    name: "TX crossed on a rolling window, deadline on the first of next month",
    engineVersion: "1.0.0",
    rule: {
      id: "rul_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      ruleSetId: "rst_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      ruleSetVersion: "2026.08.01",
      jurisdiction: "US-TX",
      effectiveFrom: "2019-10-01",
      effectiveTo: null,
      measurementBasis: "gross",
      measurementPeriod: "rolling_12m",
      measurementTimezone: "America/Chicago",
      salesThresholdCents: 50_000_000,
      transactionThreshold: null,
      thresholdLogic: "sales_only",
      marketplaceTreatment: "include",
      registrationDeadlineRule: { kind: "first_of_next_month" },
      notes: null,
    },
    inputs: {
      asOf: "2026-08-04T07:00:00.000Z",
      window: {
        start: "2025-08-05T05:00:00.000Z",
        end: "2026-08-05T05:00:00.000Z",
        startDate: "2025-08-05",
        endDate: "2026-08-05",
      },
      aggregate: {
        jurisdiction: "US-TX",
        directGrossCents: 48_930_012,
        directRetailCents: 48_930_012,
        directTaxableCents: 44_100_000,
        directTransactions: 2_140,
        marketplaceGrossCents: 3_400_500,
        marketplaceRetailCents: 3_400_500,
        marketplaceTaxableCents: 3_400_500,
        marketplaceTransactions: 190,
      },
      approachingFraction: 0.8,
    },
    status: "crossed",
    crossedOn: "2026-08-04",
    registrationDueOn: "2026-09-01",
    measuredSalesCents: 52_330_512,
    measuredTransactions: 2_330,
  },
  {
    name: "WA approaching under a 'both' rule, governed by the laggard",
    engineVersion: "1.0.0",
    rule: {
      id: "rul_11112222333344445555666677778888",
      ruleSetId: "rst_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      ruleSetVersion: "2026.08.01",
      jurisdiction: "US-WA",
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
      measurementBasis: "retail",
      measurementPeriod: "calendar_year",
      measurementTimezone: "America/Los_Angeles",
      salesThresholdCents: 10_000_000,
      transactionThreshold: 200,
      thresholdLogic: "both",
      marketplaceTreatment: "exclude",
      registrationDeadlineRule: { kind: "days_after_crossing", days: 30 },
      notes: null,
    },
    inputs: {
      asOf: "2026-08-04T07:00:00.000Z",
      window: {
        start: "2026-01-01T08:00:00.000Z",
        end: "2027-01-01T08:00:00.000Z",
        startDate: "2026-01-01",
        endDate: "2027-01-01",
      },
      aggregate: {
        jurisdiction: "US-WA",
        directGrossCents: 9_100_000,
        directRetailCents: 8_700_000,
        directTaxableCents: 8_000_000,
        directTransactions: 174,
        marketplaceGrossCents: 5_500_000,
        marketplaceRetailCents: 5_500_000,
        marketplaceTaxableCents: 5_500_000,
        marketplaceTransactions: 260,
      },
      approachingFraction: 0.8,
    },
    status: "approaching",
    crossedOn: null,
    registrationDueOn: null,
    measuredSalesCents: 8_700_000,
    measuredTransactions: 174,
  },
  {
    name: "OR no_obligation on a ledger with real sales in it",
    engineVersion: "1.0.0",
    rule: {
      id: "rul_aaaabbbbccccddddeeeeffff00001111",
      ruleSetId: "rst_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      ruleSetVersion: "2026.08.01",
      jurisdiction: "US-OR",
      effectiveFrom: "2018-06-21",
      effectiveTo: null,
      measurementBasis: "gross",
      measurementPeriod: "rolling_12m",
      measurementTimezone: "America/Los_Angeles",
      salesThresholdCents: null,
      transactionThreshold: null,
      thresholdLogic: "none",
      marketplaceTreatment: "include",
      registrationDeadlineRule: { kind: "none" },
      notes: "Oregon levies no general sales tax.",
    },
    inputs: {
      asOf: "2026-08-04T07:00:00.000Z",
      window: {
        start: "2025-08-05T07:00:00.000Z",
        end: "2026-08-05T07:00:00.000Z",
        startDate: "2025-08-05",
        endDate: "2026-08-05",
      },
      aggregate: {
        jurisdiction: "US-OR",
        directGrossCents: 210_000_00,
        directRetailCents: 210_000_00,
        directTaxableCents: 210_000_00,
        directTransactions: 8_400,
        marketplaceGrossCents: 0,
        marketplaceRetailCents: 0,
        marketplaceTaxableCents: 0,
        marketplaceTransactions: 0,
      },
      approachingFraction: 0.8,
    },
    status: "no_obligation",
    crossedOn: null,
    registrationDueOn: null,
    measuredSalesCents: 0,
    measuredTransactions: 0,
  },
  {
    name: "NY crossed at the New Year boundary — crossedOn is the local date",
    engineVersion: "1.0.0",
    rule: {
      id: "rul_deadbeefdeadbeefdeadbeefdeadbeef",
      ruleSetId: "rst_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      ruleSetVersion: "2026.08.01",
      jurisdiction: "US-NY",
      effectiveFrom: "2019-06-24",
      effectiveTo: null,
      measurementBasis: "gross",
      measurementPeriod: "rolling_12m",
      measurementTimezone: "America/New_York",
      salesThresholdCents: 50_000_000,
      transactionThreshold: 100,
      thresholdLogic: "both",
      marketplaceTreatment: "include",
      registrationDeadlineRule: { kind: "first_of_next_quarter" },
      notes: null,
    },
    inputs: {
      // 04:30Z on 1 January is 23:30 on 31 December in New York. The stored
      // crossedOn must be the LOCAL date, or the evidence names a day the
      // seller was not trading.
      asOf: "2026-01-01T04:30:00.000Z",
      window: {
        start: "2025-01-01T05:00:00.000Z",
        end: "2026-01-01T05:00:00.000Z",
        startDate: "2025-01-01",
        endDate: "2026-01-01",
      },
      aggregate: {
        jurisdiction: "US-NY",
        directGrossCents: 61_200_000,
        directRetailCents: 61_200_000,
        directTaxableCents: 55_000_000,
        directTransactions: 1_902,
        marketplaceGrossCents: 0,
        marketplaceRetailCents: 0,
        marketplaceTaxableCents: 0,
        marketplaceTransactions: 0,
      },
      approachingFraction: 0.8,
    },
    status: "crossed",
    crossedOn: "2025-12-31",
    registrationDueOn: "2026-01-01",
    measuredSalesCents: 61_200_000,
    measuredTransactions: 1_902,
  },
];

describe("reproducibility", () => {
  it("pins ENGINE_VERSION", () => {
    // The vectors below are all recorded under 1.0.0. If this changes without
    // a new set of vectors, the suite silently stops testing what it claims.
    expect(ENGINE_VERSION).toBe("1.0.0");
  });

  describe.each(STORED.map((s) => [s.name, s] as const))("%s", (_name, stored) => {
    it("was recorded under the version this suite pins", () => {
      expect(stored.engineVersion).toBe(ENGINE_VERSION);
    });

    it("re-derives status, crossedOn, and registrationDueOn identically", () => {
      const replayed = evaluate(stored.inputs, stored.rule);
      expect({
        status: replayed.status,
        crossedOn: replayed.crossedOn,
        registrationDueOn: replayed.registrationDueOn,
      }).toEqual({
        status: stored.status,
        crossedOn: stored.crossedOn,
        registrationDueOn: stored.registrationDueOn,
      });
    });

    it("re-derives the measured values identically", () => {
      const replayed = evaluate(stored.inputs, stored.rule);
      expect({
        measuredSalesCents: replayed.measuredSalesCents,
        measuredTransactions: replayed.measuredTransactions,
      }).toEqual({
        measuredSalesCents: stored.measuredSalesCents,
        measuredTransactions: stored.measuredTransactions,
      });
    });

    it("is deterministic across repeated evaluation", () => {
      // Same inputs, same answer, every time — including the object shape, so
      // a field that became undefined instead of null would fail here.
      const first = evaluate(stored.inputs, stored.rule);
      const second = evaluate(stored.inputs, stored.rule);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it("does not mutate its inputs", () => {
      // A determination's `inputs` column is read back years later. An engine
      // that mutated the object it was handed would corrupt the row it was
      // about to write.
      const before = JSON.stringify(stored.inputs);
      evaluate(stored.inputs, stored.rule);
      expect(JSON.stringify(stored.inputs)).toBe(before);
    });
  });

  it("covers a crossed, an approaching, a no_obligation, and a year-boundary vector", () => {
    // A reproducibility suite that only ever replays the happy path proves
    // very little. Assert the shape of the corpus itself.
    const statuses = new Set(STORED.map((s) => s.status));
    expect(statuses).toEqual(new Set(["crossed", "approaching", "no_obligation"]));
    expect(STORED.some((s) => s.crossedOn !== s.inputs.asOf.slice(0, 10))).toBe(true);
  });
});
