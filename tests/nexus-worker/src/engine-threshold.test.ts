// Threshold logic and marketplace treatment — design §5.3 cases 6, 7, and 8.

import {
  DEFAULT_APPROACHING_FRACTION,
  evaluateThreshold,
} from "@nexus-worker/engine/threshold";
import { measure } from "@nexus-worker/engine/measure";
import { evaluate } from "@nexus-worker/engine";

import { USD, aggregateFixture, inputsFixture, ruleFixture } from "./fixtures.js";

describe("threshold logic", () => {
  const HUNDRED_K = USD(100_000);

  it.each([
    // logic, sales, txns, expected — the full truth table, written out rather
    // than generated, because a generated table cannot be read against a
    // statute.
    ["sales_only", USD(99_999), 500, "clear"],
    ["sales_only", USD(100_000), 0, "crossed"],
    ["sales_only", USD(150_000), 0, "crossed"],
    ["transactions_only", USD(500_000), 199, "clear"],
    ["transactions_only", 0, 200, "crossed"],
    ["either", USD(100_000), 0, "crossed"],
    ["either", 0, 200, "crossed"],
    ["either", USD(99_999), 199, "clear"],
    ["both", USD(100_000), 200, "crossed"],
    ["both", USD(100_000), 199, "clear"],
    ["both", USD(99_999), 200, "clear"],
  ] as const)("%s with %d cents and %d txns → %s", (logic, salesCents, transactions, expected) => {
    const verdict = evaluateThreshold(
      { salesCents, transactions },
      {
        thresholdLogic: logic,
        salesThresholdCents: logic === "transactions_only" ? null : HUNDRED_K,
        transactionThreshold: logic === "sales_only" ? null : 200,
      },
      // Turn approaching off so this table asserts crossing alone.
      99,
    );
    expect(verdict.status).toBe(expected);
  });

  it("§5.3 case 6 — 'both' with only sales crossing is NOT crossed", () => {
    // The case that costs money if you get it wrong in the other direction:
    // telling a seller they must register in a state that requires both tests
    // to be met.
    const verdict = evaluateThreshold(
      { salesCents: USD(250_000), transactions: 12 },
      { thresholdLogic: "both", salesThresholdCents: HUNDRED_K, transactionThreshold: 200 },
    );
    expect(verdict.status).not.toBe("crossed");
    // And the meter reports the LAGGARD, not the leader — a meter pinned at
    // 250% next to a status of "clear" reads as a bug in the product rather
    // than as the rule doing its job.
    expect(verdict.fractionOfThreshold).toBeCloseTo(12 / 200, 10);
  });

  it("'either' reports the leader, because that is what binds first", () => {
    const verdict = evaluateThreshold(
      { salesCents: USD(90_000), transactions: 12 },
      { thresholdLogic: "either", salesThresholdCents: HUNDRED_K, transactionThreshold: 200 },
    );
    expect(verdict.fractionOfThreshold).toBeCloseTo(0.9, 10);
    expect(verdict.status).toBe("approaching");
  });

  it("meets-or-exceeds: exactly at the line is crossed", () => {
    // Documented engine convention, pinned by ENGINE_VERSION. The
    // conservative direction for a monitoring product: a false "at the line"
    // costs a conversation with an accountant, the reverse costs penalties.
    const verdict = evaluateThreshold(
      { salesCents: HUNDRED_K, transactions: 0 },
      { thresholdLogic: "sales_only", salesThresholdCents: HUNDRED_K, transactionThreshold: null },
    );
    expect(verdict.status).toBe("crossed");
  });

  it("one cent short is not crossed", () => {
    const verdict = evaluateThreshold(
      { salesCents: HUNDRED_K - 1, transactions: 0 },
      { thresholdLogic: "sales_only", salesThresholdCents: HUNDRED_K, transactionThreshold: null },
    );
    expect(verdict.status).not.toBe("crossed");
  });

  it("becomes approaching at exactly the default fraction", () => {
    const verdict = evaluateThreshold(
      { salesCents: USD(80_000), transactions: 0 },
      { thresholdLogic: "sales_only", salesThresholdCents: HUNDRED_K, transactionThreshold: null },
    );
    expect(DEFAULT_APPROACHING_FRACTION).toBe(0.8);
    expect(verdict.status).toBe("approaching");
  });

  it("does not clamp the fraction above 1", () => {
    // A seller at 240% of the line should see 240%. Clamping would make a
    // wildly over-threshold position look identical to a marginal one.
    const verdict = evaluateThreshold(
      { salesCents: USD(240_000), transactions: 0 },
      { thresholdLogic: "sales_only", salesThresholdCents: HUNDRED_K, transactionThreshold: null },
    );
    expect(verdict.fractionOfThreshold).toBeCloseTo(2.4, 10);
  });

  it("refuses a rule that names a test it carries no threshold for", () => {
    // The DB constraint makes such a row unwritable; this is the belt to that
    // braces. An engine that divides by null renders a confident 0%.
    expect(() =>
      evaluateThreshold(
        { salesCents: USD(1), transactions: 1 },
        { thresholdLogic: "sales_only", salesThresholdCents: null, transactionThreshold: 200 },
      ),
    ).toThrow(/no usable threshold/);
  });
});

