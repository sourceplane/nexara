// The platform's three-step authorization gate, in one place.
//
// Every handler in this worker runs it before touching a repository: resolve
// the actor's membership context from `membership-worker`, ask `policy-worker`
// whether the action is allowed on the org-scoped resource, and treat **both**
// a membership miss and a policy denial as **404** — deny-as-not-found,
// existence-hiding, the platform-wide convention (design §7.1).
//
// Factored out rather than copy-pasted into six handlers because a gate that
// is subtly different in one handler is the bug this whole design is trying to
// make impossible, and six copies is six chances.

import type { Uuid } from "@saas/db/ids";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { errorResponse } from "../http.js";

export type GateResult = { ok: true } | { ok: false; response: Response };

/** Every binding this worker cannot serve a request without. */
export function requireBindings(env: Env, requestId: string): Response | null {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  return null;
}

export async function requireOrgAction(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
): Promise<GateResult> {
  const notFound = (): GateResult => ({
    ok: false,
    // Deny-as-404. A 403 would confirm the organization exists to someone who
    // has no business knowing that.
    response: errorResponse("not_found", "Not found", 404, requestId),
  });

  const context = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  if (!context.ok) return notFound();

  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    { kind: "organization", orgId },
    context.memberships,
    requestId,
  );
  if (!decision.allow) return notFound();

  return { ok: true };
}
