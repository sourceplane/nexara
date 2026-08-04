// Channel connections — start, complete, list, revoke.
//
// The sequencing of design §6.3 is the whole answer to "did we lose or
// double-count anything across the backfill seam", and it lives in
// `completeConnect` below:
//
//   1. insert the channel with `backfill_started_at = now()`;
//   2. register the webhook and start capturing live deliveries BEFORE the
//      backfill begins — live capture's lower bound is that instant;
//   3. the backfill walks history backwards from that same instant;
//   4. the seam is therefore covered from both sides, deliberately
//      overlapping;
//   5. nothing is double-counted, because deduplication is a database
//      constraint;
//   6. nothing is lost, because live capture starts BEFORE the backfill. The
//      classic bug is the reverse order, which silently loses everything that
//      happens during the backfill run.

import type {
  CompleteChannelConnectResponse,
  CreateManualChannelResponse,
  ListChannelsResponse,
  RevokeChannelResponse,
  StartChannelConnectResponse,
} from "@saas/contracts/channels";
import { createChannelsRepository, type ChannelsRepository } from "@saas/db/channels";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { isKnownProvider, resolveProvider } from "../providers/registry.js";
import {
  CONNECT_STATE_TTL_MS,
  generateStateNonce,
  signConnectState,
  verifyConnectState,
} from "../state.js";
import { toPublicChannel } from "../mappers.js";
import { channelPublicId, orgPublicId, parseChannelPublicId } from "../ids.js";
import { emitChannelEvent } from "../events-client.js";

/** Design §3.1: 36 months by default. */
const DEFAULT_LOOKBACK_MONTHS = 36;

export interface ConnectionDeps {
  repo?: ChannelsRepository;
  now?: () => Date;
}

function lookbackFloor(now: Date): string {
  const floor = new Date(now);
  floor.setUTCMonth(floor.getUTCMonth() - DEFAULT_LOOKBACK_MONTHS);
  return floor.toISOString().slice(0, 10);
}

