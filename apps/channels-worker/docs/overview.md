# channels-worker

The **channels** bounded context: connected sales channels, the connect flow,
the durable inbound-delivery inbox, backfill cursors, and the drain that
normalises provider payloads into canonical sale events.

## The only unauthenticated ingress in the epic

`POST /v1/channels/:provider/webhook` carries a **signature, not a session**.
`verifyInboundSignature` is the gate, and an unsigned or wrongly-signed
delivery never reaches the inbox — not "is stored and marked unverified".
The inbox holds customer PII under a retention policy, and accepting
unauthenticated writes into it is a way to fill someone else's PII store.

Every rejection on that route returns the same 401 shape. The difference
between "bad signature" and "unknown provider" is an oracle for someone
probing which provider a tenant uses.

## The seam (design §6.3)

The whole answer to *"did we lose or double-count anything across the
backfill?"* is the ordering, and it is legible in the schema:

1. insert the channel with `backfill_started_at = now()`;
2. **register the webhook and start capturing live deliveries before the
   backfill begins** — live capture's lower bound is that instant;
3. the backfill walks history **backwards** from that same instant, down to
   `lookback_floor`;
4. the seam is covered from **both** sides, deliberately overlapping;
5. nothing is double-counted, because deduplication is
   `nexus_sale_events_dedupe_idx` — a database constraint, not application
   logic;
6. nothing is lost, because live capture starts **before** the backfill. The
   classic bug is the reverse order, which silently loses everything that
   happens during the backfill run.

## The drain

The shipped integrations pattern with the payload type swapped: cron
`* * * * *`, batch 50, `MAX_ATTEMPTS = 5`, backoff 1m/2m/4m/8m/16m then
terminal `failed`, each delivery processed independently. We are not inventing
retry semantics.

One guarantee is ours rather than inherited: **the delivery is marked
`applied` in the same transaction that inserts its sale events.** That makes
the drain exactly-once by construction rather than
at-least-once-plus-a-dedupe-hope, and it is why a crash mid-drain costs a
retry rather than a partially-applied delivery.

## Retention (Q6)

The row is the dedupe **receipt**; the payload is the **PII**. Purging nulls
the payload and keeps the row — deleting the row would let a provider
redelivering after the window be re-applied and double-counted into a
threshold. Applied deliveries keep their payload for 7 days, terminally failed
ones for 30. See [`connector-gate.md`](../../../specs/epics/nexus/connector-gate.md).
