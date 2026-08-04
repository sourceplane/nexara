-- 210_nexus_ingestion: the inbound-delivery inbox.
--
-- Context: nexus
-- Epic: nexus (NX1)
--
-- The durable inbox behind the cron drain. This is the shipped integrations
-- pattern with the payload type swapped — cron + table + bounded retries, no
-- Queues. We copy the discipline, not the interface (design §2).
--
-- Two properties matter here and both are constraints rather than code:
--
--   * A duplicate POST from a provider is a no-op: unique on
--     (provider, provider_delivery_id). The endpoint returns 200 and does
--     nothing, which is what a provider's retry logic needs to see.
--   * The delivery is marked `applied` in the SAME transaction that inserts
--     its sale events, so the drain is exactly-once by construction rather
--     than by an at-least-once retry plus a dedupe hope.
--
-- PII note (Q6): `payload` holds the raw provider body, which carries customer
-- names and addresses. It is retained only until the delivery is applied plus
-- a retention window, it is never returned by any list/read API, and it never
-- reaches a log sink — a retention policy on this table is worthless if the
-- same bytes are also sitting in logs outside it (design §12).

CREATE TABLE IF NOT EXISTS nexus.inbound_deliveries (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL until the drain attributes the delivery (signature → channel → org).
  -- This is the one table in the context whose org_id is nullable, and the
  -- reason is that attribution happens after receipt, not before: a webhook
  -- arrives authenticated by a signature, not by a session.
  org_id               UUID,
  channel_id           UUID,

  provider             TEXT NOT NULL
                         CHECK (provider IN ('stripe', 'shopify', 'csv')),
  provider_delivery_id TEXT NOT NULL,

  -- NX1.5 finding S-3: NULLABLE, deliberately.
  --
  -- The first draft had this NOT NULL, which made the retention policy
  -- unimplementable: purging the PII would have required deleting the row,
  -- and deleting the row destroys the (provider, provider_delivery_id) dedupe
  -- key — so a provider redelivering an old webhook after the purge window
  -- would be re-applied. The row is the receipt; the payload is the PII.
  -- Purging nulls the payload and keeps the receipt.
  payload              JSONB,

  -- Recorded, not assumed. An unsigned or wrongly-signed delivery is rejected
  -- at the edge and never reaches the inbox; this column exists so that a row
  -- with `false` in it is a loud, queryable anomaly rather than an invisible
  -- one.
  signature_verified   BOOLEAN NOT NULL,

  status               TEXT NOT NULL DEFAULT 'received'
                         CHECK (status IN ('received', 'applied', 'skipped', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ,
  -- A short reason. NEVER echoes provider body content.
  last_error           TEXT,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at           TIMESTAMPTZ,

  -- A payload cannot be purged before it has been applied or terminally
  -- failed; retention starts at that point, not at receipt.
  purged_at            TIMESTAMPTZ,

  -- NX1.5 finding S-3. The two states are exhaustive and mutually exclusive:
  -- a live delivery has its payload, a purged one has none. Without this a
  -- half-purged row (payload nulled, purged_at unset) is indistinguishable
  -- from a delivery that arrived with an empty body.
  CONSTRAINT nexus_inbound_deliveries_purge_ck
    CHECK ((purged_at IS NULL) = (payload IS NOT NULL)),

  -- A payload may only be purged once the delivery has reached a terminal
  -- state. Purging a 'received' row destroys work the drain has not done yet.
  CONSTRAINT nexus_inbound_deliveries_purge_terminal_ck
    CHECK (purged_at IS NULL OR status IN ('applied', 'skipped', 'failed'))
);

COMMENT ON TABLE nexus.inbound_deliveries IS
  'Durable inbound-delivery inbox drained by the channels-worker cron. Holds raw provider payloads under a retention policy; never exposed by a list/read API and never logged.';
COMMENT ON COLUMN nexus.inbound_deliveries.org_id IS
  'NULL until the cron drain attributes the delivery. The only nullable org_id in this context, because a webhook is authenticated by a signature rather than by a session.';
COMMENT ON COLUMN nexus.inbound_deliveries.payload IS
  'Raw provider body. Contains customer PII. Purged after apply per the retention policy; never written to a log line.';
COMMENT ON COLUMN nexus.inbound_deliveries.last_error IS
  'A short, non-payload reason. Must never echo provider body content.';

-- A duplicate POST returns 200 and does nothing.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_inbound_deliveries_dedupe_idx
  ON nexus.inbound_deliveries (provider, provider_delivery_id);

-- Drives the drain: the next batch of due work, and nothing else.
CREATE INDEX IF NOT EXISTS nexus_inbound_deliveries_due_idx
  ON nexus.inbound_deliveries (status, next_attempt_at)
  WHERE status = 'received';

-- Per-tenant delivery log for the console and the read-only support view.
CREATE INDEX IF NOT EXISTS nexus_inbound_deliveries_org_idx
  ON nexus.inbound_deliveries (org_id, received_at DESC, id DESC)
  WHERE org_id IS NOT NULL;

-- Terminal failures are an operational signal (design §12): a permanently
-- dropped sale is a wrong board, and the drain's own retries make it look like
-- a success path until attempt five.
CREATE INDEX IF NOT EXISTS nexus_inbound_deliveries_failed_idx
  ON nexus.inbound_deliveries (received_at DESC)
  WHERE status = 'failed';

-- Drives the retention sweep without scanning applied history forever.
CREATE INDEX IF NOT EXISTS nexus_inbound_deliveries_purge_idx
  ON nexus.inbound_deliveries (applied_at)
  WHERE purged_at IS NULL AND status IN ('applied', 'skipped', 'failed');
