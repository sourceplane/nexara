// GET /v1/organizations/:orgId/channels/deliveries — the per-tenant delivery log.
//
// Tenant-facing and therefore scoped, and it returns NO payload. The raw body
// carries customer names and addresses; a list surface that returned it would
// make the Q6 retention policy worthless, and design §12's prohibition on
// payloads reaching a log sink would be undone by an API that hands them out.

import type { ListDeliveriesResponse } from "@saas/contracts/channels";
import { createChannelsRepository, type ChannelsRepository } from "@saas/db/channels";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { toPublicDelivery } from "../mappers.js";

const LIMIT = 100;

export async function handleListDeliveries(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: { repo?: ChannelsRepository },
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.channel.read");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createChannelsRepository(executor!);
    const result = await repo.listDeliveries(orgId, LIMIT);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const response: ListDeliveriesResponse = {
      deliveries: result.value.map(toPublicDelivery),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
