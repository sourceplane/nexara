// POST /v1/organizations/:orgId/nexus/evaluate
//
// The manual form of what NX5's cron does hourly. Both call `evaluateOrg`; a
// cron that re-implements a handler is how the two drift until a support
// question can no longer be answered by pressing the button.

import type { EvaluateResponse } from "@saas/contracts/nexus";
import type { NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { evaluateOrg } from "../evaluation.js";
import { toPublicDetermination } from "../mappers.js";

/**
 * How far from now a caller may set `asOf`.
 *
 * Not paranoia: an unbounded `asOf` lets a caller mine a position at any past
 * or future instant and write it into the immutable history as though it were
 * an observation. The history is evidence; it records what we determined and
 * when, so the instants it contains have to be ones that actually happened.
 */
const MAX_BACKDATE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_FORWARD_MS = 60 * 1_000;

export interface HandleEvaluateDeps {
  repo?: NexusRepository;
  now?: () => Date;
}

export async function handleEvaluate(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleEvaluateDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const now = deps?.now ? deps.now() : new Date();

  let asOf = now;
  const raw = await request.text();
  if (raw.trim().length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return validationError(requestId, { body: ["Invalid JSON"] });
    }
    const candidate = (body as { asOf?: unknown }).asOf;
    if (candidate !== undefined && candidate !== null) {
      if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate))) {
        return validationError(requestId, { asOf: ["Must be an ISO-8601 timestamp"] });
      }
      asOf = new Date(candidate);
      const delta = asOf.getTime() - now.getTime();
      if (delta > MAX_FORWARD_MS) {
        return validationError(requestId, { asOf: ["Must not be in the future"] });
      }
      if (-delta > MAX_BACKDATE_MS) {
        return validationError(requestId, { asOf: ["Must be within the last 90 days"] });
      }
    }
  }

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.nexus.evaluate");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const result = await evaluateOrg(repo, orgId, asOf);

    if (!result.ok) {
      if (result.reason === "no_rule_set") {
        return errorResponse("precondition_failed", result.message, 412, requestId, {
          reason: "no_rule_set",
        });
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // The watermark moves on a successful evaluation whether or not anything
    // changed — "I have looked at everything up to here" is true either way,
    // and not moving it would make the cron re-scan the same ledger forever.
    const activity = await repo.listOrgsWithActivity(500);
    if (activity.ok) {
      const mine = activity.value.find((a) => a.orgId === orgId);
      if (mine) await repo.setWatermark(orgId, mine.maxIngestedAt, asOf);
    }

    const response: EvaluateResponse = {
      evaluatedAt: result.value.evaluatedAt.toISOString(),
      determinations: result.value.written.map(toPublicDetermination),
      evaluated: result.value.evaluated,
      ruleSetVersion: result.value.ruleSet.version,
      ruleSetVerified: result.value.ruleSet.verified,
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
