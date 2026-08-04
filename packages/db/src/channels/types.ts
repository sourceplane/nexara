// Repository types for the channels bounded context.
//
// Owns `nexus.channels` (write) and `nexus.inbound_deliveries`. The nexus
// repository holds read-only channel lookups the ledger needs; the two do not
// overlap on writes.
//
// Column unions declared locally, matching every other repository here —
// `@saas/db` has no contract dependency by design.

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

export type ChannelProvider = "stripe" | "shopify" | "csv";
export type ChannelStatusKind = "backfilling" | "connected" | "degraded" | "revoked";
export type DeliveryStatusKind = "received" | "applied" | "skipped" | "failed";

export type ChannelsRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "invalid"; message: string }
  | { kind: "internal"; message: string };

export type ChannelsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ChannelsRepositoryError };

export interface ChannelRow {
  id: string;
  orgId: string;
  provider: ChannelProvider;
  externalAccountId: string;
  displayName: string;
  status: ChannelStatusKind;
  credentialsRef: string | null;
  backfillStartedAt: Date | null;
  backfillCompletedAt: Date | null;
  backfillCursor: string | null;
  lookbackFloor: string;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

export interface CreateChannelInput {
  id: string;
  provider: ChannelProvider;
  externalAccountId: string;
  displayName: string;
  credentialsRef: string | null;
  /** Set at creation, before the backfill starts — the seam (design §6.3). */
  backfillStartedAt: Date | null;
  lookbackFloor: string;
  now: Date;
}

export interface DeliveryRow {
  id: string;
  orgId: string | null;
  channelId: string | null;
  provider: ChannelProvider;
  providerDeliveryId: string;
  /** Null once purged. Never returned by a tenant-facing read. */
  payload: unknown;
  signatureVerified: boolean;
  status: DeliveryStatusKind;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  receivedAt: Date;
  appliedAt: Date | null;
  purgedAt: Date | null;
}

export interface ReceiveDeliveryInput {
  id: string;
  provider: ChannelProvider;
  providerDeliveryId: string;
  payload: unknown;
  signatureVerified: boolean;
  receivedAt: Date;
}

export interface RetentionPolicy {
  /** Days a payload survives after `applied_at`. */
  appliedDays: number;
  /** Days a terminally-failed payload survives after `received_at`. */
  failedDays: number;
}

export interface ChannelsRepository {
  createChannel(orgId: Uuid, input: CreateChannelInput): Promise<ChannelsResult<ChannelRow>>;
  getChannelById(orgId: Uuid, id: Uuid): Promise<ChannelsResult<ChannelRow>>;
  listChannels(orgId: Uuid): Promise<ChannelsResult<ChannelRow[]>>;
  findLiveChannel(
    orgId: Uuid,
    provider: ChannelProvider,
    externalAccountId: string,
  ): Promise<ChannelsResult<ChannelRow | null>>;
  updateChannelStatus(
    orgId: Uuid,
    id: Uuid,
    status: ChannelStatusKind,
    now: Date,
  ): Promise<ChannelsResult<ChannelRow>>;
  advanceBackfill(
    orgId: Uuid,
    id: Uuid,
    cursor: string | null,
    completedAt: Date | null,
    now: Date,
  ): Promise<ChannelsResult<ChannelRow>>;
  revokeChannel(orgId: Uuid, id: Uuid, now: Date): Promise<ChannelsResult<ChannelRow>>;
  /** Interval sample (hours between consecutive events) for the Q4 baseline. */
  recentEventIntervalsHours(orgId: Uuid, channelId: Uuid, sample: number): Promise<ChannelsResult<number[]>>;

  /**
   * The one cross-tenant channel lookup: delivery → the channel that owns the
   * provider account, which is how attribution happens at all. Declared on the
   * interface with its exemption rather than reached for by a cast, so the
   * tenancy scan sees it and a reviewer can argue with it.
   */
  findChannelByExternalAccount(
    provider: ChannelProvider,
    externalAccountId: string,
  ): Promise<ChannelsResult<ChannelRow | null>>;

  /** Idempotent receipt. Returns null when the delivery was already received. */
  receiveDelivery(input: ReceiveDeliveryInput): Promise<ChannelsResult<DeliveryRow | null>>;
  /** The drain's due-work batch. Necessarily un-scoped — attribution has not happened. */
  claimDueDeliveries(limit: number, now: Date): Promise<ChannelsResult<DeliveryRow[]>>;
  markDeliveryApplied(
    id: Uuid,
    orgId: Uuid | null,
    channelId: Uuid | null,
    now: Date,
  ): Promise<ChannelsResult<void>>;
  markDeliverySkipped(id: Uuid, reason: string, now: Date): Promise<ChannelsResult<void>>;
  scheduleDeliveryRetry(id: Uuid, attempts: number, nextAttemptAt: Date, reason: string): Promise<ChannelsResult<void>>;
  markDeliveryFailed(id: Uuid, reason: string, now: Date): Promise<ChannelsResult<void>>;
  listDeliveries(orgId: Uuid, limit: number): Promise<ChannelsResult<DeliveryRow[]>>;
  /** Q6: null the payload on terminal deliveries past their grace period. */
  purgeExpiredPayloads(policy: RetentionPolicy, now: Date, limit: number): Promise<ChannelsResult<number>>;
}
