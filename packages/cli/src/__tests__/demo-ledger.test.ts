// The demo ledger's outcomes are constructed, so they are asserted.
//
// `ledger.ts` claims Texas is crossed, Washington sits under its line until
// marketplace sales are counted, and the totals land on their targets. A demo
// whose claims are only in a comment is a demo that quietly stops being true
// the first time someone tunes a number. These tests are what keep the
// generator honest — and they are also the fastest way to retune it, because a
// changed target fails here rather than on a screen share.

import { describe, it, expect } from "vitest";

import {
  DEMO_PLAN,
  DEMO_NO_OBLIGATION,
  generateDemoLedger,
  trailingTwelveMonths,
} from "../demo/ledger.js";

const AS_OF = new Date("2026-08-04T12:00:00.000Z");

const OPTS = {
  asOf: AS_OF,
  shopifyChannelId: "chn_00000000000000000000000000000001",
  stripeChannelId: "chn_00000000000000000000000000000002",
};

const ledger = generateDemoLedger(OPTS);

describe("determinism", () => {
  it("produces an identical ledger for identical inputs", () => {
    const a = generateDemoLedger(OPTS);
    const b = generateDemoLedger(OPTS);
    expect(a).toEqual(b);
  });

  it("changes with the seed, so the jitter is real rather than constant", () => {
    const other = generateDemoLedger({ ...OPTS, seed: 999 });
    expect(other).not.toEqual(ledger);
    // …but the totals are seed-independent: the seed jitters *when* an order
    // lands, never *how much* it was. A demo whose numbers move with the seed
    // could not make the claims below.
    const base = trailingTwelveMonths(ledger, AS_OF, { includeMarketplace: false });
    const shifted = trailingTwelveMonths(other, AS_OF, { includeMarketplace: false });
    for (const plan of DEMO_PLAN) {
      const a = base.get(plan.jurisdiction) ?? 0;
      const b = shifted.get(plan.jurisdiction) ?? 0;
      // Within a month's worth — a seed change can move an order across a
      // month boundary at the edge of the window, and that is expected.
      expect(Math.abs(a - b)).toBeLessThan(plan.targetCents / 6);
    }
  });

  it("reads no clock — `asOf` is a parameter, and moving it moves the ledger", () => {
    const earlier = generateDemoLedger({
      ...OPTS,
      asOf: new Date("2026-02-04T12:00:00.000Z"),
    });
    expect(earlier).not.toEqual(ledger);
  });
});

