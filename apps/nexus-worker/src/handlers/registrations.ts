// Registrations — the seller's own record of where they stand.
//
// We surface a deadline; a human files. There is no "file for me" here and
// there never will be: filing with a state on a seller's behalf is a permanent
// non-goal (design §10), and an API that looked like it might is worse than no
// API at all.

import type {
  ListRegistrationsResponse,
  UpsertRegistrationRequest,
  UpsertRegistrationResponse,
} from "@saas/contracts/nexus";
import type { NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { toPublicRegistration } from "../mappers.js";
import { isKnownJurisdictionCode } from "../jurisdictions.js";

const STATUSES = new Set(["planned", "filed", "active", "closed"]);
const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface HandleRegistrationsDeps {
  repo?: NexusRepository;
  now?: () => Date;
}

export async function handleListRegistrations(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleRegistrationsDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.registration.read");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const result = await repo.listRegistrations(orgId);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const response: ListRegistrationsResponse = {
      registrations: result.value.map(toPublicRegistration),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export async function handleUpsertRegistration(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleRegistrationsDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const fields: Record<string, string[]> = {};
  const req = (body ?? {}) as Partial<UpsertRegistrationRequest>;
  if (typeof req.jurisdiction !== "string" || !isKnownJurisdictionCode(req.jurisdiction)) {
    fields.jurisdiction = ["Must be a jurisdiction code such as US-TX"];
  }
  if (typeof req.status !== "string" || !STATUSES.has(req.status)) {
    fields.status = ["Must be one of planned, filed, active, closed"];
  }
  if (req.registeredOn != null && (typeof req.registeredOn !== "string" || !CIVIL_DATE_RE.test(req.registeredOn))) {
    fields.registeredOn = ["Must be a date of the form YYYY-MM-DD"];
  }
  // The schema's `nexus_registrations_active_ck` says the same thing; saying
  // it here too means the caller gets a 422 naming the field rather than a 503
  // from a constraint violation.
  if (req.status === "active" && req.registeredOn == null) {
    fields.registeredOn = ["Required when status is 'active'"];
  }
  if (req.permitRef != null && (typeof req.permitRef !== "string" || req.permitRef.length > 255)) {
    fields.permitRef = ["Must be a string of at most 255 characters"];
  }
  if (req.notes != null && (typeof req.notes !== "string" || req.notes.length > 2_000)) {
    fields.notes = ["Must be a string of at most 2000 characters"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.registration.write");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);
    const result = await repo.upsertRegistration(orgId, {
      id: crypto.randomUUID(),
      jurisdiction: req.jurisdiction as string,
      status: req.status as "planned" | "filed" | "active" | "closed",
      registeredOn: req.registeredOn ?? null,
      permitRef: req.permitRef ?? null,
      notes: req.notes ?? null,
      now: deps?.now ? deps.now() : new Date(),
    });
    if (!result.ok) {
      if (result.error.kind === "conflict") {
        return errorResponse("conflict", "A registration already exists for this jurisdiction", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const response: UpsertRegistrationResponse = {
      registration: toPublicRegistration(result.value),
    };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