export async function handleListChannels(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: ConnectionDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.channel.read");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createChannelsRepository(executor!);
    const result = await repo.listChannels(orgId);
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    const response: ListChannelsResponse = { channels: result.value.map(toPublicChannel) };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export async function handleStartConnect(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: ConnectionDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const req = (body ?? {}) as { provider?: unknown; redirectUri?: unknown };

  const fields: Record<string, string[]> = {};
  if (typeof req.provider !== "string" || !isKnownProvider(req.provider)) {
    fields.provider = ["Must be 'stripe' or 'shopify'"];
  }
  if (typeof req.redirectUri !== "string" || !isAllowedRedirect(req.redirectUri)) {
    // An open redirect on a connect flow hands an attacker the authorization
    // code. The allow-list is the whole defence and it is not negotiable.
    fields.redirectUri = ["Must be an https URL on an allowed origin"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  // Connecting a payment processor is an owner/admin act. A builder runs the
  // product; they do not attach the money.
  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.channel.connect");
  if (!gate.ok) return gate.response;

  const provider = resolveProvider(env, req.provider as "stripe" | "shopify");
  if (!provider) {
    return errorResponse(
      "unsupported",
      `The ${String(req.provider)} adapter is not configured in this environment`,
      501,
      requestId,
      { reason: "provider_unconfigured" },
    );
  }
  if (!env.CONNECT_STATE_SECRET) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  // The tenancy keystone. The org binding is carried by OUR signed state, never
  // inferred from the provider's redirect — a provider callback says which
  // account authorised, not which of our tenants asked.
  const expiresAtMs = now.getTime() + CONNECT_STATE_TTL_MS;
  const signedState = await signConnectState(
    {
      n: generateStateNonce(),
      p: req.provider as string,
      // The channel id is minted here and carried in the signed state, so the
      // row created at completion is the one this flow was started for —
      // defence in depth against a state swapped between two in-flight
      // connects by the same operator.
      c: crypto.randomUUID(),
      o: orgId,
      exp: expiresAtMs,
    },
    env.CONNECT_STATE_SECRET,
  );

  const response: StartChannelConnectResponse = {
    authorizeUrl: provider.buildAuthorizeUrl({
      state: signedState,
      redirectUri: req.redirectUri as string,
    }),
    state: signedState,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return successResponse(response, requestId, 201);
}

export async function handleCompleteConnect(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: ConnectionDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const req = (body ?? {}) as { provider?: unknown; code?: unknown; state?: unknown };
  if (
    typeof req.provider !== "string" ||
    !isKnownProvider(req.provider) ||
    typeof req.code !== "string" ||
    typeof req.state !== "string"
  ) {
    return validationError(requestId, { body: ["provider, code, and state are required"] });
  }

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.channel.connect");
  if (!gate.ok) return gate.response;

  if (!env.CONNECT_STATE_SECRET) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  // Null covers a bad signature, a malformed payload, AND expiry — all of
  // which are the same answer to the caller.
  const state = await verifyConnectState(req.state, env.CONNECT_STATE_SECRET, now.getTime());
  // Fail closed on every state problem — expired, wrong provider, wrong org.
  // A state minted for one tenant completing against another is the attack
  // this check exists for, and it is why the org is in the signed payload
  // rather than read from the path alone.
  if (!state || state.p !== req.provider || state.o !== orgId) {
    return errorResponse("unauthenticated", "Invalid or expired connect state", 401, requestId);
  }

  const provider = resolveProvider(env, req.provider);
  if (!provider) {
    return errorResponse("unsupported", "Provider not configured", 501, requestId);
  }

  const facts = await provider.completeConnect({ code: req.code, nowMs: now.getTime() });
  // Null means the account could not be verified. Fail closed: a channel we
  // cannot authenticate against would read as "connected, no sales", which is
  // indistinguishable from a seller who is genuinely clear.
  if (!facts) {
    return errorResponse("bad_request", "Could not verify the provider account", 400, requestId);
  }

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createChannelsRepository(executor!);

    // Design §6.3 step 1: `backfill_started_at` is set at INSERT, before any
    // history is fetched. It is simultaneously live capture's lower bound and
    // the backfill's upper bound, which is what covers the seam from both
    // sides.
    const created = await repo.createChannel(orgId, {
      id: state.c,
      provider: req.provider,
      externalAccountId: facts.externalAccountId,
      displayName: facts.displayName,
      credentialsRef: facts.credentialsRef,
      backfillStartedAt: now,
      lookbackFloor: lookbackFloor(now),
      now,
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse(
          "conflict",
          "This account is already connected to this organization",
          409,
          requestId,
        );
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    await emitChannelEvent(env, {
      type: "channels.connection.completed",
      orgId: orgPublicId(orgId),
      subjectKind: "channel",
      subjectId: channelPublicId(created.value.id),
      requestId,
      occurredAt: now,
      description: `Connected ${facts.displayName}`,
      payload: {
        provider: req.provider,
        externalAccountId: facts.externalAccountId,
        backfillStartedAt: now.toISOString(),
        lookbackFloor: created.value.lookbackFloor,
      },
      actorType: actor.subjectType,
      actorId: actor.subjectId,
    });

    const response: CompleteChannelConnectResponse = {
      channel: toPublicChannel(created.value),
    };
    return successResponse(response, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** A CSV channel has no OAuth flow, so it is created directly — and it is what
 *  makes the NX4 ledger import have something to attribute rows to. */
export async function handleCreateManualChannel(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: ConnectionDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const req = (body ?? {}) as {
    displayName?: unknown;
    externalAccountId?: unknown;
    lookbackFloor?: unknown;
  };

  const fields: Record<string, string[]> = {};
  if (typeof req.displayName !== "string" || req.displayName.length < 1 || req.displayName.length > 100) {
    fields.displayName = ["Must be a string of 1–100 characters"];
  }
  if (
    typeof req.externalAccountId !== "string" ||
    !/^[\w.-]{1,64}$/.test(req.externalAccountId)
  ) {
    fields.externalAccountId = ["Must be 1–64 characters of letters, digits, dot, dash, underscore"];
  }
  if (req.lookbackFloor != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(req.lookbackFloor))) {
    fields.lookbackFloor = ["Must be a date of the form YYYY-MM-DD"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.channel.connect");
  if (!gate.ok) return gate.response;

  const now = deps?.now ? deps.now() : new Date();
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createChannelsRepository(executor!);
    const created = await repo.createChannel(orgId, {
      id: crypto.randomUUID(),
      provider: "csv",
      externalAccountId: req.externalAccountId as string,
      displayName: req.displayName as string,
      credentialsRef: null,
      // A CSV channel has no live capture and no backfill to run, so both
      // stamps are set now: it is complete the moment it exists, and leaving
      // `backfill_completed_at` null would make it read as stuck forever.
      backfillStartedAt: now,
      lookbackFloor: (req.lookbackFloor as string | undefined) ?? lookbackFloor(now),
      now,
    });
    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "A channel with this label already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const completed = await repo.advanceBackfill(
      orgId,
      created.value.id as Uuid,
      null,
      now,
      now,
    );

    const response: CreateManualChannelResponse = {
      channel: toPublicChannel(completed.ok ? completed.value : created.value),
    };
    return successResponse(response, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export async function handleRevokeChannel(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  channelPublic: string,
  deps?: ConnectionDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const channelId = parseChannelPublicId(channelPublic);
  if (!channelId) return errorResponse("not_found", "Not found", 404, requestId);

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.channel.revoke");
  if (!gate.ok) return gate.response;

  const now = deps?.now ? deps.now() : new Date();
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createChannelsRepository(executor!);
    const revoked = await repo.revokeChannel(orgId, channelId, now);
    if (!revoked.ok) return errorResponse("not_found", "Not found", 404, requestId);

    await emitChannelEvent(env, {
      type: "channels.connection.revoked",
      orgId: orgPublicId(orgId),
      subjectKind: "channel",
      subjectId: channelPublicId(revoked.value.id),
      requestId,
      occurredAt: now,
      description: `Revoked ${revoked.value.displayName}`,
      payload: { provider: revoked.value.provider },
      actorType: actor.subjectType,
      actorId: actor.subjectId,
    });

    // The ledger rows stay. Revoking a channel stops ingestion; it does not
    // retract history, and a determination that cited those sales must still
    // re-derive years from now.
    const response: RevokeChannelResponse = { channel: toPublicChannel(revoked.value) };
    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** https only, and no userinfo/embedded-credential forms. */
function isAllowedRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}
