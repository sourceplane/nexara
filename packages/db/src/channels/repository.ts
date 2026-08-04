// The channels repository — the only place SQL is written against
// `nexus.channels` (writes) and `nexus.inbound_deliveries`.
//
// Three queries here are necessarily un-scoped and each carries a
// `tenancy-exempt: pre-attribution-inbox` marker at its call site. NX1.5
// finding S-9 narrowed the exemption from "this table" to "these call sites",
// because exempting by table name would disarm the scan for every future read
// of the inbox — including the tenant-facing ones below, which DO scope.

import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  ChannelRow,
  ChannelStatusKind,
  ChannelsRepository,
  ChannelsResult,
  CreateChannelInput,
  DeliveryRow,
  ReceiveDeliveryInput,
  RetentionPolicy,
} from "./types.js";

function safeError(message: string): ChannelsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

function toCivilDate(raw: unknown): string {
  if (raw instanceof Date) {
    return `${raw.getUTCFullYear().toString().padStart(4, "0")}-${(raw.getUTCMonth() + 1)
      .toString().padStart(2, "0")}-${raw.getUTCDate().toString().padStart(2, "0")}`;
  }
  return String(raw ?? "").slice(0, 10);
}

function date(raw: unknown): Date | null {
  return raw === null || raw === undefined ? null : new Date(raw as string);
}

function mapChannel(row: Record<string, unknown>): ChannelRow {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    provider: row.provider as ChannelRow["provider"],
    externalAccountId: row.external_account_id as string,
    displayName: row.display_name as string,
    status: row.status as ChannelStatusKind,
    credentialsRef: (row.credentials_ref as string | null) ?? null,
    backfillStartedAt: date(row.backfill_started_at),
    backfillCompletedAt: date(row.backfill_completed_at),
    backfillCursor: (row.backfill_cursor as string | null) ?? null,
    lookbackFloor: toCivilDate(row.lookback_floor),
    lastEventAt: date(row.last_event_at),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    revokedAt: date(row.revoked_at),
  };
}

