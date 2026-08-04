// Basis selection and marketplace treatment.
//
// The database returns all three bases split by marketplace treatment in one
// grouped scan (design §5.1) and chooses nothing. This module chooses, because
// the choice is the rule's and the rule is data — putting the `FILTER` in SQL
// would bake one jurisdiction's answer into the query plan for all of them.
//
// Integer arithmetic only. Every value in and out is whole cents or a whole
// transaction count; there is no division and no rounding anywhere in this
// file, which is why an addition here cannot drift a seller across a line.

import type {
  JurisdictionAggregate,
  MeasuredTotals,
  Rule,
} from "@saas/contracts/nexus";

/**
 * What this rule measures, from this aggregate.
 *
 * Marketplace treatment is the half that moves sellers across thresholds they
 * never crossed, or hides ones they did (design §6.2). `"include"` counts
 * Amazon/Etsy sales toward the threshold; `"exclude"` does not. Both are real
 * state positions, and the same ledger gives different answers under each —
 * which is exactly what the explainer shows.
 */
export function measure(
  aggregate: JurisdictionAggregate,
  rule: Pick<Rule, "measurementBasis" | "marketplaceTreatment">,
): MeasuredTotals {
  const direct = directFor(aggregate, rule.measurementBasis);
  const marketplace = marketplaceFor(aggregate, rule.measurementBasis);

  if (rule.marketplaceTreatment === "exclude") {
    return {
      salesCents: direct.salesCents,
      transactions: direct.transactions,
    };
  }

  return {
    salesCents: direct.salesCents + marketplace.salesCents,
    transactions: direct.transactions + marketplace.transactions,
  };
}

function directFor(
  aggregate: JurisdictionAggregate,
  basis: Rule["measurementBasis"],
): MeasuredTotals {
  switch (basis) {
    case "gross":
      return { salesCents: aggregate.directGrossCents, transactions: aggregate.directTransactions };
    case "retail":
      return { salesCents: aggregate.directRetailCents, transactions: aggregate.directTransactions };
    case "taxable":
      return { salesCents: aggregate.directTaxableCents, transactions: aggregate.directTransactions };
    default: {
      const unreachable: never = basis;
      throw new RangeError(`Unknown measurement basis: ${String(unreachable)}`);
    }
  }
}

function marketplaceFor(
  aggregate: JurisdictionAggregate,
  basis: Rule["measurementBasis"],
): MeasuredTotals {
  switch (basis) {
    case "gross":
      return {
        salesCents: aggregate.marketplaceGrossCents,
        transactions: aggregate.marketplaceTransactions,
      };
    case "retail":
      return {
        salesCents: aggregate.marketplaceRetailCents,
        transactions: aggregate.marketplaceTransactions,
      };
    case "taxable":
      return {
        salesCents: aggregate.marketplaceTaxableCents,
        transactions: aggregate.marketplaceTransactions,
      };
    default: {
      const unreachable: never = basis;
      throw new RangeError(`Unknown measurement basis: ${String(unreachable)}`);
    }
  }
}

/** An aggregate of nothing. Used when a jurisdiction has no rows in a window —
 *  which must produce `clear`, not an absent card. */
export function emptyAggregate(jurisdiction: string): JurisdictionAggregate {
  return {
    jurisdiction,
    directGrossCents: 0,
    directRetailCents: 0,
    directTaxableCents: 0,
    directTransactions: 0,
    marketplaceGrossCents: 0,
    marketplaceRetailCents: 0,
    marketplaceTaxableCents: 0,
    marketplaceTransactions: 0,
  };
}
