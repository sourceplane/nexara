// POST /v1/channels/:provider/webhook
//
// **The only unauthenticated ingress in this epic**, and the only new trust
// path. It carries a signature, not a session, and `verifyInboundSignature` is
// the gate.
//
// Four properties, in the order they are enforced:
//
//   1. **The raw bytes are verified, not a parsed object.** Every provider
//      signs what it sent; re-serialising a parsed body changes the bytes and
//      the signature stops matching for reasons that look like a key problem.
//   2. **An unsigned or wrongly-signed delivery never reaches the inbox.** Not
//      "is stored and marked unverified" — never reaches it. The inbox holds
//      PII under a retention policy, and accepting unauthenticated writes into
//      it is a way to fill someone else's PII store.
//   3. **A duplicate returns 200 and does nothing.** That is what a provider's
//      retry logic needs to see, and the guarantee is the unique index rather
//      than a check-then-insert.
//   4. **The response never says why.** A verification failure and an unknown
//      provider return the same 401 shape, because the difference is an oracle
//      for someone probing which provider a tenant uses.

import { createChannelsRepository } from "@saas/db/channels";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import { errorResponse, successResponse } from "../http.js";
import { isKnownProvider, resolveProvider } from "../providers/registry.js";

/** Bodies above this are refused before any crypto work. A signature check on
 *  an unbounded body is a free CPU-exhaustion primitive on an unauthenticated
 *  route. */
const MAX_BODY_BYTES = 1_000_000;

export async function handleIngest(
  request: Request,
  env: Env,
  requestId: string,
  providerId: string,
): Promise<Response> {
  // One shape for every rejection on this route. See property 4.
  const reject = (): Response =>
    errorResponse("unauthenticated", "Signature verification failed", 401, requestId);

  if (!isKnownProvider(providerId)) return reject();

  const provider = resolveProvider(env, providerId);
  if (!provider) {
    // Credentials are incomplete in this environment. 503 rather than 401:
    // this one IS ours, and a provider retrying against a misconfigured
    // environment should be told to come back rather than to give up.
    return errorResponse("internal_error", "Provider not configured", 503, requestId);
  }

  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse("bad_request", "Payload too large", 413, requestId);
  }

  let raw: ArrayBuffer;
  try {
    raw = await request.arrayBuffer();
  } catch {
    return reject();
  }
  if (raw.byteLength > MAX_BODY_BYTES) {
    return errorResponse("bad_request", "Payload too large", 413, requestId);
  }

  // Property 1: the RAW bytes.
  const verified = await provider.verifyInboundSignature(raw, request.headers);
  // Property 2: nothing unverified reaches the inbox.
  if (!verified) return reject();

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // A signed body that is not JSON is a provider bug or a truncated
    // delivery. Rejecting it lets the provider retry; storing it would put an
    // undrainable row in the inbox forever.
    return reject();
  }

  const deliveryId = deliveryIdFrom(payload, request.headers);
  if (!deliveryId) return reject();

  // Shopify identifies the shop by header rather than in the body (NX7). It is
  // copied onto the stored envelope so the drain's attribution has one place
  // to look, under a reserved key that cannot collide with provider fields.
  const shopDomain = request.headers.get("x-shopify-shop-domain");
  const stored =
    shopDomain && typeof payload === "object" && payload !== null
      ? { ...(payload as Record<string, unknown>), __shopDomain: shopDomain }
      : payload;

  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createChannelsRepository(executor);
    const received = await repo.receiveDelivery({
      id: crypto.randomUUID(),
      provider: providerId,
      providerDeliveryId: deliveryId,
      payload: stored,
      signatureVerified: true,
      receivedAt: new Date(),
    });
    if (!received.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // Property 3. `null` means the unique index rejected it — already
    // received, nothing to do, and a 200 so the provider stops retrying.
    return successResponse(
      { received: true, duplicate: received.value === null },
      requestId,
      202,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await executor.dispose();
  }
}

/**
 * The provider's own id for this delivery — half of the dedupe key.
 *
 * Taken from the signed body or a signed header, never from an unsigned one: a
 * caller who could choose the delivery id could either replay an old delivery
 * under a new id, or suppress a real one by claiming its id first.
 */
function deliveryIdFrom(payload: unknown, headers: Headers): string | null {
  const body = payload as { id?: unknown } | null;
  if (body && typeof body.id === "string" && body.id.length > 0) return body.id;

  // Shopify's `x-shopify-webhook-id` is inside the HMAC'd request, so it is
  // as trustworthy as the body.
  const shopifyId = headers.get("x-shopify-webhook-id");
  if (shopifyId && shopifyId.length > 0) return shopifyId;

  return null;
}
