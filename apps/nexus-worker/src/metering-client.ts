// Usage reporting, as reached from `nexus-worker`.
//
// The counterpart to `billing-client.ts`: that one asks "how many jurisdictions
// is this org entitled to monitor", this one reports how many it actually did.
// Limits worked without this; what was missing was the reporting half.
//
// Two properties are the whole design.
//
// **It is deterministic and therefore idempotent.** The evaluation cron runs
// hourly and re-measures any org with new ledger activity. A usage row per run
// would report twenty-four "jurisdictions monitored" facts a day for a number
// that changed once, and the rollup would then measure how often the cron ran
// rather than what the seller used. So the idempotency key is derived from the
// org, the metric and the **period** — one row per org per metric per hour, no
// matter how many times the cron fires inside it. `metering-worker` reports a
// repeat as `duplicate: true` with a 200, which is the expected steady state.
//
// **It never fails the caller.** Every function here resolves rather than
// throws, and the caller ignores the result. Usage reporting is bookkeeping
// downstream of the determination; a metering outage must not cost a seller
// the measurement of their tax exposure, and an exception thrown here would
// abort the org's evaluation partway. This is the same direction the
// entitlement gate fails (open, in `entitlements.ts`) and for the same reason:
// billing questions must not break the compliance answer.

/**
 * Internal caller identity presented to metering-worker on its
 * service-binding-only usage route. A non-secret provenance contract; keep in
 * sync with `apps/metering-worker/src/internal-callers.ts`.
 */
export const INTERNAL_CALLER = "nexus-worker";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type UsageReportOutcome =
  | { kind: "recorded" }
  | { kind: "duplicate" }
  | { kind: "service_error" };

/**
 * The period bucket a usage fact belongs to: the UTC hour of `asOf`, as
 * `YYYY-MM-DDTHH`.
 *
 * UTC rather than a jurisdiction's timezone, deliberately — unlike a
 * measurement window, this is a billing-side bucket about when we observed the
 * org, not about which day a sale fell on. Borrowing the engine's timezone
 * logic here would imply a relationship between the two that does not exist.
 *
 * Pure and takes its instant as a parameter, so it is testable without a clock.
 */
export function usagePeriodKey(asOf: Date): string {
  return asOf.toISOString().slice(0, 13);
}

/** The idempotency key for one org's metric in one period. */
export function usageIdempotencyKey(orgPublicId: string, metric: string, asOf: Date): string {
  return `nexus:${orgPublicId}:${metric}:${usagePeriodKey(asOf)}`;
}

/**
 * Report one metered dimension. Resolves `service_error` on any failure and
 * never throws — see the header.
 */
export async function reportUsage(
  meteringWorker: Fetcher | undefined,
  orgPublicId: string,
  metric: string,
  quantity: number,
  asOf: Date,
  requestId: string,
): Promise<UsageReportOutcome> {
  if (!meteringWorker) return { kind: "service_error" };

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
        idempotencyKey: usageIdempotencyKey(orgPublicId, metric, asOf),
        recordedAt: asOf.toISOString(),
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
