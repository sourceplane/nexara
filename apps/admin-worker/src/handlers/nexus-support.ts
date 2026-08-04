// The nexus support view (NX8).
//
// Support answering "why does my board say this" needs to see exactly what the
// merchant saw: the channel and backfill state, the determination history with
// its stored inputs, and the drain's failed deliveries for that tenant.
//
// **Read-only, without exception.** No re-evaluation, no ledger edit, no
// determination override, and no way to add one later without this file
// growing a verb — which `nexus-support-readonly.test.ts` fails the build over.
// A support tool that can *change* a determination turns the audit record into
// an opinion, which is the one thing this product sells against.
//
// Two properties are worth stating because they are not obvious:
//
//   1. **Every query still names exactly one org.** Support may read *any*
//      tenant, but it never reads across tenants: the target org id is parsed
//      from the path and passed to the same org-scoped repository methods the
//      merchant's own console calls. The tenancy scan therefore needs no new
//      exemption for this surface, and a support read cannot become a
//      cross-tenant read by accident.
//   2. **Payloads are not here.** The inbox rows are the safe projection —
//      status, attempts, and a short non-payload reason. The raw provider body
//      carries customer names and addresses and is subject to the Q6 retention
//      policy; a support surface that returned it would make that policy
//      decorative, and design §12 already forbids those bytes reaching a log
//      sink.
//
// Not reachable from a browser today. `admin-worker` is not exposed through
// `api-edge` and the support-role claim is header-carried from a trusted
// internal caller; routing it to the public edge would need a staff identity
// the platform does not have. See `specs/epics/nexus/support-view.md`.

import type { Env } from "../env.js";
import type { SupportActor } from "../support-auth.js";
import type { ChannelRow, ChannelsRepository, DeliveryRow } from "@saas/db/channels";
import type { DeterminationRow, NexusRepository } from "@saas/db/nexus";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createChannelsRepository } from "@saas/db/channels";
import { createNexusRepository } from "@saas/db/nexus";
import { uuidFromPublicId } from "@saas/db/ids";
import { authorizeSupportAction } from "../support-auth.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, generateSupportActionUuid } from "../ids.js";
import { emitAccessDenied } from "./record-support-action.js";
import type { SupportRequestContext } from "./record-support-action.js";

/** Bounded, always. An unbounded scan is not reachable through this surface. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface NexusSupportDeps {
  nexusRepo: Pick<NexusRepository, "listDeterminationsPaged" | "listRegistrations">;
  channelsRepo: Pick<ChannelsRepository, "listChannels" | "listDeliveries">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * The safe projection of a determination for support.
 *
 * `inputs` is included **verbatim**, and that is the point: support looking at
 * a prettified summary is support looking at a different thing than the
 * merchant, which is how "it says X on my screen" becomes an unresolvable
 * ticket. The inputs carry aggregates and dates, never customer identity.
 */
function publicDetermination(d: DeterminationRow): Record<string, unknown> {
  return {
    id: d.id,
    jurisdiction: d.jurisdiction,
    evaluatedAt: d.evaluatedAt.toISOString(),
    ruleSetVersion: d.ruleSetVersion,
    ruleId: d.ruleId,
    engineVersion: d.engineVersion,
    periodStart: d.periodStart.toISOString(),
    periodEnd: d.periodEnd.toISOString(),
    measuredSalesCents: d.measuredSalesCents,
    measuredTransactions: d.measuredTransactions,
    thresholdSalesCents: d.thresholdSalesCents,
    thresholdTransactions: d.thresholdTransactions,
    status: d.status,
    crossedOn: d.crossedOn,
    registrationDueOn: d.registrationDueOn,
    inputs: d.inputs,
    internalOnly: d.internalOnly,
  };
}

function publicChannel(c: ChannelRow): Record<string, unknown> {
  return {
    id: c.id,
    provider: c.provider,
    externalAccountId: c.externalAccountId,
    displayName: c.displayName,
    status: c.status,
    backfillStartedAt: c.backfillStartedAt?.toISOString() ?? null,
    backfillCompletedAt: c.backfillCompletedAt?.toISOString() ?? null,
    lookbackFloor: c.lookbackFloor,
    lastEventAt: c.lastEventAt?.toISOString() ?? null,
    revokedAt: c.revokedAt?.toISOString() ?? null,
  };
}

/** No `payload`. Not omitted for brevity — omitted because it is PII. */
function publicDelivery(d: DeliveryRow): Record<string, unknown> {
  return {
    id: d.id,
    provider: d.provider,
    providerDeliveryId: d.providerDeliveryId,
    signatureVerified: d.signatureVerified,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    lastError: d.lastError,
    receivedAt: d.receivedAt.toISOString(),
    appliedAt: d.appliedAt?.toISOString() ?? null,
    payloadPurged: d.purgedAt !== null,
  };
}

