import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleIngest } from "./handlers/ingest.js";
import { handleListDeliveries } from "./handlers/deliveries.js";
import {
  handleCompleteConnect,
  handleCreateManualChannel,
  handleListChannels,
  handleRevokeChannel,
  handleStartConnect,
} from "./handlers/connections.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, parseOrgPublicId } from "./ids.js";

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

const WEBHOOK_RE = /^\/v1\/channels\/([^/]+)\/webhook$/;
const CHANNELS_RE = /^\/v1\/organizations\/([^/]+)\/channels$/;
const CHANNEL_ID_RE = /^\/v1\/organizations\/([^/]+)\/channels\/([^/]+)$/;
const CONNECT_START_RE = /^\/v1\/organizations\/([^/]+)\/channels\/connect$/;
const CONNECT_COMPLETE_RE = /^\/v1\/organizations\/([^/]+)\/channels\/connect\/complete$/;
const DELIVERIES_RE = /^\/v1\/organizations\/([^/]+)\/channels\/deliveries$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // THE unauthenticated ingress, matched FIRST and deliberately before every
    // org-scoped pattern. It carries a signature, not a session, so it must
    // never fall through to a branch that expects an actor header.
    const webhook = url.pathname.match(WEBHOOK_RE);
    if (webhook) {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleIngest(request, env, requestId, webhook[1]!);
    }

    // The literal sub-paths must be matched before CHANNEL_ID_RE, or
    // `/channels/connect` is read as a channel whose id is "connect".
    const complete = url.pathname.match(CONNECT_COMPLETE_RE);
    if (complete) {
      return withActor(request, requestId, complete[1]!, (actor, orgId) =>
        request.method === "POST"
          ? handleCompleteConnect(request, env, requestId, actor, orgId)
          : Promise.resolve(methodNotAllowed(requestId)),
      );
    }

    const start = url.pathname.match(CONNECT_START_RE);
    if (start) {
      return withActor(request, requestId, start[1]!, (actor, orgId) =>
        request.method === "POST"
          ? handleStartConnect(request, env, requestId, actor, orgId)
          : Promise.resolve(methodNotAllowed(requestId)),
      );
    }

    const deliveries = url.pathname.match(DELIVERIES_RE);
    if (deliveries) {
      return withActor(request, requestId, deliveries[1]!, (actor, orgId) =>
        request.method === "GET"
          ? handleListDeliveries(env, requestId, actor, orgId)
          : Promise.resolve(methodNotAllowed(requestId)),
      );
    }

    const channels = url.pathname.match(CHANNELS_RE);
    if (channels) {
      return withActor(request, requestId, channels[1]!, (actor, orgId) => {
        if (request.method === "GET") return handleListChannels(env, requestId, actor, orgId);
        if (request.method === "POST") {
          return handleCreateManualChannel(request, env, requestId, actor, orgId);
        }
        return Promise.resolve(methodNotAllowed(requestId));
      });
    }

    const channelId = url.pathname.match(CHANNEL_ID_RE);
    if (channelId) {
      return withActor(request, requestId, channelId[1]!, (actor, orgId) =>
        request.method === "DELETE"
          ? handleRevokeChannel(env, requestId, actor, orgId, channelId[2]!)
          : Promise.resolve(methodNotAllowed(requestId)),
      );
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }

  async function withActor(
    req: Request,
    rid: string,
    orgPublic: string,
    run: (actor: ActorContext, orgId: NonNullable<ReturnType<typeof parseOrgPublicId>>) => Promise<Response>,
  ): Promise<Response> {
    const orgId = parseOrgPublicId(orgPublic);
    // Deny-as-not-found starts at the parse: a 400 saying "your org id is
    // well-formed but unknown" is a membership oracle.
    if (!orgId) return errorResponse("not_found", "Not found", 404, rid);
    const actor = resolveActor(req);
    if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, rid);
    return run(actor, orgId);
  }
}
