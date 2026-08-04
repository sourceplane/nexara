// Shopify adapter.
//
// Two hard parts, both entirely inside this file, and both with the fallback
// order named in a comment because getting either wrong moves a seller across
// a threshold they never crossed, or hides one they did:
//
//   * **Ship-to jurisdiction** (design §6.2): `shipping_address` →
//     `billing_address` → the jurisdiction implied by the order's `tax_lines`.
//     Which fallback fired is recorded on the canonical event, because "we
//     guessed" must be visible in the evidence rather than laundered into a
//     fact (R4).
//   * **Marketplace-facilitator identification**: `order.source_name` combined
//     with the presence of a facilitator-remitted tax line.
//
// Money: Shopify reports amounts as **decimal strings** ("129.95"), unlike
// Stripe's integer minor units. That conversion is the single most dangerous
// line in this file and it lives in exactly one function, `toCents`, which
// parses digits rather than multiplying a float — `Math.round(129.95 * 100)`
// is 12995 today and a different answer for values you have not tried.

import type { CanonicalSaleEvent, ProviderAccountFacts } from "@saas/contracts/channels";

import type { HistoryPage, SalesProvider } from "./types.js";

export const SHOPIFY_API_VERSION = "2025-07";

export interface ShopifyCredentials {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

/**
 * `source_name` values that mean "this order came through a marketplace".
 *
 * Shopify's own storefront and POS are `web`/`pos`; a channel app sets its own.
 * The list is deliberately an allow-list of *marketplaces* rather than a
 * deny-list of our own surfaces: a new integration we have never heard of
 * should default to "the seller made this sale", which is the answer that does
 * not silently exclude revenue from a threshold.
 */
const MARKETPLACE_SOURCE_NAMES = new Set([
  "amazon", "amazon_marketplace", "ebay", "etsy", "walmart",
  "facebook", "instagram", "tiktok", "google", "wish", "shop_app",
]);

export function createShopifyProvider(
  creds: ShopifyCredentials,
  fetchImpl: typeof fetch = fetch,
): SalesProvider {
  return {
    id: "shopify",
    displayName: "Shopify",

    buildAuthorizeUrl({ state, redirectUri }) {
      // The shop domain is carried in the redirect target rather than here;
      // Shopify's authorize URL is per-shop and the shop is chosen by the
      // operator in the app-install flow.
      const params = new URLSearchParams({
        client_id: creds.clientId,
        scope: "read_orders,read_products",
        redirect_uri: redirectUri,
        state,
      });
      return `https://accounts.shopify.com/oauth/authorize?${params.toString()}`;
    },

    async completeConnect({ code }) {
      try {
        // The shop domain is embedded in the code exchange target by the
        // install flow; a connect with no shop is not verifiable and fails
        // closed rather than producing a channel we cannot poll.
        const shop = shopFromCode(code);
        if (!shop) return null;

        const response = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            code: code.split("@")[0],
          }),
        });
        if (!response.ok) return null;

        const body = (await response.json()) as { access_token?: string };
        if (!body.access_token) return null;

