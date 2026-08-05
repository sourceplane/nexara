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
import { orgPublicId } from "../ids.js";

export type GateResult = { ok: true } | { ok: false; response: Response };

/** Every binding this worker cannot serve a request without. */
export function requireBindings(env: Env, requestId: string): Response | null {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  return null;
}

/**
 * Why a request was denied. The CALLER never sees this — every reason returns
 * the same 404 — but the operator does, in the log line below.
 *
 * Deny-as-404 is right for the response and was wrong for the *record*. The
 * three reasons have completely different remedies — a missing role assignment
 * is fixed in Settings → Members, a policy denial means the role is genuinely
 * too narrow, and an unreachable membership worker is an outage — and until
 * this existed the console showed one indistinguishable "Not found" for all of
 * them with nothing written down anywhere. A board that 404s for every user of
 * an org could not be told apart from one seller lacking a role, which is a
 * long way to go to learn nothing.
 *
 * Design §12 names silent failure modes as the ones worth instrumenting. This
 * is one, and it stayed silent until it had to be debugged from a screenshot.
 */
export type DenyReason = "membership_unavailable" | "policy_denied";

/**
 * Ids and an enum only — never a payload, never an email, and never the
 * membership facts themselves. Enough to answer "which of the three is it",
 * which is the entire question.
 */
function logDenial(
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
  reason: DenyReason,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "nexus.authz_denied",
      requestId,
      reason,
      action,
      orgId: orgPublicId(orgId),
      subjectType: actor.subjectType,
      subjectId: actor.subjectId,
    }),
  );
}

export async function requireOrgAction(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  action: string,
): Promise<GateResult> {
  const notFound = (reason: DenyReason): GateResult => {
    logDenial(requestId, actor, orgId, action, reason);
    return {
      ok: false,
      // Deny-as-404. A 403 would confirm the organization exists to someone who
      // has no business knowing that. The reason is recorded, not returned.
      response: errorResponse("not_found", "Not found", 404, requestId),
    };
  };

  const context = await fetchAuthorizationContext(
    env.MEMBERSHIP_WORKER!,
    actor.subjectId,
    actor.subjectType,
    orgId,
    requestId,
  );
  // `membership_unavailable` covers both "this subject has no role assignment
  // in this org" and "the membership worker could not be reached" — the client
  // deliberately collapses them into one `ok: false`, and widening its return
  // type is a change to a module four other handlers share. The distinction
  // that matters operationally is this one against `policy_denied`: it says
  // whether to look at the role assignment or at the policy.
  if (!context.ok) return notFound("membership_unavailable");

  const decision = await authorizeViaPolicy(
    env.POLICY_WORKER!,
    actor.subjectId,
    actor.subjectType,
    action,
    { kind: "organization", orgId },
    context.memberships,
    requestId,
  );
  if (!decision.allow) return notFound("policy_denied");

  return { ok: true };
}