describe("the ledger is well-formed", () => {
  it("contains no row dated after `asOf`", () => {
    for (const e of ledger) {
      expect(new Date(e.occurredAt).getTime()).toBeLessThanOrEqual(AS_OF.getTime());
    }
  });

  it("is ordered oldest-first, so a partial import is a prefix of history", () => {
    for (let i = 1; i < ledger.length; i += 1) {
      expect(ledger[i]!.occurredAt >= ledger[i - 1]!.occurredAt).toBe(true);
    }
  });

  it("uses integer cents everywhere — no float survives to the wire", () => {
    for (const e of ledger) {
      for (const cents of [e.grossCents, e.retailCents, e.taxableCents]) {
        expect(Number.isSafeInteger(cents)).toBe(true);
      }
      expect(Number.isSafeInteger(e.transactionCount)).toBe(true);
    }
  });

  it("gives every row a unique provider id, so the dedupe index is not doing the work", () => {
    const ids = ledger.map((e) => e.providerEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spans eighteen months, not twelve", () => {
    // A rolling-12m measurement over a ledger that begins exactly 12 months
    // ago cannot demonstrate that the window excludes anything.
    const oldest = new Date(ledger[0]!.occurredAt);
    const monthsBack =
      (AS_OF.getUTCFullYear() - oldest.getUTCFullYear()) * 12 +
      (AS_OF.getUTCMonth() - oldest.getUTCMonth());
    expect(monthsBack).toBeGreaterThanOrEqual(16);
  });
});

describe("the constructed outcomes", () => {
  const direct = trailingTwelveMonths(ledger, AS_OF, { includeMarketplace: false });
  const withMarketplace = trailingTwelveMonths(ledger, AS_OF, { includeMarketplace: true });

  it.each(DEMO_PLAN.map((p) => [p.jurisdiction, p] as const))(
    "%s lands on its trailing-12m target",
    (_code, plan) => {
      const actual = direct.get(plan.jurisdiction) ?? 0;
      // Within 8%: seasonality and the month-boundary clamp move a little
      // volume across the window edge, and pinning it exactly would make the
      // test brittle without making the demo better.
      expect(Math.abs(actual - plan.targetCents) / plan.targetCents).toBeLessThan(0.08);
    },
  );

  it("Texas is over its $500,000 line", () => {
    expect(direct.get("US-TX")!).toBeGreaterThan(500_000_00);
  });

  // THE demo screen. Same ledger, two lawful answers, differing only by the
  // state's own marketplace rule — which is the clearest possible statement
  // that this product measures rather than guesses.
  it("Washington is UNDER its $100,000 line on direct sales alone", () => {
    expect(direct.get("US-WA")!).toBeLessThan(100_000_00);
  });

  it("…and OVER it once marketplace-facilitated sales are counted", () => {
    expect(withMarketplace.get("US-WA")!).toBeGreaterThan(100_000_00);
  });

  it("California is over its line too — it demonstrates 'registered', not 'clear'", () => {
    expect(direct.get("US-CA")!).toBeGreaterThan(500_000_00);
  });

  it("Florida and Illinois stay clear, with real volume rather than none", () => {
    expect(direct.get("US-FL")!).toBeGreaterThan(0);
    expect(direct.get("US-FL")!).toBeLessThan(100_000_00);
    expect(direct.get("US-IL")!).toBeGreaterThan(0);
    expect(direct.get("US-IL")!).toBeLessThan(100_000_00);
  });

  it("New Hampshire carries real sales, so 'out of scope' is visibly not 'no data'", () => {
    // The out-of-scope card must be reachable with volume behind it. A seller
    // seeing "Out of scope" over an empty jurisdiction learns nothing.
    expect(direct.get(DEMO_NO_OBLIGATION.jurisdiction)!).toBeGreaterThan(50_000_00);
  });
});

describe("the reversal", () => {
  const refunds = ledger.filter((e) => e.kind === "refund");

  it("contains exactly one, and it points at a row that is in the ledger", () => {
    expect(refunds).toHaveLength(1);
    const refund = refunds[0]!;
    const original = ledger.find((e) => e.providerEventId === refund.reversesEventId);
    expect(original).toBeDefined();
    // The original must still be there, unchanged. A reversal that replaced
    // its original would be an edit, and the ledger does not do edits.
    expect(original!.kind).toBe("sale");
    expect(original!.grossCents).toBeGreaterThan(0);
  });

  it("is negative on every amount and on the transaction count", () => {
    const r = refunds[0]!;
    expect(r.grossCents).toBeLessThan(0);
    expect(r.retailCents).toBeLessThan(0);
    expect(r.taxableCents).toBeLessThan(0);
    // Counts reverse the same way amounts do, which is what makes a plain SUM
    // correct for the transaction-count thresholds.
    expect(r.transactionCount).toBe(-1);
  });

  it("is dated by the refund's own timestamp, later than the sale it reverses", () => {
    // §5.3 case 5: a refund reduces the window it lands in, which may not be
    // the window the sale landed in.
    const r = refunds[0]!;
    const original = ledger.find((e) => e.providerEventId === r.reversesEventId)!;
    expect(r.occurredAt > original.occurredAt).toBe(true);
  });
});

describe("attribution", () => {
  it("labels a minority of rows as a weaker fallback, rather than none", () => {
    const weak = ledger.filter((e) => e.jurisdictionSource === "billing_address");
    expect(weak.length).toBeGreaterThan(0);
    // R4 is only demonstrated if a fallback is visible on the board — but a
    // demo where most rows are weakly attributed misrepresents the product.
    expect(weak.length / ledger.length).toBeLessThan(0.15);
  });

  it("marks marketplace rows only where the plan calls for them", () => {
    const marketplaceJurisdictions = new Set(
      ledger.filter((e) => e.marketplaceFacilitated).map((e) => e.jurisdiction),
    );
    expect(marketplaceJurisdictions).toContain("US-WA");
    expect(marketplaceJurisdictions).toContain("US-TX");
    expect(marketplaceJurisdictions).not.toContain("US-IL");
  });
});
