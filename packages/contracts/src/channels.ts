// Channels contracts — connected sales channels and the ingestion inbox.
// Owner: channels-worker (apps/channels-worker).
//
// Safe projections only. Provider access tokens are never rows in a table this
// file describes and never cross this boundary: `PublicChannel` carries a
// `credentialsRef` *pointer* into the secret store, and raw provider payloads
// stay in the inbox — they carry customer names and addresses, and a log sink
// is precisely where a retention policy stops applying (design §12).
//
// Spec: specs/epics/nexus/design.md §6.

import type {
  JurisdictionSource,
  SaleEventKind,
} from "./nexus.js";

// ── Provider seam ────────────────────────────────────────────

/**
 * Registry-driven provider identifier. `"csv"` is a first-class provider
 * rather than a special case, so a hand-imported ledger has a channel to
 * belong to and the exposure board never has to explain a nullable channel.
 */
export const CHANNEL_PROVIDERS = ["stripe", "shopify", "csv"] as const;
export type ChannelProviderId = (typeof CHANNEL_PROVIDERS)[number];

/**
 * `"backfilling"` is the initial state, not `"connected"`: a channel serving a
 * partial ledger that looks complete is the failure mode this state exists to
 * make visible (design §12).
 */
export const CHANNEL_STATUSES = [
  "backfilling",
  "connected",
  "degraded",
  "revoked",
] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Inbox lifecycle. `"failed"` is terminal — the drain has exhausted its retries. */
export const DELIVERY_STATUSES = ["received", "applied", "skipped", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// ── Channels ─────────────────────────────────────────────────

/** Safe projection of a connected sales channel. Never carries credentials. */
export interface PublicChannel {
  /** Public id, `chn_<32hex>`. */
  id: string;
  orgId: string;
  provider: ChannelProviderId;
  /** Stripe account id, Shopify shop domain, or an operator-chosen CSV label. */
  externalAccountId: string;
  displayName: string;
  status: ChannelStatus;
  /**
   * The live/backfill seam. Live capture's lower bound and backfill's upper
   * bound are both this instant, so the seam is covered from both sides and
   * the dedupe index makes the overlap free (design §6.3).
   */
  backfillStartedAt: string | null;
  /**
   * Set when the backfill cursor exhausts or reaches `lookbackFloor`. Null
   * here with `status: "connected"` would be a bug; null with
   * `status: "backfilling"` is the honest "not yet ingested", which is a
   * different thing from "nothing to ingest".
   */
  backfillCompletedAt: string | null;
  /** ISO date. How far back the backfill walks. 36 months by default. */
  lookbackFloor: string;
  /** Newest `occurredAt` seen from this channel — the staleness signal (R3). */
  lastEventAt: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface ListChannelsResponse {
  channels: PublicChannel[];
}

export interface GetChannelResponse {
  channel: PublicChannel;
}

/**
 * Begin a connect flow. Returns a provider authorize URL carrying a signed,
 * single-use state — the tenancy keystone. The org is carried by *our* state,
 * never inferred from the provider's redirect.
 */
export interface StartChannelConnectRequest {
  provider: ChannelProviderId;
  /** Where the provider sends the operator back to. Must be an allow-listed origin. */
  redirectUri: string;
  displayName?: string;
}

export interface StartChannelConnectResponse {
  /** The provider authorize URL. Empty for `"csv"`, which has no OAuth flow. */
  authorizeUrl: string | null;
  /** Opaque, single-use, short-lived. Echoed back by the provider. */
  state: string;
  expiresAt: string;
}

export interface CompleteChannelConnectRequest {
  provider: ChannelProviderId;
  code: string;
  state: string;
}

export interface CompleteChannelConnectResponse {
  channel: PublicChannel;
}

/** A CSV channel has no OAuth flow, so it is created directly. */
export interface CreateManualChannelRequest {
  displayName: string;
  /** Operator-chosen stable label; the dedupe key is scoped by it. */
  externalAccountId: string;
  /** ISO date. Defaults to 36 months before now. */
  lookbackFloor?: string;
}

export interface CreateManualChannelResponse {
  channel: PublicChannel;
}

export interface RevokeChannelResponse {
  channel: PublicChannel;
}

// ── Backfill ─────────────────────────────────────────────────

export interface BackfillProgress {
  channelId: string;
  status: ChannelStatus;
  startedAt: string | null;
  completedAt: string | null;
  /** ISO date; the oldest `occurredAt` the backfill has reached so far. */
  reachedThrough: string | null;
  lookbackFloor: string;
  /** Events written by the backfill so far. Excludes deduped no-ops. */
  eventsIngested: number;
}

export interface GetBackfillResponse {
  backfill: BackfillProgress;
}

export interface StartBackfillResponse {
  backfill: BackfillProgress;
}

// ── The inbox ────────────────────────────────────────────────

/**
 * Safe projection of an inbound delivery. **Never carries `payload`.** The raw
 * provider body holds customer names and addresses; it lives in
 * `nexus.inbound_deliveries` under a retention policy and is visible only to
 * the audited admin surface.
 */
export interface PublicChannelDelivery {
  /** Public id, `dlv_<32hex>`. */
  id: string;
  /** Null until the drain attributes the delivery to a tenant. */
  orgId: string | null;
  channelId: string | null;
  provider: ChannelProviderId;
  providerDeliveryId: string;
  signatureVerified: boolean;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  /** A short, non-payload reason. Never echoes provider body content. */
  lastError: string | null;
  receivedAt: string;
  appliedAt: string | null;
}

export interface ListDeliveriesResponse {
  deliveries: PublicChannelDelivery[];
}

// ── The normalisation target ─────────────────────────────────

/**
 * The single shape every provider adapter normalises to, and the only shape
 * the ledger accepts. Everything above the adapter — handlers, repository,
 * contracts, console, SDK, CLI — is provider-generic because this type is.
 *
 * Money is integer cents here too. A provider that reports decimal amounts is
 * converted inside its adapter, where the conversion is fixture-tested, and
 * never anywhere else.
 */
export interface CanonicalSaleEvent {
  /** The provider's own id for the charge/order. Half of the dedupe key. */
  providerEventId: string;
  kind: SaleEventKind;
  /** The provider's id for the event this reverses, when `kind` is `"refund"`. */
  reversesProviderEventId: string | null;
  /** The **provider's** timestamp, as a UTC instant. The measurement date. */
  occurredAt: string;
  jurisdiction: string;
  /** Which fallback produced `jurisdiction`. "We guessed" must be visible. */
  jurisdictionSource: JurisdictionSource;
  shipToCountry: string | null;
  shipToRegion: string | null;
  /** Negative on a refund. */
  grossCents: number;
  retailCents: number;
  taxableCents: number;
  /** Negative on a refund. */
  transactionCount: number;
  marketplaceFacilitated: boolean;
  currency: string;
}

/** What an adapter learns about the account it just connected. */
export interface ProviderAccountFacts {
  externalAccountId: string;
  displayName: string;
  /** Opaque pointer into the secret store. Never the token itself. */
  credentialsRef: string;
}

// ── Event types ──────────────────────────────────────────────

export const CHANNEL_EVENT_TYPES = [
  "channels.connection.started",
  "channels.connection.completed",
  "channels.connection.revoked",
  "channels.backfill.started",
  "channels.backfill.completed",
  "channels.delivery.failed",
] as const;
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];
