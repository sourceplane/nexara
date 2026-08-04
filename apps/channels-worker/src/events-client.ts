// Audit + domain events on the internal events seam.
//
// The platform's append-only event log **is** the compliance audit trail
// (design §8). We do not build a second one, and this client is deliberately
// thin: it forwards, and it never becomes the place a nexus fact is
// authoritative.
//
// Two consequences of that, both load-bearing:
//
//   * **Best-effort.** A failure here never propagates to the caller. The
//     determination row is already written and is the authoritative record;
//     failing a threshold evaluation because an audit sink was briefly
//     unreachable would trade the thing that matters for the thing that
//     describes it.
//   * **`channels.*` events become subscribable outgoing webhooks by being
//     emitted here.** `webhooks-worker` fans out every event type on the log
//     except its own lifecycle events, so emitting one *is* the registration.
//
// Payloads are redaction-safe: ids, codes, and integer cents. No customer
// names, no addresses, no provider payloads.

import type { ChannelEventType } from "@saas/contracts/channels";

import type { Env } from "./env.js";

export interface ChannelEventInput {
  type: ChannelEventType;
  orgId: string;
  subjectKind: string;
  subjectId: string;
  requestId: string;
  occurredAt: Date;
  description: string;
  payload: Record<string, unknown>;
  actorType?: string;
  actorId?: string;
}

const EVENTS_URL = "https://events.internal/v1/internal/events";

export async function emitChannelEvent(env: Env, input: ChannelEventInput): Promise<void> {
  if (!env.EVENTS_WORKER) return;

  const body = {
    event: {
      id: crypto.randomUUID(),
      type: input.type,
      version: 1,
      source: "channels-worker",
      occurredAt: input.occurredAt.toISOString(),
      // The hourly job has no human behind it. `system` is honest; attributing
      // an automated evaluation to the last user who logged in would put a
      // name on a decision they did not make.
      actor: { type: input.actorType ?? "system", id: input.actorId ?? "channels-worker" },
      tenant: { orgId: input.orgId },
      subject: { kind: input.subjectKind, id: input.subjectId },
      trace: { requestId: input.requestId, correlationId: null },
      payload: input.payload,
    },
    audit: {
      category: "nexus",
      description: input.description,
    },
  };

  try {
    await env.EVENTS_WORKER.fetch(EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": input.requestId,
        "x-internal-actor": "channels-worker",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Swallowed on purpose. See the "best-effort" note above.
  }
}
