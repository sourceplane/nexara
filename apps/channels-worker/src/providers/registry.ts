// Provider resolution from per-environment credentials.
//
// Returns null when a provider's credential set is incomplete, and callers
// report a parked, safe error rather than a 500. An adapter that "works" until
// it reaches the network is worse than one that says up front it cannot: the
// first produces a channel that looks connected and ingests nothing, which is
// indistinguishable from a seller with no sales.

import type { Env } from "../env.js";
import type { ProviderResolution } from "./types.js";
import { createStripeProvider } from "./stripe.js";

export type ProviderId = "stripe" | "shopify";

export const KNOWN_PROVIDERS: readonly ProviderId[] = ["stripe", "shopify"];

export function isKnownProvider(value: string): value is ProviderId {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

export function resolveProvider(env: Env, id: ProviderId): ProviderResolution {
  switch (id) {
    case "stripe": {
      const clientId = env.STRIPE_CLIENT_ID;
      const secretKey = env.STRIPE_SECRET_KEY;
      const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
      if (!clientId || !secretKey || !webhookSecret) return null;
      return createStripeProvider({ clientId, secretKey, webhookSecret });
    }
    case "shopify":
      // NX7. Resolving to null here is the honest state: the adapter does not
      // exist, so a connect attempt is a parked 501 rather than a channel that
      // never ingests.
      return null;
    default:
      return null;
  }
}
