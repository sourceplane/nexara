// The inbox drain (design §6.4): claim → attribute → normalise → append.
//
// The shipped integrations pattern with the payload type swapped: cron
// `* * * * *`, batch 50, `MAX_ATTEMPTS = 5`, backoff 1m/2m/4m/8m/16m then
// terminal `failed`, each delivery processed independently. We are not
// inventing retry semantics.
//
// The one guarantee that is ours rather than inherited: **the delivery is
// marked `applied` in the SAME transaction that inserts its sale events.**
// That makes the drain exactly-once by construction rather than
// at-least-once-plus-a-dedupe-hope — and it is why a crash mid-drain costs a
// retry rather than a double-counted sale.

import type { CanonicalSaleEvent } from "@saas/contracts/channels";
import {
  createChannelsRepository,
  type ChannelRow,
  type ChannelsRepository,
  type DeliveryRow,
  type RetentionPolicy,
} from "@saas/db/channels";
import { createNexusRepository, type AppendSaleEventInput } from "@saas/db/nexus";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid, type Uuid } from "@saas/db/ids";

import type { Env } from "./env.js";
import { isKnownProvider, resolveProvider } from "./providers/registry.js";

export const BATCH_SIZE = 50;
export const MAX_ATTEMPTS = 5;

/** 1m, 2m, 4m, 8m, 16m — then terminal. */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1), 16) * 60_000;
}

/**
 * Q6 (see `connector-gate.md`). Applied deliveries keep their payload for a
 * week — long enough that a support question from earlier in the week is
 * answerable. Terminally failed ones keep it for a month, because a failed
 * delivery is precisely the one someone will want to look at, and also the one
 * that will not be looked at today.
 */
export const RETENTION: RetentionPolicy = { appliedDays: 7, failedDays: 30 };

export const PURGE_BATCH = 200;

export interface DrainSummary {
  processed: number;
  applied: number;
  skipped: number;
  retried: number;
  failed: number;
  eventsAppended: number;
  duplicates: number;
  /** NX1.5 S-8 / R9: a re-delivery whose money differs from what is stored. */
  divergent: number;
  payloadsPurged: number;
}

export async function drainInbox(
  executor: TransactionalSqlExecutor,
  env: Env,
  now: Date,
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    processed: 0, applied: 0, skipped: 0, retried: 0, failed: 0,
    eventsAppended: 0, duplicates: 0, divergent: 0, payloadsPurged: 0,
  };

  const channels = createChannelsRepository(executor);
  const claimed = await channels.claimDueDeliveries(BATCH_SIZE, now);
  if (!claimed.ok) return summary;

  for (const delivery of claimed.value) {
    summary.processed += 1;
    try {
      const outcome = await processOne(executor, channels, env, delivery, now);
      switch (outcome.kind) {
        case "applied":
          summary.applied += 1;
          summary.eventsAppended += outcome.applied;
          summary.duplicates += outcome.duplicates;
          summary.divergent += outcome.divergent;
          break;
        case "skipped":
          summary.skipped += 1;
          break;
        case "retried":
          summary.retried += 1;
          break;
        case "failed":
          summary.failed += 1;
          break;
      }
    } catch (err) {
      // One delivery's failure must not stop the batch. A single malformed
      // payload freezing every other tenant's ingestion is the shared-fate bug
      // whose symptom is *absence* — the hardest kind to notice.
      const attempts = delivery.attempts + 1;
      const reason = safeReason(err);
      if (attempts >= MAX_ATTEMPTS) {
        await channels.markDeliveryFailed(asUuid(delivery.id), reason, now);
        summary.failed += 1;
      } else {
        await channels.scheduleDeliveryRetry(
          asUuid(delivery.id),
          attempts,
          new Date(now.getTime() + backoffMs(attempts)),
          reason,
        );
        summary.retried += 1;
      }
    }
  }

  // Q6's retention sweep, AFTER the drain's own work: a purge that competes
  // with ingestion for the tick's budget would starve the thing that matters.
  const purged = await channels.purgeExpiredPayloads(RETENTION, now, PURGE_BATCH);
  if (purged.ok) summary.payloadsPurged = purged.value;

  return summary;
}

type Outcome =
  | { kind: "applied"; applied: number; duplicates: number; divergent: number }
  | { kind: "skipped"; reason: string }
  | { kind: "retried" }
  | { kind: "failed"; reason: string };