        const facts: ProviderAccountFacts = {
          externalAccountId: shop,
          displayName: shop,
          credentialsRef: `shopify:${shop}`,
        };
        return facts;
      } catch {
        return null;
      }
    },

    async verifyInboundSignature(rawBody, headers) {
      // Shopify signs the raw body with the app's shared secret and sends a
      // base64 digest. Same discipline as Stripe: raw bytes, constant-time
      // comparison, no early return.
      const provided = headers.get("x-shopify-hmac-sha256");
      if (!provided) return false;

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(creds.webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign("HMAC", key, rawBody);
      let binary = "";
      const bytes = new Uint8Array(digest);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const expected = btoa(binary);

      return timingSafeEqual(provided, expected);
    },

    async fetchHistoryPage({ cursor, before, floor, credentials }): Promise<HistoryPage> {
      const [shop, token] = splitCredentials(credentials);
      const params = new URLSearchParams({
        limit: "250",
        status: "any",
        // Walking BACKWARDS from the seam (design §6.3 step 3): the upper
        // bound is `backfill_started_at`, the same instant live capture's
        // lower bound uses, so the seam is covered from both sides.
        created_at_max: before.toISOString(),
        created_at_min: floor.toISOString(),
      });
      if (cursor) params.set("page_info", cursor);

      const response = await fetchImpl(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${params.toString()}`,
        { headers: { "x-shopify-access-token": token } },
      );
      if (!response.ok) throw new Error(`shopify_history_${response.status}`);

      const body = (await response.json()) as { orders?: unknown[] };
      const events = (body.orders ?? []).flatMap((o) => normalizeOrder(o));

      return { events, nextCursor: pageInfoFrom(response.headers.get("link")) };
    },

    normalize(payload) {
      // Shopify webhooks carry the resource directly, with the topic in a
      // header the ingress copies onto the envelope. A refunded order arrives
      // as an `orders/updated` carrying `refunds`, so both paths run and the
      // dedupe key (`kind` is part of it) keeps them apart.
      return [...normalizeOrder(payload), ...normalizeOrderRefunds(payload)];
    },

    async revoke() {
      // Shopify has no deauthorize endpoint for an app token; uninstalling the
      // app is the seller's action. Reporting false here rather than a
      // misleading true: revoking OUR side is what `revokeChannel` does, and
      // it happens regardless.
      return false;
    },
  };
}

// ── Money ────────────────────────────────────────────────────

/**
 * A Shopify decimal-string amount → integer cents.
 *
 * **Parsed, not multiplied.** `Math.round(Number("129.95") * 100)` happens to
 * be 12995, and happens to be 802 for "8.025" where the right answer is 803 —
 * float multiplication is wrong for values you have not tried, and "values you
 * have not tried" is the entire tail of a seller's order history.
 *
 * Returns null on anything that is not a well-formed amount, and the caller
 * drops the event rather than guessing a number.
 */
export function toCents(amount: unknown): number | null {
  if (typeof amount === "number") {
    return Number.isSafeInteger(amount * 100) ? Math.round(amount * 100) : null;
  }
  if (typeof amount !== "string") return null;
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  return sign * (whole * 100 + frac);
}

// ── Normalisation ────────────────────────────────────────────

interface ShopifyAddress {
  country_code?: string | null;
  province_code?: string | null;
}

interface ShopifyTaxLine {
  price?: string | number | null;
  title?: string | null;
  channel_liable?: boolean | null;
  jurisdiction_code?: string | null;
}

interface ShopifyOrder {
  id?: number | string;
  created_at?: string;
  currency?: string;
  current_total_price?: string;
  total_price?: string;
  subtotal_price?: string;
  total_tax?: string;
  source_name?: string | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  tax_lines?: ShopifyTaxLine[] | null;
  refunds?: Array<{ id?: number | string; created_at?: string; transactions?: Array<{ amount?: string }> }> | null;
}

export function normalizeOrder(raw: unknown): CanonicalSaleEvent[] {
  const order = raw as ShopifyOrder;
  if (order.id === undefined || !order.created_at || !order.currency) return [];

  const resolved = resolveJurisdiction(order);
  // No jurisdiction, no row. A sale attributed to the wrong state silently
  // moves a threshold; one we could not attribute is a visible gap.
  if (!resolved) return [];

  const gross = toCents(order.current_total_price ?? order.total_price);
  if (gross === null) return [];

  // Retail excludes tax; taxable is Shopify's own taxable subtotal when it
  // reports one. All three are captured because rules disagree on which
  // applies and deriving the others later needs the payload back.
  const tax = toCents(order.total_tax) ?? 0;
  const subtotal = toCents(order.subtotal_price);
  const retail = subtotal ?? gross - tax;

  return [
    {
      providerEventId: String(order.id),
      kind: "sale",
      reversesProviderEventId: null,
      occurredAt: new Date(order.created_at).toISOString(),
      jurisdiction: resolved.jurisdiction,
      jurisdictionSource: resolved.source,
      shipToCountry: resolved.country,
      shipToRegion: resolved.region,
      grossCents: gross,
      retailCents: retail,
      taxableCents: retail,
      transactionCount: 1,
      marketplaceFacilitated: isMarketplaceFacilitated(order),
      currency: order.currency.toUpperCase(),
    },
  ];
}

export function normalizeOrderRefunds(raw: unknown): CanonicalSaleEvent[] {
  const order = raw as ShopifyOrder;
  const sale = normalizeOrder(order)[0];
  if (!sale || !order.refunds || order.refunds.length === 0) return [];

  return order.refunds.flatMap((refund) => {
    const total = (refund.transactions ?? []).reduce((sum, t) => {
      const cents = toCents(t.amount);
      return cents === null ? sum : sum + cents;
    }, 0);
    if (total <= 0) return [];

    return [
      {
        ...sale,
        // A distinct provider id so the refund cannot collide with its order
        // on the dedupe key, and one per refund so two partial refunds of the
        // same order are two rows rather than one that overwrites the other.
        providerEventId: `${String(order.id)}:refund:${String(refund.id ?? total)}`,
        kind: "refund" as const,
        reversesProviderEventId: String(order.id),
        occurredAt: new Date(refund.created_at ?? order.created_at!).toISOString(),
        grossCents: -total,
        retailCents: -total,
        taxableCents: -total,
        transactionCount: -1,
      },
    ];
  });
}

interface Resolved {
  jurisdiction: string;
  source: CanonicalSaleEvent["jurisdictionSource"];
  country: string | null;
  region: string | null;
}

/**
 * Ship-to jurisdiction, in the fallback order design §6.2 fixes:
 *
 *   1. `shipping_address` — where the goods went.
 *   2. `billing_address` — a poor proxy, and marked as such on the row.
 *   3. the jurisdiction implied by the order's `tax_lines` — the weakest
 *      signal, used because a digital seller may have no address at all (R4),
 *      and because a tax line Shopify itself computed names a real place.
 *
 * The level that fired is returned, never dropped. A low-confidence
 * attribution must be visible in the evidence, and the explainer renders it.
 */
function resolveJurisdiction(order: ShopifyOrder): Resolved | null {
  const fromAddress = (
    address: ShopifyAddress | null | undefined,
    source: Resolved["source"],
  ): Resolved | null => {
    if (!address?.country_code) return null;
    const country = address.country_code.toUpperCase();
    const region = address.province_code ? address.province_code.toUpperCase() : null;
    if (country === "US") {
      // A US order with no province cannot be attributed; fall through rather
      // than inventing a state.
      return region ? { jurisdiction: `US-${region}`, source, country, region } : null;
    }
    return { jurisdiction: country, source, country, region };
  };

  return (
    fromAddress(order.shipping_address, "shipping_address") ??
    fromAddress(order.billing_address, "billing_address") ??
    fromTaxLines(order)
  );
}

/** `jurisdiction_code` on a tax line, e.g. `US-WA` or `WA`. */
function fromTaxLines(order: ShopifyOrder): Resolved | null {
  for (const line of order.tax_lines ?? []) {
    const code = line.jurisdiction_code?.toUpperCase();
    if (!code) continue;
    if (/^US-[A-Z]{2}$/.test(code)) {
      return { jurisdiction: code, source: "tax_lines", country: "US", region: code.slice(3) };
    }
    if (/^[A-Z]{2}$/.test(code)) {
      // A bare two-letter code on a US tax line is a state, not a country.
      // Shopify emits both forms; guessing wrong here puts a Washington sale
      // in a country called WA.
      return { jurisdiction: `US-${code}`, source: "tax_lines", country: "US", region: code };
    }
  }
  return null;
}

/**
 * Marketplace-facilitated, per design §6.2.
 *
 * Two independent signals, either of which is sufficient:
 *
 *   * `source_name` names a known marketplace;
 *   * a tax line is marked `channel_liable` — Shopify's own flag for "the
 *     sales channel remitted this tax, not the merchant", which is exactly
 *     what marketplace facilitation means.
 *
 * Either alone can be wrong: a seller can route Amazon orders through a custom
 * app with an unfamiliar `source_name`, and a marketplace can decline to remit
 * in a state where it has no obligation. Requiring **both** would under-report
 * facilitation and quietly pull sales back into a seller's own threshold;
 * accepting **either** over-reports it, which under a
 * `marketplace_treatment = 'exclude'` rule is the direction that flags a
 * seller for review rather than silently clearing them.
 */
export function isMarketplaceFacilitated(order: ShopifyOrder): boolean {
  const source = order.source_name?.toLowerCase().trim() ?? "";
  if (MARKETPLACE_SOURCE_NAMES.has(source)) return true;
  return (order.tax_lines ?? []).some((line) => line.channel_liable === true);
}

// ── Helpers ──────────────────────────────────────────────────

/** `<code>@<shop-domain>` — the install flow packs the shop with the code so
 *  the exchange target is known without a second round trip. */
function shopFromCode(code: string): string | null {
  const at = code.indexOf("@");
  if (at < 1) return null;
  const shop = code.slice(at + 1);
  return /^[a-z0-9-]+\.myshopify\.com$/.test(shop) ? shop : null;
}

function splitCredentials(credentials: string): [string, string] {
  const at = credentials.indexOf("@");
  if (at < 1) return ["", credentials];
  return [credentials.slice(at + 1), credentials.slice(0, at)];
}

/** Shopify paginates with an opaque `page_info` in a `Link` header. */
function pageInfoFrom(link: string | null): string | null {
  if (!link) return null;
  const next = link.split(",").find((part) => part.includes('rel="next"'));
  if (!next) return null;
  const match = /[?&]page_info=([^&>]+)/.exec(next);
  return match ? match[1]! : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
