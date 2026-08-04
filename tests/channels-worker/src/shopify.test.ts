// NX7 — the Shopify adapter.
//
// The milestone's acceptance criteria, made executable:
//
//   * fixture orders resolve to the correct jurisdiction through **each**
//     fallback level, and the level used is visible on the row;
//   * a facilitator-remitted order is flagged, and is excluded under a rule
//     with `marketplace_treatment = 'exclude'` and included under `'include'`
//     — **from the same ledger, changing only the rule**.
//
// The second one is asserted end to end through the real engine rather than by
// checking a boolean, because the boolean is not the claim; the claim is that
// one seller's ledger produces two different lawful answers depending on the
// state, and that the explainer can show both.

import {
  isMarketplaceFacilitated,
  normalizeOrder,
  normalizeOrderRefunds,
  toCents,
  createShopifyProvider,
} from "@channels-worker/providers/shopify";
import { resolveProvider } from "@channels-worker/providers/registry";
import type { Env } from "@channels-worker/env";
import { evaluate } from "@nexus-worker/engine";
import type { DeterminationInputs, Rule } from "@saas/contracts/nexus";

// ── Money ────────────────────────────────────────────────────

describe("decimal-string amounts", () => {
  it.each([
    ["129.95", 12_995],
    ["8.025", null], // three decimal places is not an amount we will guess at
    ["0.01", 1],
    ["0", 0],
    ["1000000.00", 100_000_000],
    ["-45.50", -4_550],
    ["12.5", 1_250], // one decimal place pads, not truncates
    ["", null],
    ["abc", null],
    ["1,299.95", null], // thousands separators are not parsed, they are refused
  ])("parses %s → %s", (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it("parses digits rather than multiplying a float", () => {
    // `Math.round(Number(x) * 100)` is right for the values you try and wrong
    // for the ones you do not, and "the ones you do not" is the tail of a
    // seller's order history.
    for (const [amount, cents] of [
      ["1.005", null],
      ["70.07", 7_007],
      ["1.10", 110],
      ["2.675", null],
    ] as const) {
      expect(toCents(amount)).toBe(cents);
    }
  });

  it("refuses a malformed amount instead of returning zero", () => {
    // Zero would be a silent under-count, which reads as "this seller had a
    // quiet month".
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
    expect(toCents({})).toBeNull();
  });
});

// ── §6.2 fallback level 1/2/3 ────────────────────────────────

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    created_at: "2026-03-04T15:00:00Z",
    currency: "USD",
    current_total_price: "129.95",
    subtotal_price: "119.95",
    total_tax: "10.00",
    source_name: "web",
    shipping_address: { country_code: "US", province_code: "TX" },
    ...overrides,
  };
}

describe("§6.2 — ship-to jurisdiction resolves through each fallback level", () => {
  it("level 1: the shipping address", () => {
    const [event] = normalizeOrder(order());
    expect(event).toMatchObject({
      jurisdiction: "US-TX",
      jurisdictionSource: "shipping_address",
    });
  });

  it("level 2: the billing address, marked as such", () => {
    // A poor proxy for where a service was consumed (R4), so the row says it
    // is a billing address and the explainer renders that.
    const [event] = normalizeOrder(
      order({
        shipping_address: null,
        billing_address: { country_code: "US", province_code: "CA" },
      }),
    );
    expect(event).toMatchObject({
      jurisdiction: "US-CA",
      jurisdictionSource: "billing_address",
    });
  });

  it("level 3: the jurisdiction implied by the tax lines", () => {
    // The weakest signal, and the one a digital seller with no address at all
    // depends on. A tax line Shopify itself computed names a real place.
    const [event] = normalizeOrder(
      order({
        shipping_address: null,
        billing_address: null,
        tax_lines: [{ title: "WA State Tax", price: "10.00", jurisdiction_code: "US-WA" }],
      }),
    );
    expect(event).toMatchObject({
      jurisdiction: "US-WA",
      jurisdictionSource: "tax_lines",
    });
  });

  it("reads a bare two-letter tax-line code as a US state, not a country", () => {
    // Shopify emits both forms. Guessing wrong here puts a Washington sale in
    // a country called WA.
    const [event] = normalizeOrder(
      order({
        shipping_address: null,
        billing_address: null,
        tax_lines: [{ price: "10.00", jurisdiction_code: "WA" }],
      }),
    );
    expect(event!.jurisdiction).toBe("US-WA");
  });

  it("prefers shipping over billing when both are present", () => {
    const [event] = normalizeOrder(
      order({
        shipping_address: { country_code: "US", province_code: "TX" },
        billing_address: { country_code: "US", province_code: "NY" },
      }),
    );
    expect(event!.jurisdiction).toBe("US-TX");
  });

  it("falls through a US address with no province rather than inventing one", () => {
    const [event] = normalizeOrder(
      order({
        shipping_address: { country_code: "US", province_code: null },
        billing_address: { country_code: "US", province_code: "IL" },
      }),
    );
    expect(event).toMatchObject({ jurisdiction: "US-IL", jurisdictionSource: "billing_address" });
  });

  it("produces no row at all when every level fails", () => {
    // Visible gap beats invisible misattribution.
    expect(
      normalizeOrder(order({ shipping_address: null, billing_address: null, tax_lines: [] })),
    ).toEqual([]);
  });

  it("captures all three measurement bases, with retail excluding tax", () => {
    const [event] = normalizeOrder(order());
    expect(event).toMatchObject({
      grossCents: 12_995,
      retailCents: 11_995,
      taxableCents: 11_995,
    });
  });
});

