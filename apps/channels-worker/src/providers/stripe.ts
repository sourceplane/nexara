// Stripe adapter.
//
// The API version is pinned explicitly rather than tracking the account
// default (R8): a payload shape that changes under us without a deploy is a
// silent ingestion bug, and silent ingestion bugs read as "no sales".
//
// Money: Stripe reports integer minor units already, so there is no conversion
// here and there must never be one. The one place a float could enter this
// product is a provider adapter doing arithmetic on an amount, and this
// adapter does none.

import type { CanonicalSaleEvent, ProviderAccountFacts } from "@saas/contracts/channels";

import type { HistoryPage, SalesProvider } from "./types.js";

export const STRIPE_API_VERSION = "2025-04-30.basil";

const STRIPE_API = "https://api.stripe.com/v1";
const AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";

export interface StripeCredentials {
  clientId: string;
  secretKey: string;
  webhookSecret: string;
}

/** Tolerance on the signature timestamp. Stripe's own default is 5 minutes. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export function createStripeProvider(
  creds: StripeCredentials,
  fetchImpl: typeof fetch = fetch,
): SalesProvider {
  return {
    id: "stripe",
    displayName: "Stripe",

    buildAuthorizeUrl({ state, redirectUri }) {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: creds.clientId,
        scope: "read_only",
        redirect_uri: redirectUri,
        state,
      });
      return `${AUTHORIZE_URL}?${params.toString()}`;
    },

    async completeConnect({ code }) {
      try {
        const response = await fetchImpl(`${STRIPE_API}/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "stripe-version": STRIPE_API_VERSION,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_secret: creds.secretKey,
          }).toString(),
        });
        if (!response.ok) return null;

        const body = (await response.json()) as {
          stripe_user_id?: string;
          access_token?: string;
        };
        if (!body.stripe_user_id || !body.access_token) return null;

        const facts: ProviderAccountFacts = {
          externalAccountId: body.stripe_user_id,
          displayName: `Stripe ${body.stripe_user_id}`,
          // A POINTER, never the token. The envelope lives in the secret
          // store; a dump of nexus.channels is not a breach of the seller's
          // Stripe account.
          credentialsRef: `stripe:${body.stripe_user_id}`,
        };
        return facts;
      } catch {
        // Fail closed. A network blip must not produce a channel we cannot
        // authenticate against, because that channel would then read as
        // "connected, no sales".
        return null;
      }
    },

    async verifyInboundSignature(rawBody, headers) {
      const header = headers.get("stripe-signature");
      if (!header) return false;

      // `t=<ts>,v1=<sig>,v1=<sig>` — more than one v1 during secret rotation.
      const parts = new Map<string, string[]>();
      for (const segment of header.split(",")) {
        const eq = segment.indexOf("=");
        if (eq < 1) continue;
        const key = segment.slice(0, eq).trim();
        const value = segment.slice(eq + 1).trim();
        parts.set(key, [...(parts.get(key) ?? []), value]);
      }

      const timestamp = parts.get("t")?.[0];
      const signatures = parts.get("v1") ?? [];
      if (!timestamp || signatures.length === 0) return false;

      const ts = Number(timestamp);
      if (!Number.isFinite(ts)) return false;
      // Replay window. Without it, a captured delivery is replayable forever —
      // and because the ledger dedupes, the damage is not a double-count but a
      // resurrection of a refunded or corrected event.
      const skew = Math.abs(Date.now() / 1000 - ts);
      if (skew > SIGNATURE_TOLERANCE_SECONDS) return false;

      const signed = new Uint8Array(rawBody);
      const prefix = new TextEncoder().encode(`${timestamp}.`);
      const message = new Uint8Array(prefix.length + signed.length);
      message.set(prefix, 0);
      message.set(signed, prefix.length);

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(creds.webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign("HMAC", key, message);
      const expected = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Constant-time over every candidate, and no early return on the first
      // match — a short-circuit here leaks which rotation key matched.
      let matched = false;
      for (const candidate of signatures) {
        matched = timingSafeEqual(candidate, expected) || matched;
      }
      return matched;
    },

    async fetchHistoryPage({ cursor, before, floor, credentials }): Promise<HistoryPage> {
      const params = new URLSearchParams({
        limit: "100",
        // Walking BACKWARDS from the seam (design §6.3 step 3). `created[lt]`
        // is the upper bound and it is `backfill_started_at`, the same instant
        // live capture's lower bound uses — so the seam is covered from both
        // sides and the overlap is free.
        "created[lt]": String(Math.floor(before.getTime() / 1000)),
        "created[gte]": String(Math.floor(floor.getTime() / 1000)),
      });
      if (cursor) params.set("starting_after", cursor);

      const response = await fetchImpl(`${STRIPE_API}/charges?${params.toString()}`, {
        headers: {
          authorization: `Bearer ${credentials}`,
          "stripe-version": STRIPE_API_VERSION,
        },
      });
      if (!response.ok) {
        throw new Error(`stripe_history_${response.status}`);
      }

      const body = (await response.json()) as {
        data?: unknown[];
        has_more?: boolean;
      };
      const charges = body.data ?? [];
      const events = charges.flatMap((c) => normalizeCharge(c));
      const last = charges[charges.length - 1] as { id?: string } | undefined;

      return {
        events,
        nextCursor: body.has_more && last?.id ? last.id : null,
      };
    },

    normalize(payload) {
      const event = payload as { type?: string; data?: { object?: unknown } };
      const object = event.data?.object;
      if (!object) return [];

      switch (event.type) {
        case "charge.succeeded":
        case "charge.updated":
          return normalizeCharge(object);
        case "charge.refunded":
          return normalizeRefund(object);
        default:
          // Unrecognised types are not errors. Stripe sends dozens we do not
          // care about, and treating them as failures would fill the drain's
          // retry budget with events that will never become sales.
          return [];
      }
    },

    async revoke({ credentials }) {
      try {
        const response = await fetchImpl(`${STRIPE_API}/oauth/deauthorize`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Bearer ${creds.secretKey}`,
          },
          body: new URLSearchParams({
            client_id: creds.clientId,
            stripe_user_id: credentials,
          }).toString(),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

// ── Normalisation ────────────────────────────────────────────

interface StripeCharge {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  created?: number;
  refunded?: boolean;
  billing_details?: { address?: StripeAddress | null } | null;
  shipping?: { address?: StripeAddress | null } | null;
  metadata?: Record<string, string> | null;
}

interface StripeAddress {
  country?: string | null;
  state?: string | null;
}

/**
 * A charge → a canonical sale event.
 *
 * Returns `[]` rather than guessing when the jurisdiction cannot be resolved.
 * A sale attributed to the wrong state is worse than a sale we know we could
 * not attribute: the first silently moves a threshold, and the second shows up
 * as a gap someone can ask about. The drain records the skip reason.
 */
