// Shared engine fixtures.
//
// Deliberately hand-written rather than generated: a reader checking whether a
// boundary test is asserting the right thing needs to see the numbers, and
// "$100,000" written as `100_000_00` cents is the clearest form of that.

import type {
  DeterminationInputs,
  JurisdictionAggregate,
  MeasurementWindow,
  Rule,
} from "@saas/contracts/nexus";

export const USD = (dollars: number): number => Math.round(dollars * 100);

/** A rule with sensible defaults; override only what a case is about. */
export function ruleFixture(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rul_texas",
    ruleSetId: "rst_synthetic",
    ruleSetVersion: "2026.08.01",
    jurisdiction: "US-TX",
    effectiveFrom: "2019-10-01",
    effectiveTo: null,
    measurementBasis: "gross",
    measurementPeriod: "rolling_12m",
    measurementTimezone: "America/Chicago",
    salesThresholdCents: USD(500_000),
    transactionThreshold: null,
    thresholdLogic: "sales_only",
    marketplaceTreatment: "include",
    registrationDeadlineRule: { kind: "first_of_next_month" },
    notes: null,
    ...overrides,
  };
}

export function aggregateFixture(
  overrides: Partial<JurisdictionAggregate> = {},
): JurisdictionAggregate {
  return {
    jurisdiction: "US-TX",
    directGrossCents: 0,
    directRetailCents: 0,
    directTaxableCents: 0,
    directTransactions: 0,
    marketplaceGrossCents: 0,
    marketplaceRetailCents: 0,
    marketplaceTaxableCents: 0,
    marketplaceTransactions: 0,
    ...overrides,
  };
}

export const WINDOW_2026: MeasurementWindow = {
  start: "2025-08-05T05:00:00.000Z",
  end: "2026-08-05T05:00:00.000Z",
  startDate: "2025-08-05",
  endDate: "2026-08-05",
};

export function inputsFixture(
  overrides: Partial<DeterminationInputs> = {},
): DeterminationInputs {
  return {
    asOf: "2026-08-04T12:00:00.000Z",
    window: WINDOW_2026,
    aggregate: aggregateFixture(),
    approachingFraction: 0.8,
    ...overrides,
  };
}
