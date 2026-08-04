// The demo tenant's ledger, generated rather than fixtured.
//
// NX9 asks for "a seeded 18-month, six-jurisdiction ledger" that tells the
// product's whole story without a narrator. Three decisions shape this file,
// and each is about honesty rather than convenience:
//
//   1. **It is generated deterministically, with no clock and no RNG.**
//      `Math.random()` would make the demo different every time it is seeded,
//      so "Texas crossed" would be luck rather than a property. The generator
//      is a pure function of `(asOf, seed)` — same inputs, same ledger, every
//      time — which is the same discipline the determination engine follows
//      and for the same reason.
//
//   2. **It is imported through the product's own public API**, not written
//      into the database by a seeding backdoor. A demo that used a private
//      path would prove the demo works; this proves the *import* works, and
//      the import is what a real customer's first day looks like.
//
//   3. **The outcomes are constructed, and the file says which.** Texas is
//      meant to be crossed; Washington is meant to sit just under its line
//      with enough marketplace volume that the outcome flips when the rule
//      flips. Those are the two screens worth showing anyone, and pretending
//      they emerged by accident from random data would be a small lie in the
//      one place this product cannot afford one.
//
// The amounts below are integer cents throughout. There is no float in this
// file, for the same reason there is none anywhere else.

/** A row shaped for `POST /ledger/import`. Ids are the provider's, not ours. */
export interface DemoEvent {
  channelId: string;
  providerEventId: string;
  kind: "sale" | "refund";
  reversesEventId?: string | null;
  occurredAt: string;
  jurisdiction: string;
  jurisdictionSource: "shipping_address" | "billing_address" | "tax_lines" | "declared";
  shipToCountry: string;
  shipToRegion: string;
  grossCents: number;
  retailCents: number;
  taxableCents: number;
  transactionCount: number;
  marketplaceFacilitated: boolean;
  currency: string;
}

/**
 * What each jurisdiction is meant to demonstrate.
 *
 * `targetCents` is the total *direct* (non-marketplace) volume over the
 * trailing twelve months, which is what the rolling-12m rules measure. The
 * generator distributes it across the window; it does not scatter it randomly
 * and hope.
 */
interface JurisdictionPlan {
  jurisdiction: string;
  region: string;
  /** Direct sales over the trailing 12 months, in cents. */
  targetCents: number;
  /** Marketplace-facilitated sales over the same window, in cents. */
  marketplaceCents: number;
  /** Orders per month, direct. Drives the transaction-count thresholds. */
  ordersPerMonth: number;
  /** Which channel these arrive on. */
  channel: "shopify" | "stripe";
  /** One line explaining what this jurisdiction is here to show. */
  demonstrates: string;
}

/**
 * Six jurisdictions, each carrying a different part of the story.
 *
 * Washington is the interesting one: its direct volume sits **below** its
 * $100,000 line, and its marketplace volume is large enough that including it
 * pushes the measurement over. Under `marketplace_treatment = 'exclude'` the
 * seller is clear; under `'include'` they are crossed. Same ledger, two lawful
 * answers, and the explainer shows both honestly — which is the single best
 * demonstration that this product measures rather than guesses.
 */
export const DEMO_PLAN: JurisdictionPlan[] = [
  {
    jurisdiction: "US-TX",
    region: "TX",
    // Comfortably past Texas's $500,000 rolling-12m line.
    targetCents: 612_450_00,
    marketplaceCents: 141_900_00,
    ordersPerMonth: 150,
    channel: "shopify",
    demonstrates: "crossed, with a registration deadline computed from the state's own rule",
  },
  {
    jurisdiction: "US-WA",
    region: "WA",
    // Just under $100,000 direct — but marketplace volume would push it over.
    targetCents: 94_200_00,
    marketplaceCents: 38_600_00,
    ordersPerMonth: 40,
    channel: "shopify",
    demonstrates: "approaching, and the outcome flips between include/exclude on the same ledger",
  },
  {
    jurisdiction: "US-NY",
    region: "NY",
    // New York tests sales AND transactions. Sales are close; transactions
    // are close; neither alone crosses, which is what `both` is for.
    targetCents: 421_000_00,
    marketplaceCents: 0,
    ordersPerMonth: 8,
    channel: "stripe",
    demonstrates: "threshold_logic = 'both' — near on each test, crossed on neither",
  },
  {
    jurisdiction: "US-CA",
    region: "CA",
    targetCents: 780_000_00,
    marketplaceCents: 0,
    ordersPerMonth: 200,
    channel: "stripe",
    demonstrates: "crossed but already registered — the status a seller wants to reach",
  },
  {
    jurisdiction: "US-FL",
    region: "FL",
    targetCents: 41_800_00,
    marketplaceCents: 0,
    ordersPerMonth: 25,
    channel: "shopify",
    demonstrates: "clear, with real volume — not an empty jurisdiction",
  },
  {
    jurisdiction: "US-IL",
    region: "IL",
    targetCents: 12_400_00,
    marketplaceCents: 0,
    ordersPerMonth: 6,
    channel: "stripe",
    demonstrates: "clear and early — the low end of the meter",
  },
];