export function normalizeCharge(raw: unknown): CanonicalSaleEvent[] {
  const charge = raw as StripeCharge;
  if (!charge.id || typeof charge.amount !== "number" || !charge.currency) return [];
  if (typeof charge.created !== "number") return [];

  const resolved = resolveJurisdiction(charge);
  if (!resolved) return [];

  // Stripe reports integer minor units. No conversion, no rounding, no float.
  const cents = charge.amount;

  return [
    {
      providerEventId: charge.id,
      kind: "sale",
      reversesProviderEventId: null,
      occurredAt: new Date(charge.created * 1000).toISOString(),
      jurisdiction: resolved.jurisdiction,
      jurisdictionSource: resolved.source,
      shipToCountry: resolved.country,
      shipToRegion: resolved.region,
      // Stripe knows the amount charged and nothing about what part of it was
      // retail or taxable. All three bases carry the same figure, and the
      // ledger row says where it came from — inventing a split we cannot
      // observe would be exactly the "confident and wrong" output this product
      // is organised against.
      grossCents: cents,
      retailCents: cents,
      taxableCents: cents,
      transactionCount: 1,
      // Stripe Connect has no marketplace-facilitator concept for a direct
      // charge. A seller whose Stripe account receives marketplace payouts is
      // a Shopify/Amazon question, not a Stripe one (design §6.2).
      marketplaceFacilitated: false,
      currency: charge.currency.toUpperCase(),
    },
  ];
}

/** A refunded charge → the negative row that reverses it. */
export function normalizeRefund(raw: unknown): CanonicalSaleEvent[] {
  const charge = raw as StripeCharge;
  const refunded = charge.amount_refunded ?? 0;
  if (!charge.id || refunded <= 0) return [];

  const sale = normalizeCharge(charge)[0];
  if (!sale) return [];

  return [
    {
      ...sale,
      // A distinct provider id, so the refund and its sale do not collide on
      // the dedupe key. `kind` is also in that key, so this is belt to that
      // braces — and it makes the row legible without decoding the key.
      providerEventId: `${charge.id}:refund`,
      kind: "refund",
      reversesProviderEventId: charge.id,
      grossCents: -refunded,
      retailCents: -refunded,
      taxableCents: -refunded,
      transactionCount: -1,
    },
  ];
}

interface Resolved {
  jurisdiction: string;
  source: CanonicalSaleEvent["jurisdictionSource"];
  country: string | null;
  region: string | null;
}

/**
 * Ship-to jurisdiction, with the fallback that fired recorded (design §6.2, R4).
 *
 * Order: shipping address → billing address. Stripe has no `tax_lines` on a
 * charge, so the third fallback of §6.2 does not apply here; it is Shopify's.
 * "We guessed" must be visible in the evidence rather than laundered into a
 * fact, which is why the level is returned rather than dropped.
 */
function resolveJurisdiction(charge: StripeCharge): Resolved | null {
  const candidates: Array<[StripeAddress | null | undefined, Resolved["source"]]> = [
    [charge.shipping?.address, "shipping_address"],
    [charge.billing_details?.address, "billing_address"],
  ];

  for (const [address, source] of candidates) {
    if (!address?.country) continue;
    const country = address.country.toUpperCase();
    const region = address.state ? address.state.toUpperCase() : null;
    if (country === "US") {
      // A US charge with no state cannot be attributed to a jurisdiction, and
      // "US" is not a jurisdiction this product measures. Fall through to the
      // next candidate rather than inventing one.
      if (!region) continue;
      return { jurisdiction: `US-${region}`, source, country, region };
    }
    return { jurisdiction: country, source, country, region };
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
