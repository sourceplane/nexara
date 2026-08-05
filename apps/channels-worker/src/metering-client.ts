// Usage reporting from the inbound drain.
//
// A near-copy of `apps/nexus-worker/src/metering-client.ts` — same convention
// as the billing clients: two independently deployed Workers, and a shared
// module would couple their release cycles to save forty lines.
//
// But the IDEMPOTENCY SCHEME IS DELIBERATELY DIFFERENT, and copying the other
// one would have been a silent data-loss bug. The two dimensions are different
// kinds of number:
//
//   * `jurisdictions_monitored` is a **gauge** — a level. The cron re-measures
//     the same level every hour, so one row per org per hour is exactly right
//     and a duplicate is correctly discarded. Its key is period-derived.
//
//   * `sale_events_ingested` is a **counter** — a volume. The drain runs every
//     minute and each tick appends a DIFFERENT batch of events. A period-keyed
//     counter would record the first batch of each hour and silently drop the
//     other fifty-nine, so the seller's usage would read as a fraction of what
//     they actually sent.
//
// So the counter is keyed on the **batch**: a deterministic hash of the
// delivery ids whose events this report covers. Re-running the identical batch
// (a retried tick) produces the identical key and dedupes; a new batch always
// produces a new key and is always counted. That inherits the drain's own
// exactly-once guarantee rather than inventing a second one.
//
// As in nexus-worker, nothing here throws: ingestion must not fail because
// bookkeeping did.

/**
 * Internal caller identity presented to metering-worker. Keep in sync with
 * `apps/metering-worker/src/internal-callers.ts`.
 */
export const INTERNAL_CALLER = "channels-worker";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type UsageReportOutcome =
  | { kind: "recorded" }
  | { kind: "duplicate" }
  | { kind: "service_error" };

/**
 * FNV-1a over the sorted delivery ids. Pure, synchronous and stable across
 * runs and processes — `crypto.subtle` is async and a `Math.random` suffix
 * would defeat the entire point, since a retry must reproduce the key exactly.
 *
 * Sorted so that the same set of deliveries hashes the same regardless of the
 * order the drain happened to claim them in.
 */
export function batchKey(deliveryIds: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of [...deliveryIds].sort()) {
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      // >>> 0 keeps this in unsigned 32-bit space; Math.imul does the
      // multiply without losing precision to float64.
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x2c, 0x01000193) >>> 0; // separator
  }
  return hash.toString(16).padStart(8, "0");
}

/** The idempotency key for one org's counter over one specific batch. */
export function usageIdempotencyKey(
  orgPublicId: string,
  metric: string,
  deliveryIds: readonly string[],
): string {
  return `nexus:${orgPublicId}:${metric}:batch-${batchKey(deliveryIds)}`;
}

export async function reportBatchUsage(
  meteringWorker: Fetcher | undefined,
  orgPublicId: string,
  metric: string,
  quantity: number,
  deliveryIds: readonly string[],
  recordedAt: Date,
  requestId: string,
): Promise<UsageReportOutcome> {
  if (!meteringWorker) return { kind: "service_error" };
  if (deliveryIds.length === 0) return { kind: "duplicate" };

  let response: Response;
  try {
    response = await meteringWorker.fetch("http://metering-worker/v1/internal/metering/usage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
      },
      body: JSON.stringify({
        orgId: orgPublicId,
        metric,
        quantity,
        idempotencyKey: usageIdempotencyKey(orgPublicId, metric, deliveryIds),
        recordedAt: recordedAt.toISOString(),
      }),
    });
  } catch {
    return { kind: "service_error" };
  }

  if (!response.ok) return { kind: "service_error" };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "service_error" };
  }

  const data =
    parsed && typeof parsed === "object" && "data" in parsed
      ? (parsed as { data: unknown }).data
      : null;
  if (!data || typeof data !== "object") return { kind: "service_error" };

  return (data as { duplicate?: unknown }).duplicate === true
    ? { kind: "duplicate" }
    : { kind: "recorded" };
}