// ── Marketplace facilitation ─────────────────────────────────

describe("marketplace-facilitator identification", () => {
  it.each([
    ["amazon", true],
    ["etsy", true],
    ["walmart", true],
    ["web", false],
    ["pos", false],
    ["some_custom_app", false],
  ])("source_name %s → %s", (source, expected) => {
    expect(isMarketplaceFacilitated({ source_name: source })).toBe(expected);
  });

  it("flags a channel-liable tax line even from an unfamiliar source", () => {
    // A seller can route Amazon orders through a custom app with an
    // unrecognised source_name; `channel_liable` is Shopify's own flag for
    // "the sales channel remitted this, not the merchant", which is exactly
    // what facilitation means.
    expect(
      isMarketplaceFacilitated({
        source_name: "some_custom_app",
        tax_lines: [{ price: "10.00", channel_liable: true }],
      }),
    ).toBe(true);
  });

  it("defaults an unknown source to the seller's own sale", () => {
    // The direction that does NOT silently exclude revenue from a threshold.
    expect(isMarketplaceFacilitated({ source_name: "brand_new_channel" })).toBe(false);
  });

  it("carries the flag onto the canonical event", () => {
    const [event] = normalizeOrder(order({ source_name: "amazon" }));
    expect(event!.marketplaceFacilitated).toBe(true);
  });
});

describe("the same ledger, two lawful answers", () => {
  // The acceptance criterion, end to end through the real engine: a seller
  // with $70k direct and $45k marketplace in Washington. Under
  // `marketplace_treatment = 'include'` they have crossed; under `'exclude'`
  // they have not. Nothing about the ledger changes — only the rule.

  const direct = 70_000_00;
  const marketplace = 45_000_00;

  const inputs: DeterminationInputs = {
    asOf: "2026-08-04T12:00:00.000Z",
    window: {
      start: "2026-01-01T08:00:00.000Z",
      end: "2027-01-01T08:00:00.000Z",
      startDate: "2026-01-01",
      endDate: "2027-01-01",
    },
    aggregate: {
      jurisdiction: "US-WA",
      directGrossCents: direct,
      directRetailCents: direct,
      directTaxableCents: direct,
      directTransactions: 310,
      marketplaceGrossCents: marketplace,
      marketplaceRetailCents: marketplace,
      marketplaceTaxableCents: marketplace,
      marketplaceTransactions: 190,
    },
    approachingFraction: 0.8,
  };

  const baseRule: Rule = {
    id: "rul_wa",
    ruleSetId: "rst_1",
    ruleSetVersion: "2026.08.01-synthetic",
    jurisdiction: "US-WA",
    effectiveFrom: "2020-01-01",
    effectiveTo: null,
    measurementBasis: "retail",
    measurementPeriod: "calendar_year",
    measurementTimezone: "America/Los_Angeles",
    salesThresholdCents: 100_000_00,
    transactionThreshold: null,
    thresholdLogic: "sales_only",
    marketplaceTreatment: "include",
    registrationDeadlineRule: { kind: "first_of_next_month" },
    notes: null,
  };

  it("crosses when the rule includes marketplace sales", () => {
    const outcome = evaluate(inputs, { ...baseRule, marketplaceTreatment: "include" });
    expect(outcome.measuredSalesCents).toBe(115_000_00);
    expect(outcome.status).toBe("crossed");
  });

  it("does not cross when the rule excludes them", () => {
    const outcome = evaluate(inputs, { ...baseRule, marketplaceTreatment: "exclude" });
    expect(outcome.measuredSalesCents).toBe(70_000_00);
    expect(outcome.status).toBe("clear");
  });

  it("the explainer can show both, because only the rule differs", () => {
    const included = evaluate(inputs, { ...baseRule, marketplaceTreatment: "include" });
    const excluded = evaluate(inputs, { ...baseRule, marketplaceTreatment: "exclude" });
    // Same window, same aggregate, same engine version — the difference is
    // entirely attributable to the rule, which is what makes the side-by-side
    // honest rather than a demo trick.
    expect(included.thresholdSalesCents).toBe(excluded.thresholdSalesCents);
    expect(included.status).not.toBe(excluded.status);
  });
});