function mapDelivery(row: Record<string, unknown>): DeliveryRow {
  const raw = row.payload;
  return {
    id: row.id as string,
    orgId: (row.org_id as string | null) ?? null,
    channelId: (row.channel_id as string | null) ?? null,
    provider: row.provider as DeliveryRow["provider"],
    providerDeliveryId: row.provider_delivery_id as string,
    payload: typeof raw === "string" ? safeParse(raw) : (raw ?? null),
    signatureVerified: Boolean(row.signature_verified),
    status: row.status as DeliveryRow["status"],
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: date(row.next_attempt_at),
    lastError: (row.last_error as string | null) ?? null,
    receivedAt: new Date(row.received_at as string),
    appliedAt: date(row.applied_at),
    purgedAt: date(row.purged_at),
  };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createChannelsRepository(executor: SqlExecutor): ChannelsRepository {
  return {
    async createChannel(orgId: Uuid, input: CreateChannelInput) {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.channels (
             id, org_id, provider, external_account_id, display_name, status,
             credentials_ref, backfill_started_at, lookback_floor, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'backfilling', $6, $7, $8, $9, $9)
           RETURNING *`,
          [
            input.id, orgId, input.provider, input.externalAccountId, input.displayName,
            input.credentialsRef,
            input.backfillStartedAt ? input.backfillStartedAt.toISOString() : null,
            input.lookbackFloor, input.now.toISOString(),
          ],
        );
        return { ok: true as const, value: mapChannel(result.rows[0]!) };
      } catch (err) {
        // The partial unique index on live accounts: connecting the same live
        // account twice is a conflict, reconnecting a revoked one is not.
        if (isUniqueViolation(err)) {
          return { ok: false as const, error: { kind: "conflict" as const, entity: "channel" } };
        }
        return safeError("Failed to create channel");
      }
    },

    async getChannelById(orgId: Uuid, id: Uuid) {
      try {
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.channels WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (r.rowCount === 0) return { ok: false as const, error: { kind: "not_found" as const } };
        return { ok: true as const, value: mapChannel(r.rows[0]!) };
      } catch {
        return safeError("Failed to get channel");
      }
    },

    async listChannels(orgId: Uuid) {
      try {
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.channels WHERE org_id = $1 ORDER BY created_at DESC, id DESC`,
          [orgId],
        );
        return { ok: true as const, value: r.rows.map(mapChannel) };
      } catch {
        return safeError("Failed to list channels");
      }
    },

    async findLiveChannel(orgId: Uuid, provider, externalAccountId: string) {
      try {
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.channels
           WHERE org_id = $1 AND provider = $2 AND external_account_id = $3
             AND revoked_at IS NULL`,
          [orgId, provider, externalAccountId],
        );
        return { ok: true as const, value: r.rowCount === 0 ? null : mapChannel(r.rows[0]!) };
      } catch {
        return safeError("Failed to look up channel");
      }
    },

    async updateChannelStatus(orgId: Uuid, id: Uuid, status: ChannelStatusKind, now: Date) {
      try {
        const r = await executor.execute<Record<string, unknown>>(
          `UPDATE nexus.channels SET status = $3, updated_at = $4
           WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, id, status, now.toISOString()],
        );
        if (r.rowCount === 0) return { ok: false as const, error: { kind: "not_found" as const } };
        return { ok: true as const, value: mapChannel(r.rows[0]!) };
      } catch {
        return safeError("Failed to update channel status");
      }
    },

    async advanceBackfill(orgId: Uuid, id: Uuid, cursor, completedAt, now: Date) {
      try {
        // `status` flips to 'connected' exactly when the backfill completes —
        // the two must move together, or a channel serving a partial ledger
        // reads as complete (design §12).
        const r = await executor.execute<Record<string, unknown>>(
          `UPDATE nexus.channels
           SET backfill_cursor = $3,
               backfill_completed_at = COALESCE(backfill_completed_at, $4),
               status = CASE WHEN $4::timestamptz IS NOT NULL THEN 'connected' ELSE status END,
               updated_at = $5
           WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, id, cursor, completedAt ? completedAt.toISOString() : null, now.toISOString()],
        );
        if (r.rowCount === 0) return { ok: false as const, error: { kind: "not_found" as const } };
        return { ok: true as const, value: mapChannel(r.rows[0]!) };
      } catch {
        return safeError("Failed to advance backfill");
      }
    },

    async revokeChannel(orgId: Uuid, id: Uuid, now: Date) {
      try {
        const r = await executor.execute<Record<string, unknown>>(
          `UPDATE nexus.channels
           SET status = 'revoked', revoked_at = $3, credentials_ref = NULL, updated_at = $3
           WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING *`,
          [orgId, id, now.toISOString()],
        );
        if (r.rowCount === 0) return { ok: false as const, error: { kind: "not_found" as const } };
        // The ledger rows stay. Revoking a channel stops ingestion; it does
        // not retract history, and a determination that cited those sales must
        // still re-derive.
        return { ok: true as const, value: mapChannel(r.rows[0]!) };
      } catch {
        return safeError("Failed to revoke channel");
      }
    },

    async recentEventIntervalsHours(orgId: Uuid, channelId: Uuid, sample: number) {
      try {
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT EXTRACT(EPOCH FROM (occurred_at - LAG(occurred_at) OVER (ORDER BY occurred_at))) / 3600.0 AS gap
           FROM (
             SELECT occurred_at FROM nexus.sale_events
             WHERE org_id = $1 AND channel_id = $2
             ORDER BY occurred_at DESC
             LIMIT $3
           ) recent
           ORDER BY occurred_at`,
          [orgId, channelId, sample],
        );
        const gaps = r.rows
          .map((row) => Number(row.gap))
          .filter((n) => Number.isFinite(n) && n >= 0);
        return { ok: true as const, value: gaps };
      } catch {
        return safeError("Failed to sample channel intervals");
      }
    },

    async findChannelByExternalAccount(provider, externalAccountId: string) {
      try {
        // tenancy-exempt: pre-attribution-inbox — a webhook is authenticated by
        // a signature, not a session, and this query is what RESOLVES the
        // tenant. It cannot be scoped by the org it is about to determine.
        //
        // It returns at most one row: the partial unique index on live
        // channels makes (provider, external_account_id) unique among
        // un-revoked rows across all tenants, because one Stripe account
        // belongs to one seller. LIMIT 1 with a revoked-at filter is the
        // whole safety argument, and `ORDER BY created_at DESC` makes a
        // reconnected account resolve to the current channel rather than an
        // older revoked one.
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.channels
           WHERE provider = $1 AND external_account_id = $2 AND revoked_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [provider, externalAccountId],
        );
        return { ok: true as const, value: r.rowCount === 0 ? null : mapChannel(r.rows[0]!) };
      } catch {
        return safeError("Failed to resolve channel by account");
      }
    },

    async receiveDelivery(input: ReceiveDeliveryInput) {
      try {
        // tenancy-exempt: pre-attribution-inbox — a webhook is authenticated
        // by a signature, not a session. The org is unknown until the drain
        // resolves it; writing a guessed org here is exactly how a delivery
        // ends up on the wrong tenant's ledger.
        //
        // A duplicate POST returns nothing and the endpoint returns 200 —
        // which is what a provider's retry logic needs to see.
        const r = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.inbound_deliveries
             (id, provider, provider_delivery_id, payload, signature_verified, status, received_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, 'received', $6)
           ON CONFLICT (provider, provider_delivery_id) DO NOTHING
           RETURNING *`,
          [
            input.id, input.provider, input.providerDeliveryId,
            JSON.stringify(input.payload), input.signatureVerified,
            input.receivedAt.toISOString(),
          ],
        );
        return { ok: true as const, value: r.rowCount === 0 ? null : mapDelivery(r.rows[0]!) };
      } catch {
        return safeError("Failed to receive delivery");
      }
    },

    async claimDueDeliveries(limit: number, now: Date) {
      try {
        // tenancy-exempt: pre-attribution-inbox — the drain's due-work query
        // spans tenants by necessity; attribution is what it is about to do.
        //
        // FOR UPDATE SKIP LOCKED so two overlapping cron invocations do not
        // process the same delivery twice. The apply is exactly-once by
        // transaction anyway, but doing the work twice wastes a tick.
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.inbound_deliveries
           WHERE status = 'received'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           ORDER BY received_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [now.toISOString(), limit],
        );
        return { ok: true as const, value: r.rows.map(mapDelivery) };
      } catch {
        return safeError("Failed to claim deliveries");
      }
    },

    async markDeliveryApplied(id: Uuid, orgId: Uuid | null, channelId: Uuid | null, now: Date) {
      try {
        // tenancy-exempt: pre-attribution-inbox — this is the statement that
        // ATTRIBUTES the delivery, so it cannot already be scoped by the org
        // it is assigning. Run inside the same transaction as the ledger
        // insert, which makes the drain exactly-once by construction.
        await executor.execute(
          `UPDATE nexus.inbound_deliveries
           SET status = 'applied', org_id = $2, channel_id = $3, applied_at = $4, last_error = NULL
           WHERE id = $1`,
          [id, orgId, channelId, now.toISOString()],
        );
        return { ok: true as const, value: undefined };
      } catch {
        return safeError("Failed to mark delivery applied");
      }
    },

    async markDeliverySkipped(id: Uuid, reason: string, now: Date) {
      try {
        // tenancy-exempt: pre-attribution-inbox — a skipped delivery may never
        // have been attributed at all (an unrecognised event type, an account
        // we do not know).
        await executor.execute(
          `UPDATE nexus.inbound_deliveries
           SET status = 'skipped', last_error = $2, applied_at = $3
           WHERE id = $1`,
          [id, reason.slice(0, 500), now.toISOString()],
        );
        return { ok: true as const, value: undefined };
      } catch {
        return safeError("Failed to mark delivery skipped");
      }
    },

    async scheduleDeliveryRetry(id: Uuid, attempts: number, nextAttemptAt: Date, reason: string) {
      try {
        // tenancy-exempt: pre-attribution-inbox
        await executor.execute(
          `UPDATE nexus.inbound_deliveries
           SET attempts = $2, next_attempt_at = $3, last_error = $4
           WHERE id = $1`,
          // `last_error` is a short reason and NEVER echoes provider body
          // content — the payload is PII and a truncated error string is a
          // very easy way to leak it into a log.
          [id, attempts, nextAttemptAt.toISOString(), reason.slice(0, 500)],
        );
        return { ok: true as const, value: undefined };
      } catch {
        return safeError("Failed to schedule delivery retry");
      }
    },

    async markDeliveryFailed(id: Uuid, reason: string, now: Date) {
      try {
        // tenancy-exempt: pre-attribution-inbox
        await executor.execute(
          `UPDATE nexus.inbound_deliveries
           SET status = 'failed', last_error = $2, next_attempt_at = NULL, applied_at = $3
           WHERE id = $1`,
          [id, reason.slice(0, 500), now.toISOString()],
        );
        return { ok: true as const, value: undefined };
      } catch {
        return safeError("Failed to mark delivery failed");
      }
    },

    async listDeliveries(orgId: Uuid, limit: number) {
      try {
        // Tenant-facing, so it scopes — and it selects no payload. The raw
        // body carries customer names and addresses; a list surface that
        // returned it would make the retention policy worthless.
        const r = await executor.execute<Record<string, unknown>>(
          `SELECT id, org_id, channel_id, provider, provider_delivery_id,
                  signature_verified, status, attempts, next_attempt_at,
                  last_error, received_at, applied_at, purged_at
           FROM nexus.inbound_deliveries
           WHERE org_id = $1
           ORDER BY received_at DESC, id DESC
           LIMIT $2`,
          [orgId, limit],
        );
        return { ok: true as const, value: r.rows.map(mapDelivery) };
      } catch {
        return safeError("Failed to list deliveries");
      }
    },

    async purgeExpiredPayloads(policy: RetentionPolicy, now: Date, limit: number) {
      try {
        // tenancy-exempt: pre-attribution-inbox — the retention sweep is a
        // platform obligation across every tenant, and an unattributed
        // delivery that terminally failed still holds PII that must go.
        //
        // Q6: the row is the dedupe RECEIPT and the payload is the PII, so the
        // sweep nulls the payload and keeps the row. Deleting the row would
        // let a provider redelivering after the window be re-applied and
        // double-counted into a threshold.
        const r = await executor.execute<Record<string, unknown>>(
          `UPDATE nexus.inbound_deliveries
           SET payload = NULL, purged_at = $1
           WHERE id IN (
             SELECT id FROM nexus.inbound_deliveries
             WHERE purged_at IS NULL
               AND payload IS NOT NULL
               AND (
                 (status IN ('applied', 'skipped') AND applied_at IS NOT NULL
                    AND applied_at < $1::timestamptz - make_interval(days => $2))
                 OR (status = 'failed'
                    AND received_at < $1::timestamptz - make_interval(days => $3))
               )
             ORDER BY received_at
             LIMIT $4
           )`,
          [now.toISOString(), policy.appliedDays, policy.failedDays, limit],
        );
        return { ok: true as const, value: r.rowCount };
      } catch {
        return safeError("Failed to purge expired payloads");
      }
    },
  };
}
