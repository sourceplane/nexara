// The service-binding provenance gate for metering's internal seam.
//
// Deliberately a near-copy of `apps/billing-worker/src/router.ts`'s gate rather
// than a shared import: the two are separate deploy units, and a shared module
// would couple them so that changing one worker's allow-list requires
// redeploying the other. The semantics are the platform's and are matched
// exactly.
//
// This is a **provenance contract, not an authentication credential**. Only
// Workers explicitly bound to metering-worker over a Cloudflare service
// binding can present the header, so it cannot be forged from outside the
// trust boundary — the api-edge metering facade matches only
// `/v1/organizations/…` paths and therefore cannot reach `/v1/internal/…` at
// all. The allow-list exists so the route fails **closed** if a misconfigured
// or unknown binding ever reaches it, before any repository access.
//
// Add a caller here when a bounded context gains a service binding to
// metering-worker. Avoid wildcards.

const INTERNAL_CALLER_HEADER = "x-internal-caller";
const INTERNAL_CALLER_RE = /^[a-z][a-z0-9-]{0,63}$/;

const ALLOWED_INTERNAL_CALLERS: ReadonlySet<string> = new Set([
  // The hourly evaluation cron reports jurisdictions_monitored. It runs with
  // no actor — there is no user present when a scheduled job measures an org.
  "nexus-worker",
  // The inbound drain reports sale_events_ingested and channels_connected as
  // provider deliveries land. Also actorless: the caller is a webhook.
  "channels-worker",
]);

export { INTERNAL_CALLER_HEADER };

export function isAllowedInternalCaller(value: string | null): value is string {
  if (!value) return false;
  if (!INTERNAL_CALLER_RE.test(value)) return false;
  return ALLOWED_INTERNAL_CALLERS.has(value);
}
