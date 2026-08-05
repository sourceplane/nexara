// `POST /v1/internal/metering/usage` — usage recorded by a Worker, not a user.
//
// The public `POST /v1/organizations/:orgId/usage` route resolves an actor,
// fetches their membership context and asks the policy worker whether they may
// write. That is the right shape for a request a human made. It is the wrong
// shape — and simply unavailable — for the two callers that produce nexus
// usage:
//
//   * the hourly evaluation cron, which measures every org with new ledger
//     activity and has no session, no subject, and no membership; and
//   * the inbound drain, which is woken by a provider webhook.
//
// Inventing a service account for them would put a credential with
// organization.metering.write on every org into two more workers, which is a
// larger authorization surface than the seam it would be paying for. So this
// route drops the *actor* check and keeps every other property:
//
//   - provenance is asserted by the service-binding allow-list
//     (`../internal-callers.ts`), failing closed before any DB access;
//   - the org is named explicitly in the body and every write is scoped to it;
//   - validation is the same as the public path, because a malformed metric
//     from a cron is exactly as wrong as one from a user.
//
// **Idempotency is the load-bearing property here.** These callers retry: the
// cron re-runs hourly and the drain redelivers. `idempotencyKey` is a required
// field and a duplicate is reported as `duplicate: true` with a 200 rather than
// a 409, because for a scheduled reporter a repeat is the expected steady state
// and not an error worth waking anyone over. A caller that wants
// exactly-one-row-per-period passes a key derived from the period; see
// `apps/nexus-worker/src/metering-client.ts`.

import type { Env } from "../env.js";
import type { UsageRecord } from "@saas/db/metering";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createMeteringRepository } from "@saas/db/metering";
import { successResponse, errorResponse, validationError } from "../http.js";
import { generateUsageRecordId, parseOrgPublicId } from "../ids.js";
import { validateMetadata } from "../metadata.js";

/** Wire shape of the internal record-usage request. */
interface InternalRecordUsageRequest {
  orgId?: unknown;
  metric?: unknown;
  quantity?: unknown;
  idempotencyKey?: unknown;
  recordedAt?: unknown;
  metadata?: unknown;
}

const METRIC_RE = /^[a-z][a-z0-9_]{0,63}$/;

export async function handleRecordInternalUsage(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, "Invalid JSON body");
  }
  if (!body || typeof body !== "object") {
    return validationError(requestId, "Request body must be an object");
  }

  const input = body as InternalRecordUsageRequest;

  // The org is a body field rather than a path segment because this seam is
  // not org-scoped by URL — it is a single internal endpoint that names its
  // subject. It is still parsed and validated exactly like a path org id.
  if (typeof input.orgId !== "string" || !input.orgId) {
    return validationError(requestId, "orgId is required and must be a string");
  }
  const orgId = parseOrgPublicId(input.orgId);
  if (!orgId) {
    return validationError(requestId, "Invalid orgId format");
  }

  if (typeof input.metric !== "string" || !METRIC_RE.test(input.metric)) {
    return validationError(requestId, "metric is required and must be a snake_case identifier");
  }

  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey) {
    return validationError(requestId, "idempotencyKey is required and must be a string");
  }

  // A negative quantity would silently reduce a rollup, which is how a usage
  // ledger stops matching the thing it measures.
  if (
    input.quantity !== undefined &&
    (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0)
  ) {
    return validationError(requestId, "quantity must be a non-negative finite number");
  }

  let recordedAt: Date | undefined;
  if (input.recordedAt !== undefined) {
    if (typeof input.recordedAt !== "string" || Number.isNaN(Date.parse(input.recordedAt))) {
      return validationError(requestId, "recordedAt must be an ISO-8601 timestamp");
    }
    recordedAt = new Date(input.recordedAt);
  }

  const metaResult = validateMetadata(input.metadata);
  if (!metaResult.ok) {
    return validationError(requestId, metaResult.message);
  }

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createMeteringRepository(executor);
    const result = await repo.recordUsage({
      id: generateUsageRecordId(),
      orgId,
      // Nexus usage is organization-wide. There is no project or environment
      // to attribute it to, and inventing one would make the rollups lie.
      projectId: null,
      environmentId: null,
      resourceId: null,
      metric: input.metric,
      quantity: input.quantity ?? 1,
      idempotencyKey: input.idempotencyKey,
      ...(recordedAt ? { recordedAt } : {}),
      metadata: metaResult.value,
    });

    if (!result.ok) {
      if (result.error.kind === "conflict") {
        // Expected steady state for a periodic reporter, not an incident.
        return successResponse({ recorded: false, duplicate: true }, requestId, 200);
      }
      return errorResponse("internal_error", "Failed to record usage", 500, requestId);
    }

    return successResponse(
      { recorded: true, duplicate: false, usageRecordId: (result.value as UsageRecord).id },
      requestId,
      201,
    );
  } finally {
    await executor.dispose();
  }
}
