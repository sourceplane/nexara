import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleListExposure } from "./handlers/list-exposure.js";
import { handleGetJurisdiction } from "./handlers/get-jurisdiction.js";
import { handleEvaluate } from "./handlers/evaluate.js";
import { handleImportLedger } from "./handlers/import-ledger.js";
import { handleListLedger } from "./handlers/list-ledger.js";
import {
  handleListRegistrations,
  handleUpsertRegistration,
} from "./handlers/registrations.js";
import {
  handleClearAlertContact,
  handleGetAlertContact,
  handleSetAlertContact,
} from "./handlers/alert-contact.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";
import { isKnownJurisdictionCode } from "./jurisdictions.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const EXPOSURE_RE = /^\/v1\/organizations\/([^/]+)\/nexus\/exposure$/;
const JURISDICTION_RE = /^\/v1\/organizations\/([^/]+)\/nexus\/jurisdictions\/([^/]+)$/;
const EVALUATE_RE = /^\/v1\/organizations\/([^/]+)\/nexus\/evaluate$/;
const LEDGER_RE = /^\/v1\/organizations\/([^/]+)\/ledger$/;
const LEDGER_IMPORT_RE = /^\/v1\/organizations\/([^/]+)\/ledger\/import$/;
const REGISTRATIONS_RE = /^\/v1\/organizations\/([^/]+)\/registrations$/;
const ALERT_CONTACT_RE = /^\/v1\/organizations\/([^/]+)\/nexus\/alert-contact$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Each branch decodes the org public id first and 404s on a malformed one.
    // Deny-as-not-found starts at the parse: a 400 telling a caller their org
    // id is well-formed-but-unknown is a membership oracle.
    const routes: Array<{
      re: RegExp;
      methods: string[];
      run: (m: RegExpMatchArray, orgId: ReturnType<typeof parseOrgPublicId>, actor: ActorContext) => Promise<Response>;
    }> = [
      {
        re: EXPOSURE_RE,
        methods: ["GET"],
        run: (_m, orgId, actor) => handleListExposure(env, requestId, actor, orgId!),
      },
      {
        re: JURISDICTION_RE,
        methods: ["GET"],
        run: async (m, orgId, actor) => {
          const code = decodeURIComponent(m[2]!);
          if (!isKnownJurisdictionCode(code)) {
            return errorResponse("not_found", "Not found", 404, requestId);
          }
          return handleGetJurisdiction(env, requestId, actor, orgId!, code);
        },
      },
      {
        re: EVALUATE_RE,
        methods: ["POST"],
        run: (_m, orgId, actor) => handleEvaluate(request, env, requestId, actor, orgId!),
      },
      {
        re: LEDGER_IMPORT_RE,
        methods: ["POST"],
        run: (_m, orgId, actor) => handleImportLedger(request, env, requestId, actor, orgId!),
      },
      {
        re: LEDGER_RE,
        methods: ["GET"],
        run: (_m, orgId, actor) => handleListLedger(request, env, requestId, actor, orgId!),
      },
      {
        // Matched before EXPOSURE_RE would ever be reached is unnecessary —
        // the patterns are disjoint — but it sits with the other nexus routes.
        re: ALERT_CONTACT_RE,
        methods: ["GET", "PUT", "DELETE"],
        run: (_m, orgId, actor) => {
          if (request.method === "GET") {
            return handleGetAlertContact(env, requestId, actor, orgId!);
          }
          if (request.method === "PUT") {
            return handleSetAlertContact(request, env, requestId, actor, orgId!);
          }
          return handleClearAlertContact(env, requestId, actor, orgId!);
        },
      },
      {
        re: REGISTRATIONS_RE,
        methods: ["GET", "PUT"],
        run: (_m, orgId, actor) =>
          request.method === "GET"
            ? handleListRegistrations(env, requestId, actor, orgId!)
            : handleUpsertRegistration(request, env, requestId, actor, orgId!),
      },
    ];

    for (const entry of routes) {
      const match = url.pathname.match(entry.re);
      if (!match) continue;
      if (!entry.methods.includes(request.method)) return methodNotAllowed(requestId);

      const orgId = parseOrgPublicId(match[1]!);
      if (!orgId) return errorResponse("not_found", "Not found", 404, requestId);

      const actor = resolveActor(request);
      if (!actor) {
        return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      }
      return entry.run(match, orgId, actor);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
