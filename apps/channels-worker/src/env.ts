export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  /** Audit + domain events. The append-only log IS the audit trail (design §8). */
  EVENTS_WORKER?: Fetcher;
  ENVIRONMENT: string;

  /** HMAC key for the signed single-use connect state — the tenancy keystone. */
  CONNECT_STATE_SECRET?: string;
  /** AES-256-GCM key (64 hex chars) for the credential envelope. */
  SECRET_ENCRYPTION_KEY?: string;

  // Per-environment provider credentials. An incomplete set resolves the
  // provider to null; see providers/registry.ts.
  STRIPE_CLIENT_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;
}
