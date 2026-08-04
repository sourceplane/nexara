// Where this org's threshold alerts go (R10).
//
// NX5 shipped the alert mechanism with a per-environment `NEXUS_ALERT_EMAIL`
// var and called it a stopgap in writing: the right answer is that a seller
// names their own tax contact, and the place to ask is the console. This is
// that ask, and its storage lives in the nexus context rather than being
// resolved from `membership` — see `260_nexus_alert_contact/up.sql` for why.
//
// `GET` returns `hasEnvironmentFallback` alongside the contact so the console
// can distinguish two states a single null cannot: "alerts are going somewhere
// you did not choose" and "alerts are going nowhere". Telling a seller their
// alerts are silent when they are not, or the reverse, are both worse than
// saying which.

import type {
  GetAlertContactResponse,
  SetAlertContactRequest,
  SetAlertContactResponse,
} from "@saas/contracts/nexus";
import type { AlertContactRow, NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";

export interface AlertContactDeps {
  repo?: NexusRepository;
  now?: () => Date;
}

/**
 * Deliberately permissive, and bounded.
 *
 * This is not an attempt to decide what a valid email address is — RFC 5321
 * permits things every "strict" regex rejects, and the only real test is
 * whether mail arrives. It rejects the shapes that are certainly wrong
 * (no `@`, whitespace, absurd length) and lets the notification pipeline be
 * the authority on the rest.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_LABEL = 80;

function toPublic(row: AlertContactRow): GetAlertContactResponse["contact"] {
  return { email: row.email, label: row.label, updatedAt: row.updatedAt.toISOString() };
}

export async function handleGetAlertContact(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: AlertContactDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.nexus.read");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const result = await repo.getAlertContact(orgId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const response: GetAlertContactResponse = {
      contact: result.value ? toPublic(result.value) : null,
      hasEnvironmentFallback: Boolean(env.NEXUS_ALERT_EMAIL?.trim()),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * `PUT` sets it; `DELETE` returns the org to the environment fallback.
 *
 * Clearing is its own verb rather than an empty-string update, because
 * "no contact chosen" and "contact set to nothing" are different states and
 * only one of them should read as a fallback.
 */
export async function handleSetAlertContact(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: AlertContactDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const req = (body ?? {}) as Partial<SetAlertContactRequest>;

  const fields: Record<string, string[]> = {};
  const email = typeof req.email === "string" ? req.email.trim().toLowerCase() : null;
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    fields.email = ["Must be an email address of at most 254 characters"];
  }
  const label =
    req.label === undefined || req.label === null ? null : String(req.label).trim() || null;
  if (label !== null && label.length > MAX_LABEL) {
    fields.label = [`Must be at most ${MAX_LABEL} characters`];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // Naming who receives a compliance alert is an administrative act, not a
  // read — the same gate that guards evaluation guards this.
  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.nexus.evaluate");
  if (!gate.ok) return gate.response;

  const now = deps?.now ? deps.now() : new Date();
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const saved = await repo.upsertAlertContact(orgId, { email: email!, label, now });
    if (!saved.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const response: SetAlertContactResponse = { contact: toPublic(saved.value)! };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export async function handleClearAlertContact(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: AlertContactDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.nexus.evaluate");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const cleared = await repo.deleteAlertContact(orgId);
    if (!cleared.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    // Idempotent: clearing a contact that was never set is success, because
    // the caller's intent — "do not send here" — holds either way.
    const response: GetAlertContactResponse = {
      contact: null,
      hasEnvironmentFallback: Boolean(env.NEXUS_ALERT_EMAIL?.trim()),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