describe("§5.3 case 8 — threshold_logic 'none' is terminal", () => {
  const noThresholdRule = ruleFixture({
    jurisdiction: "US-OR",
    thresholdLogic: "none",
    salesThresholdCents: null,
    transactionThreshold: null,
    measurementTimezone: "America/Los_Angeles",
  });

  it("returns no_obligation on a ledger with substantial sales in it", () => {
    // Oregon levies no state sales tax. A seller with $2M of Oregon sales has
    // no obligation — which is emphatically not the same statement as "clear
    // at 0%", and a board that renders them alike has lost the distinction the
    // rule row exists to carry.
    const outcome = evaluate(
      inputsFixture({
        aggregate: aggregateFixture({
          jurisdiction: "US-OR",
          directGrossCents: USD(2_000_000),
          directRetailCents: USD(2_000_000),
          directTaxableCents: USD(2_000_000),
          directTransactions: 8_400,
        }),
      }),
      noThresholdRule,
    );

    expect(outcome.status).toBe("no_obligation");
    expect(outcome.fractionOfThreshold).toBeNull();
    expect(outcome.crossedOn).toBeNull();
    expect(outcome.registrationDueOn).toBeNull();
  });

  it("reports no threshold and no measurement, so nothing can render a meter", () => {
    const outcome = evaluate(
      inputsFixture({
        aggregate: aggregateFixture({ directGrossCents: USD(2_000_000) }),
      }),
      noThresholdRule,
    );
    expect(outcome.thresholdSalesCents).toBeNull();
    expect(outcome.thresholdTransactions).toBeNull();
    expect(outcome.measuredSalesCents).toBe(0);
  });

  it("never divides by a null threshold", () => {
    const verdict = evaluateThreshold(
      { salesCents: USD(2_000_000), transactions: 8_400 },
      { thresholdLogic: "none", salesThresholdCents: null, transactionThreshold: null },
    );
    expect(verdict.fractionOfThreshold).toBeNull();
    expect(Number.isNaN(verdict.fractionOfThreshold as unknown as number)).toBe(false);
  });
});

describe("§5.3 case 7 — marketplace treatment flips the outcome", () => {
  // One ledger, one set of numbers, two states' positions. Washington's
  // threshold is $100,000 of retail sales; this seller has $70k direct and
  // $45k through a marketplace.
  const aggregate = aggregateFixture({
    jurisdiction: "US-WA",
    directGrossCents: USD(70_000),
    directRetailCents: USD(70_000),
    directTaxableCents: USD(70_000),
    directTransactions: 310,
    marketplaceGrossCents: USD(45_000),
    marketplaceRetailCents: USD(45_000),
    marketplaceTaxableCents: USD(45_000),
    marketplaceTransactions: 190,
  });

  const base = {
    jurisdiction: "US-WA",
    measurementBasis: "retail",
    thresholdLogic: "sales_only",
    salesThresholdCents: USD(100_000),
    transactionThreshold: null,
    measurementTimezone: "America/Los_Angeles",
  } as const;

  it("crosses when marketplace sales are included", () => {
    const outcome = evaluate(
      inputsFixture({ aggregate }),
      ruleFixture({ ...base, marketplaceTreatment: "include" }),
    );
    expect(outcome.measuredSalesCents).toBe(USD(115_000));
    expect(outcome.status).toBe("crossed");
  });

  it("does not cross when they are excluded — same ledger, only the rule changed", () => {
    const outcome = evaluate(
      inputsFixture({ aggregate }),
      ruleFixture({ ...base, marketplaceTreatment: "exclude" }),
    );
    expect(outcome.measuredSalesCents).toBe(USD(70_000));
    expect(outcome.status).toBe("clear");
  });

  it("carries transaction counts through the same treatment", () => {
    // Getting this half right — amounts filtered, counts not — is the subtle
    // version of the bug, and it only shows up under a 'both' rule.
    expect(
      measure(aggregate, { measurementBasis: "retail", marketplaceTreatment: "exclude" }),
    ).toEqual({ salesCents: USD(70_000), transactions: 310 });
    expect(
      measure(aggregate, { measurementBasis: "retail", marketplaceTreatment: "include" }),
    ).toEqual({ salesCents: USD(115_000), transactions: 500 });
  });
});

describe("measurement basis selection", () => {
  const aggregate = aggregateFixture({
    directGrossCents: USD(120_000),
    directRetailCents: USD(110_000),
    directTaxableCents: USD(90_000),
    directTransactions: 400,
  });

  it.each([
    ["gross", USD(120_000), "crossed"],
    ["retail", USD(110_000), "crossed"],
    ["taxable", USD(90_000), "approaching"],
  ] as const)(
    "%s measures %d cents and lands on %s",
    (basis, expectedCents, expectedStatus) => {
      // The same order contributes a different amount to each basis, which is
      // why all three are captured at ingest rather than derived on read.
      const outcome = evaluate(
        inputsFixture({ aggregate }),
        ruleFixture({
          measurementBasis: basis,
          salesThresholdCents: USD(100_000),
          marketplaceTreatment: "exclude",
        }),
      );
      expect(outcome.measuredSalesCents).toBe(expectedCents);
      expect(outcome.status).toBe(expectedStatus);
    },
  );
});
