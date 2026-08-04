// GET /v1/organizations/:orgId/ledger — the append-only ledger, filterable.
//
// A refund is shown as its own row linked to the original, never as a mutation
// of it. That is the whole point of invariant 2 being visible in the product
// rather than only in the schema: a merchant who can see the reversal can
// check our arithmetic.

import type { NexusRepository, LedgerFilters } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, validationError } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { toPublicSaleEvent } from "../mappers.js";
import { parseChannelPublicId } from "../ids.js";
import { isKnownJurisdictionCode } from "../jurisdictions.js";

export interface HandleListLedgerDeps {
  repo?: NexusRepository;
}

export async function handleListLedger(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListLedgerDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const url = new URL(request.url);
  const pageResult = parsePageParams(url);
  if (!pageResult.ok) {
    return validationError(requestId, { [pageResult.field]: [pageResult.reason] });
  }

  const filters: LedgerFilters = {};
  const jurisdiction = url.searchParams.get("jurisdiction");
  if (jurisdiction) {
    if (!isKnownJurisdictionCode(jurisdiction)) {
      return validationError(requestId, { jurisdiction: ["Unknown jurisdiction code"] });
    }
    filters.jurisdiction = jurisdiction;
  }
  const channel = url.searchParams.get("channelId");
  if (channel) {
    const channelUuid = parseChannelPublicId(channel);
    if (!channelUuid) {
      return validationError(requestId, { channelId: ["Must be a channel id of the form chn_<32 hex>"] });
    }
    filters.channelId = channelUuid;
  }
  const kind = url.searchParams.get("kind");
  if (kind) {
    if (kind !== "sale" && kind !== "refund") {
      return validationError(requestId, { kind: ["Must be 'sale' or 'refund'"] });
    }
    filters.kind = kind;
  }

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.ledger.read");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const { limit, cursor } = pageResult.value;
    const result = await repo.listSaleEventsPaged(orgId, filters, {
      limit,
      cursor: cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null,
    });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      {
        data: { events: result.value.items.map(toPublicSaleEvent) },
        meta: { requestId, cursor: nextCursor },
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