function parseLimit(url: URL | undefined): { ok: true; value: number } | { ok: false; reason: string } {
  const raw = url?.searchParams.get("limit");
  if (raw === null || raw === undefined) return { ok: true, value: DEFAULT_LIMIT };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return { ok: false, reason: `Must be an integer between 1 and ${MAX_LIMIT}` };
  }
  return { ok: true, value: parsed };
}

/**
 * Deny-by-default guard, shared by every read below.
 *
 * Reading another tenant's compliance history is itself a support action: it
 * fails closed and audits the denial, exactly like the lookups already here.
 */
async function guard(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  targetOrgId: string,
  attemptedAction: string,
  now: Date,
  genId: () => string,
  deps?: NexusSupportDeps,
): Promise<Response | null> {
  const decision = authorizeSupportAction({
    actor: ctx.actor,
    supportRoleClaim: ctx.supportRoleClaim,
    systemOverride: ctx.systemOverride,
  });
  if (decision.allow) return null;

  const denialActor: SupportActor = ctx.actor ?? { subjectId: "anonymous", subjectType: "user" };
  const denialInput = {
    actor: denialActor,
    targetOrgId,
    attemptedAction,
    reason: decision.reason,
    requestId,
    occurredAt: now,
    genId,
  };
  if (deps?.eventsRepo) {
    await emitAccessDenied(env, {
      ...denialInput,
      deps: { supportRepo: {} as never, eventsRepo: deps.eventsRepo },
    });
  } else {
    await emitAccessDenied(env, denialInput);
  }
  return errorResponse("forbidden", "Support action denied", 403, requestId, {
    reason: decision.reason,
  });
}

/**
 * GET /v1/internal/support/organizations/:orgId/nexus
 *
 * One call, because a support agent reading a board triages three things at
 * once — is the data arriving, what did we decide, and what did the seller say
 * they did about it — and three round trips invites reading two of them from
 * different moments.
 */
export async function handleNexusSupportView(
  env: Env,
  requestId: string,
  ctx: SupportRequestContext,
  targetOrgIdParam: string,
  url?: URL,
  deps?: NexusSupportDeps,
): Promise<Response> {
  // Branded decode, so the target org id cannot reach a UUID column in its
  // public `org_<hex>` form — a compile error rather than a runtime crash.
  const targetOrgUuid = uuidFromPublicId(targetOrgIdParam, "org");
  if (!targetOrgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => generateSupportActionUuid());

  const denied = await guard(
    env,
    requestId,
    ctx,
    targetOrgUuid,
    "support.nexus.view",
    now,
    genId,
    deps,
  );
  if (denied) return denied;

  const limit = parseLimit(url);
  if (!limit.ok) return validationError(requestId, { limit: [limit.reason] });

  const jurisdiction = url?.searchParams.get("jurisdiction") ?? null;
  if (jurisdiction !== null && !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction)) {
    return validationError(requestId, { jurisdiction: ["Must be a jurisdiction code like US-TX"] });
  }

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (!deps && !env.PLATFORM_DB) {
      return errorResponse("internal_error", "Database not configured", 503, requestId);
    }
    const nexusRepo = deps?.nexusRepo ?? createNexusRepository(executor!);
    const channelsRepo = deps?.channelsRepo ?? createChannelsRepository(executor!);

    // Every one of these is the same org-scoped method the merchant's own
    // console calls, with the *target* org id. Support reads a different
    // tenant; it never reads across tenants.
    const [determinations, channels, deliveries, registrations] = await Promise.all([
      nexusRepo.listDeterminationsPaged(targetOrgUuid, jurisdiction, {
        limit: limit.value,
        cursor: null,
      }),
      channelsRepo.listChannels(targetOrgUuid),
      channelsRepo.listDeliveries(targetOrgUuid, limit.value),
      nexusRepo.listRegistrations(targetOrgUuid),
    ]);

    if (!determinations.ok || !channels.ok || !deliveries.ok || !registrations.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse(
      {
        orgId: orgPublicId(targetOrgUuid),
        channels: channels.value.map(publicChannel),
        determinations: determinations.value.items.map(publicDetermination),
        registrations: registrations.value.map((r) => ({
          jurisdiction: r.jurisdiction,
          status: r.status,
          registeredOn: r.registeredOn,
          updatedAt: r.updatedAt.toISOString(),
        })),
        // Failed first: the reason a support ticket exists is usually in here.
        deliveries: [...deliveries.value]
          .sort((a, b) => (a.status === "failed" ? 0 : 1) - (b.status === "failed" ? 0 : 1))
          .map(publicDelivery),
      },
      requestId,
      200,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