// ── Refunds ──────────────────────────────────────────────────

describe("refunds", () => {
  it("emits one negative row per refund, linked to the order", () => {
    const events = normalizeOrderRefunds(
      order({
        refunds: [
          { id: 90, created_at: "2026-04-01T09:00:00Z", transactions: [{ amount: "50.00" }] },
          { id: 91, created_at: "2026-04-05T09:00:00Z", transactions: [{ amount: "20.00" }] },
        ],
      }),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      providerEventId: "5001:refund:90",
      kind: "refund",
      reversesProviderEventId: "5001",
      grossCents: -5_000,
      transactionCount: -1,
    });
    // Distinct ids so two partial refunds are two rows rather than one
    // overwriting the other.
    expect(events[1]!.providerEventId).toBe("5001:refund:91");
  });

  it("dates a refund by its own timestamp, not the order's", () => {
    // §5.3 case 5: a refund reduces the window it lands in, not the one its
    // sale did.
    const [refund] = normalizeOrderRefunds(
      order({
        created_at: "2025-12-20T15:00:00Z",
        refunds: [{ id: 90, created_at: "2026-01-05T09:00:00Z", transactions: [{ amount: "50.00" }] }],
      }),
    );
    expect(refund!.occurredAt).toBe("2026-01-05T09:00:00.000Z");
  });

  it("sums a refund's transactions", () => {
    const [refund] = normalizeOrderRefunds(
      order({
        refunds: [{ id: 90, transactions: [{ amount: "30.00" }, { amount: "20.00" }] }],
      }),
    );
    expect(refund!.grossCents).toBe(-5_000);
  });

  it("ignores a zero-value refund", () => {
    expect(
      normalizeOrderRefunds(order({ refunds: [{ id: 90, transactions: [{ amount: "0" }] }] })),
    ).toEqual([]);
  });
});

// ── Signature and registry ───────────────────────────────────

describe("the Shopify ingress gate", () => {
  const secret = "shpss_test";
  const provider = createShopifyProvider({
    clientId: "x", clientSecret: "y", webhookSecret: secret,
  });
  const body = JSON.stringify({ id: 5001 });

  async function hmac(payload: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    let binary = "";
    const bytes = new Uint8Array(sig);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }

  const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;

  it("accepts a correctly signed body", async () => {
    const headers = new Headers({ "x-shopify-hmac-sha256": await hmac(body) });
    expect(await provider.verifyInboundSignature(bytes(body), headers)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const headers = new Headers({ "x-shopify-hmac-sha256": await hmac(body) });
    expect(await provider.verifyInboundSignature(bytes('{"id":5002}'), headers)).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await provider.verifyInboundSignature(bytes(body), new Headers())).toBe(false);
  });
});

describe("the registry now resolves Shopify", () => {
  it("resolves when the credential set is complete", () => {
    const env = {
      ENVIRONMENT: "test",
      SHOPIFY_CLIENT_ID: "x",
      SHOPIFY_CLIENT_SECRET: "y",
      SHOPIFY_WEBHOOK_SECRET: "z",
    } as Env;
    expect(resolveProvider(env, "shopify")?.id).toBe("shopify");
  });

  it("still fails closed on an incomplete set", () => {
    expect(
      resolveProvider({ ENVIRONMENT: "test", SHOPIFY_CLIENT_ID: "x" } as Env, "shopify"),
    ).toBeNull();
  });
});