/**
 * A jurisdiction that enforces **no** threshold, carried so the demo board
 * shows an out-of-scope card next to real ones.
 *
 * Without it, "out of scope" is a state a prospect never sees, and it is the
 * state that most clearly separates this product from a progress bar.
 */
export const DEMO_NO_OBLIGATION: JurisdictionPlan = {
  jurisdiction: "US-NH",
  region: "NH",
  targetCents: 88_300_00,
  marketplaceCents: 0,
  ordersPerMonth: 30,
  channel: "shopify",
  demonstrates: "no economic-nexus threshold at all — never renders as 'clear'",
};

/**
 * A deterministic 32-bit mixer.
 *
 * Not cryptographic and not trying to be. It exists so the per-order jitter is
 * *reproducible*: seeding the demo twice must produce the same ledger, or the
 * demo's claims stop being properties and become anecdotes.
 */
function mix(seed: number, i: number): number {
  let h = (seed ^ (i * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** A value in `[lo, hi]`, deterministic in `(seed, i)`. */
function pick(seed: number, i: number, lo: number, hi: number): number {
  return lo + (mix(seed, i) % (hi - lo + 1));
}

function addMonthsUTC(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);
  // Clamp: 31 January minus one month is 28/29 February, not 3 March.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export interface GenerateOptions {
  /** The instant the demo is "as of". No clock is read; this is a parameter. */
  asOf: Date;
  /** Public channel id for Shopify-sourced rows. */
  shopifyChannelId: string;
  /** Public channel id for Stripe-sourced rows. */
  stripeChannelId: string;
  /** Deterministic jitter seed. Same seed → same ledger. */
  seed?: number;
  /** How far back the ledger runs. 18 months by default. */
  months?: number;
}

/**
 * Build the demo ledger.
 *
 * The distribution is deliberately uneven — a Q4 bulge and a quiet January —
 * because a flat ledger makes the staleness baseline and the rolling window
 * look like they do nothing. The *trailing twelve months* total still lands on
 * each plan's target, which is what the thresholds measure.
 */
export function generateDemoLedger(options: GenerateOptions): DemoEvent[] {
  const { asOf, shopifyChannelId, stripeChannelId } = options;
  const seed = options.seed ?? 0x1eaf;
  const months = options.months ?? 18;
  const events: DemoEvent[] = [];

  // Seasonality over a 12-month cycle, indexed from the month of `asOf`
  // counting backwards. Sums to 12 so the trailing-12m total is preserved.
  const SEASON = [1.0, 0.6, 0.8, 1.9, 1.6, 1.0, 0.9, 0.8, 0.9, 1.0, 1.2, 1.3];
  const seasonTotal = SEASON.reduce((a, b) => a + b, 0);

  const plans = [...DEMO_PLAN, DEMO_NO_OBLIGATION];

  for (const [planIndex, plan] of plans.entries()) {
    const channelId = plan.channel === "shopify" ? shopifyChannelId : stripeChannelId;

    for (let m = 0; m < months; m += 1) {
      // m = 0 is the most recent complete month back from asOf.
      const monthStart = addMonthsUTC(asOf, -m);
      const inTrailingYear = m < 12;
      const share = SEASON[m % 12]! / seasonTotal;

      // Months 12–17 exist so the ledger has real history behind the window —
      // a rolling-12m measurement over a ledger that starts exactly 12 months
      // ago cannot demonstrate that the window is doing anything.
      const scale = inTrailingYear ? 1 : 0.7;

      const monthCents = Math.round(plan.targetCents * share * scale);
      const monthMarketplaceCents = Math.round(plan.marketplaceCents * share * scale);
      const monthOrders = Math.max(1, Math.round(plan.ordersPerMonth * share * 12 * scale));

      for (let o = 0; o < monthOrders; o += 1) {
        const i = planIndex * 100_000 + m * 1_000 + o;
        const dayOfMonth = pick(seed, i, 1, 28);
        const hour = pick(seed, i + 7, 8, 21);
        const occurredAt = new Date(
          Date.UTC(
            monthStart.getUTCFullYear(),
            monthStart.getUTCMonth(),
            dayOfMonth,
            hour,
            pick(seed, i + 13, 0, 59),
            0,
          ),
        );
        // Never generate a row after `asOf` — a ledger containing the future
        // is a ledger nobody will trust the rest of.
        if (occurredAt.getTime() > asOf.getTime()) continue;

        // Even split of the month's total, with the remainder on the last
        // order so the sum is EXACT. Distributing cents by rounding each order
        // independently loses money, which is the one bug this product cannot
        // ship even in a demo.
        const base = Math.trunc(monthCents / monthOrders);
        const gross = o === monthOrders - 1 ? monthCents - base * (monthOrders - 1) : base;
        if (gross <= 0) continue;

        // Taxable is a little under gross — shipping and exempt items — so the
        // demo shows that the three bases genuinely differ.
        const taxable = Math.round(gross * 0.94);

        // Most rows carry a ship-to address; a few fall back, so the ledger
        // demonstrates that a weak attribution is labelled rather than hidden.
        const weak = pick(seed, i + 29, 0, 99) < 6;

        events.push({
          channelId,
          providerEventId: `demo-${plan.jurisdiction}-${m}-${o}`,
          kind: "sale",
          occurredAt: occurredAt.toISOString(),
          jurisdiction: plan.jurisdiction,
          jurisdictionSource: weak ? "billing_address" : "shipping_address",
          shipToCountry: "US",
          shipToRegion: plan.region,
          grossCents: gross,
          retailCents: gross,
          taxableCents: taxable,
          transactionCount: 1,
          marketplaceFacilitated: false,
          currency: "USD",
        });
      }

      // Marketplace-facilitated volume, as its own coarser rows. Washington is
      // the jurisdiction this exists for.
      if (monthMarketplaceCents > 0) {
        const mpOrders = Math.max(1, Math.round(monthOrders / 4));
        const base = Math.trunc(monthMarketplaceCents / mpOrders);
        for (let o = 0; o < mpOrders; o += 1) {
          const i = planIndex * 100_000 + m * 1_000 + 500 + o;
          const gross =
            o === mpOrders - 1 ? monthMarketplaceCents - base * (mpOrders - 1) : base;
          if (gross <= 0) continue;
          const occurredAt = new Date(
            Date.UTC(
              monthStart.getUTCFullYear(),
              monthStart.getUTCMonth(),
              pick(seed, i, 1, 28),
              pick(seed, i + 7, 8, 21),
              0,
              0,
            ),
          );
          if (occurredAt.getTime() > asOf.getTime()) continue;
          events.push({
            channelId,
            providerEventId: `demo-mp-${plan.jurisdiction}-${m}-${o}`,
            kind: "sale",
            occurredAt: occurredAt.toISOString(),
            jurisdiction: plan.jurisdiction,
            jurisdictionSource: "shipping_address",
            shipToCountry: "US",
            shipToRegion: plan.region,
            grossCents: gross,
            retailCents: gross,
            taxableCents: Math.round(gross * 0.94),
            transactionCount: 1,
            marketplaceFacilitated: true,
            currency: "USD",
          });
        }
      }
    }
  }

  // One large Q4 refund, reversing a real sale, so the ledger shows a reversal
  // as a linked second row rather than as an edited first one. It is chosen
  // rather than random: the story only lands if the original is visible above
  // it, and a refund of a row nobody can find is not a demonstration.
  const q4 = events.find(
    (e) =>
      e.jurisdiction === "US-TX" &&
      !e.marketplaceFacilitated &&
      new Date(e.occurredAt).getUTCMonth() === 10,
  );
  if (q4) {
    const refundAt = new Date(new Date(q4.occurredAt).getTime() + 21 * 24 * 60 * 60 * 1000);
    events.push({
      channelId: q4.channelId,
      providerEventId: `${q4.providerEventId}-refund`,
      kind: "refund",
      // The import resolves this to the ledger row's own id; the provider id
      // is what a real connector would carry.
      reversesEventId: q4.providerEventId,
      // Dated by the REFUND's own timestamp, not the order's — §5.3 case 5.
      // A refund reduces the window it lands in, which may not be the window
      // the sale landed in.
      occurredAt: (refundAt.getTime() > options.asOf.getTime()
        ? options.asOf
        : refundAt
      ).toISOString(),
      jurisdiction: q4.jurisdiction,
      jurisdictionSource: q4.jurisdictionSource,
      shipToCountry: q4.shipToCountry,
      shipToRegion: q4.shipToRegion,
      grossCents: -q4.grossCents,
      retailCents: -q4.retailCents,
      taxableCents: -q4.taxableCents,
      transactionCount: -1,
      marketplaceFacilitated: false,
      currency: q4.currency,
    });
  }

  // Oldest first, so an import that is interrupted leaves a prefix of history
  // rather than a scatter.
  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/** Direct (non-marketplace) cents in the trailing 12 months, per jurisdiction. */
export function trailingTwelveMonths(
  events: readonly DemoEvent[],
  asOf: Date,
  options: { includeMarketplace: boolean },
): Map<string, number> {
  const floor = addMonthsUTC(asOf, -12).getTime();
  const totals = new Map<string, number>();
  for (const e of events) {
    if (new Date(e.occurredAt).getTime() < floor) continue;
    if (e.marketplaceFacilitated && !options.includeMarketplace) continue;
    totals.set(e.jurisdiction, (totals.get(e.jurisdiction) ?? 0) + e.grossCents);
  }
  return totals;
}