async function processOne(
  executor: TransactionalSqlExecutor,
  channels: ChannelsRepository,
  env: Env,
  delivery: DeliveryRow,
  now: Date,
): Promise<Outcome> {
  // An unsigned delivery should never have reached the inbox — the ingress
  // rejects it. A row with `signature_verified = false` is therefore an
  // anomaly, and treating it as a skip rather than as work is the fail-closed
  // reading.
  if (!delivery.signatureVerified) {
    await channels.markDeliverySkipped(asUuid(delivery.id), "signature_unverified", now);
    return { kind: "skipped", reason: "signature_unverified" };
  }

  // A purged payload cannot be re-processed. It can only happen if a delivery
  // sat in `received` past the retention window, which the purge predicate
  // excludes — so this is a guard against a future edit of that predicate.
  if (delivery.payload === null) {
    await channels.markDeliverySkipped(asUuid(delivery.id), "payload_purged", now);
    return { kind: "skipped", reason: "payload_purged" };
  }

  if (!isKnownProvider(delivery.provider)) {
    await channels.markDeliverySkipped(asUuid(delivery.id), "unknown_provider", now);
    return { kind: "skipped", reason: "unknown_provider" };
  }
  const provider = resolveProvider(env, delivery.provider);
  if (!provider) {
    // Credentials are incomplete in this environment. A retry is right: the
    // credential may arrive, and the delivery is not wrong.
    throw new Error("provider_unconfigured");
  }

  const attribution = await attribute(channels, delivery);
  if (!attribution) {
    // We do not know whose account this is. Skipping is the fail-closed
    // reading: attributing it to a guess would put one seller's sales on
    // another seller's ledger, which is the worst outcome in the system.
    await channels.markDeliverySkipped(asUuid(delivery.id), "unattributed", now);
    return { kind: "skipped", reason: "unattributed" };
  }

  const canonical = provider.normalize(delivery.payload);
  if (canonical.length === 0) {
    // Providers send dozens of event types we do not care about. Treating them
    // as failures would fill the retry budget with events that will never
    // become sales.
    await channels.markDeliverySkipped(asUuid(delivery.id), "no_sale_events", now);
    return { kind: "skipped", reason: "no_sale_events" };
  }

  // THE guarantee. The ledger insert and the `applied` mark happen in one
  // transaction, so a crash between them rolls both back and the delivery is
  // re-claimed next tick. Without this the drain would be at-least-once and
  // would depend on the dedupe index to clean up after itself — which works,
  // right up until a partially-applied multi-event delivery.
  const result = await executor.transaction(async (tx) => {
    const nexus = createNexusRepository(tx);
    const rows = canonical.map((event) =>
      toAppendInput(event, attribution.channel, delivery.id, attribution.saleIdsByProviderId),
    );
    const append = await nexus.appendSaleEvents(attribution.orgId, rows);
    if (!append.ok) throw new Error(`append_failed_${append.error.kind}`);

    const txChannels = createChannelsRepository(tx);
    await txChannels.markDeliveryApplied(
      asUuid(delivery.id),
      attribution.orgId,
      asUuid(attribution.channel.id),
      now,
    );

    const newest = rows.reduce(
      (max, r) => (r.occurredAt > max ? r.occurredAt : max),
      new Date(0),
    );
    await nexus.touchChannelLastEvent(attribution.orgId, asUuid(attribution.channel.id), newest);

    return append.value;
  });

  return {
    kind: "applied",
    applied: result.applied,
    duplicates: result.duplicates,
    divergent: result.divergent.length,
  };
}

interface Attribution {
  orgId: Uuid;
  channel: ChannelRow;
  /** Provider event id → our sale-event UUID, for resolving `reverses`. */
  saleIdsByProviderId: Map<string, string>;
}

/**
 * Delivery → tenant, via the channel that owns the provider account.
 *
 * The org is never taken from the payload. A provider can be induced to send
 * whatever a caller puts in metadata; the channel row is ours.
 */
async function attribute(
  channels: ChannelsRepository,
  delivery: DeliveryRow,
): Promise<Attribution | null> {
  const accountId = accountIdFromDelivery(delivery);
  if (!accountId) return null;

  const found = await channels.findChannelByExternalAccount(delivery.provider, accountId);
  if (!found.ok || found.value === null) return null;

  return {
    orgId: asUuid(found.value.orgId),
    channel: found.value,
    saleIdsByProviderId: new Map(),
  };
}

/**
 * The provider account this delivery belongs to.
 *
 * Stripe Connect puts it in the envelope's `account` field for events on a
 * connected account. Shopify uses a shop-domain header, which the ingress
 * copies into the stored envelope (NX7).
 */
function accountIdFromDelivery(delivery: DeliveryRow): string | null {
  const payload = delivery.payload as { account?: unknown; __shopDomain?: unknown } | null;
  if (!payload) return null;
  if (typeof payload.account === "string" && payload.account.length > 0) return payload.account;
  if (typeof payload.__shopDomain === "string" && payload.__shopDomain.length > 0) {
    return payload.__shopDomain;
  }
  return null;
}

function toAppendInput(
  event: CanonicalSaleEvent,
  channel: ChannelRow,
  _deliveryId: string,
  _saleIds: Map<string, string>,
): AppendSaleEventInput {
  return {
    id: crypto.randomUUID(),
    channelId: asUuid(channel.id),
    source: "webhook",
    providerEventId: event.providerEventId,
    kind: event.kind,
    // Resolved to null rather than guessed: the composite FK added at NX1.5
    // would refuse a fabricated id, and a refund whose original we have not
    // ingested is legal — the backfill may not have reached it yet. The
    // reversal link is repaired by the console's join on `provider_event_id`
    // when both rows exist.
    reversesEventId: null,
    occurredAt: new Date(event.occurredAt),
    jurisdiction: event.jurisdiction,
    jurisdictionSource: event.jurisdictionSource,
    shipToCountry: event.shipToCountry,
    shipToRegion: event.shipToRegion,
    grossCents: event.grossCents,
    retailCents: event.retailCents,
    taxableCents: event.taxableCents,
    transactionCount: event.transactionCount,
    marketplaceFacilitated: event.marketplaceFacilitated,
    currency: event.currency,
  };
}

/**
 * A short, non-payload reason.
 *
 * Design §12's one prohibition: raw provider payloads never reach a log sink,
 * and `last_error` is a log sink by another name. An error message that
 * happens to include a serialised body would put customer names and addresses
 * in a column the retention policy does not cover.
 */
function safeReason(err: unknown): string {
  const message = err instanceof Error ? err.message : "unknown_error";
  return /^[\w.:-]{1,120}$/.test(message) ? message : "processing_error";
}

export type { SqlExecutor };
