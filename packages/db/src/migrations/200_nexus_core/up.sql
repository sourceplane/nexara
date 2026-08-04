-- 200_nexus_core: connected sales channels + the sale-event ledger.
--
-- Context: nexus
-- Epic: nexus (NX1) — the first *product* bounded context on this platform.
--
-- Three invariants are enforced here, in the schema, rather than asserted in
-- application code:
--
--   1. Money is integer cents. Every monetary column is BIGINT and named
--      *_cents. There is no NUMERIC and no float in this schema.
--   2. The ledger is append-only. nexus.sale_events is never UPDATEd anywhere
--      in the codebase; a refund is a new row with negative cents and
--      reverses_event_id pointing at the original. The payoff is that every
--      aggregate is a plain SUM with no special casing, and that the ledger
--      replays to any point in time.
--   3. Deduplication is a constraint, not application logic. The unique index
--      below IS the idempotency guarantee for both webhook redelivery and the
--      deliberate backfill/live-sync overlap (design §6.3–§6.4).
--
-- Tenancy: query-scoped, not RLS — Workers reach Postgres through Hyperdrive,
-- which pools connections, and a leaked `SET LOCAL app.current_org` is a
-- silent cross-tenant bug. Every tenant-owned table carries org_id UUID NOT
-- NULL and a CI scan fails any nexus./channels. query lacking `org_id = $`
-- (design §7.3).
--
-- Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS nexus;

COMMENT ON SCHEMA nexus IS
  'Nexus bounded context — the sale-event ledger, versioned rule data, the determination record, registrations, and alerts.';

-- ── Channels ───────────────────────────────────────────────
-- A connected sales channel. Tokens are NEVER stored here: credentials_ref is
-- a pointer into the secret store, so a dump of this table is not a breach of
-- the seller's Stripe account.

CREATE TABLE IF NOT EXISTS nexus.channels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL,
  provider              TEXT NOT NULL
                          CHECK (provider IN ('stripe', 'shopify', 'csv')),
  external_account_id   TEXT NOT NULL,
  display_name          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'backfilling'
                          CHECK (status IN ('backfilling', 'connected', 'degraded', 'revoked')),
  credentials_ref       TEXT,

  -- The live/backfill seam (design §6.3). Live capture's lower bound and
  -- backfill's upper bound are both backfill_started_at, so the seam is
  -- covered from both sides and the dedupe index makes the overlap free.
  backfill_started_at   TIMESTAMPTZ,
  backfill_completed_at TIMESTAMPTZ,
  backfill_cursor       TEXT,
  lookback_floor        DATE NOT NULL,

  -- Newest occurred_at seen from this channel. The staleness signal (R3):
  -- absence of data reads exactly like absence of sales without it.
  last_event_at         TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ
);

COMMENT ON TABLE nexus.channels IS
  'Connected sales channels. Every query must scope by org_id.';
COMMENT ON COLUMN nexus.channels.credentials_ref IS
  'Pointer into the secret store. Provider tokens are never stored in this table.';
COMMENT ON COLUMN nexus.channels.backfill_started_at IS
  'The live/backfill seam. Live capture starts BEFORE the backfill; both bound at this instant so nothing is lost across the seam.';
COMMENT ON COLUMN nexus.channels.backfill_completed_at IS
  'NULL with status=backfilling means "not yet ingested", which is a different thing from "nothing to ingest". Never conflate them.';

-- Reconnecting a revoked account is legal; connecting the same live account
-- twice is not.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_channels_live_account_idx
  ON nexus.channels (org_id, provider, external_account_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS nexus_channels_org_created_idx
  ON nexus.channels (org_id, created_at DESC, id DESC);

-- NX1.5 finding S-2. Composite unique target for the tenant-scoped FK from
-- sale_events. A bare `channel_id UUID` lets a repository bug attribute a
-- ledger row to another tenant's channel; with this the database refuses it.
-- Same pattern as projects_org_id_id_idx.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_channels_org_id_id_idx
  ON nexus.channels (org_id, id);

-- Drives the staleness sweep in the hourly job: live channels ordered by how
-- long they have been quiet.
CREATE INDEX IF NOT EXISTS nexus_channels_staleness_idx
  ON nexus.channels (status, last_event_at)
  WHERE revoked_at IS NULL;

-- ── The ledger ─────────────────────────────────────────────
-- Append-only. No UPDATE statement exists against this table anywhere in the
-- codebase. Read that as a constraint on the code, enforced by review and by
-- the repository being the only SQL surface.

CREATE TABLE IF NOT EXISTS nexus.sale_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 UUID NOT NULL,
  channel_id             UUID NOT NULL,
  source                 TEXT NOT NULL
                           CHECK (source IN ('backfill', 'webhook', 'csv')),
  provider_event_id      TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('sale', 'refund')),
  reverses_event_id      UUID,

  -- The PROVIDER's timestamp. This is the measurement date; ingested_at is
  -- when we learned about it, and the two are deliberately distinct.
  occurred_at            TIMESTAMPTZ NOT NULL,

  jurisdiction           TEXT NOT NULL,
  -- Which fallback produced `jurisdiction` (design §6.2). "We guessed" must be
  -- visible in the evidence rather than laundered into a fact.
  jurisdiction_source    TEXT NOT NULL DEFAULT 'declared'
                           CHECK (jurisdiction_source IN
                             ('shipping_address', 'billing_address', 'tax_lines', 'declared')),
  ship_to_country        TEXT,
  ship_to_region         TEXT,

  -- All three bases captured at ingest, because rules disagree on which
  -- applies and deriving the other two later needs the provider payload back.
  -- Sixteen bytes now beats a re-fetch in two years.
  gross_cents            BIGINT NOT NULL,
  retail_cents           BIGINT NOT NULL,
  taxable_cents          BIGINT NOT NULL,

  transaction_count      INTEGER NOT NULL DEFAULT 1,
  marketplace_facilitated BOOLEAN NOT NULL DEFAULT false,
  currency               TEXT NOT NULL,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A refund reverses something; a sale does not.
  CONSTRAINT nexus_sale_events_refund_reverses_ck
    CHECK ((kind = 'refund') = (reverses_event_id IS NOT NULL)),

  -- Sign discipline. A refund that carries positive cents would inflate the
  -- measurement it is supposed to reduce, and nothing downstream would notice
  -- because SUM is sign-blind by design. Enforce it where it cannot be missed.
  CONSTRAINT nexus_sale_events_sale_sign_ck
    CHECK (kind <> 'sale' OR (gross_cents >= 0 AND retail_cents >= 0
           AND taxable_cents >= 0 AND transaction_count >= 0)),
  CONSTRAINT nexus_sale_events_refund_sign_ck
    CHECK (kind <> 'refund' OR (gross_cents <= 0 AND retail_cents <= 0
           AND taxable_cents <= 0 AND transaction_count <= 0)),

  -- NX1.5 finding S-2. Tenant-scoped, so a ledger row cannot claim another
  -- tenant's channel even if the handler's org scoping is wrong. Design §7.3
  -- accepts that query scoping has no second line of defence; for the write
  -- path, this composite FK is one.
  CONSTRAINT nexus_sale_events_channel_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES nexus.channels (org_id, id)
);

COMMENT ON TABLE nexus.sale_events IS
  'Append-only sale-event ledger. NEVER UPDATEd: a refund is a new row with negative cents and reverses_event_id set. Every query must scope by org_id.';
COMMENT ON COLUMN nexus.sale_events.occurred_at IS
  'The provider timestamp — the measurement date. Distinct from ingested_at on purpose.';
COMMENT ON COLUMN nexus.sale_events.jurisdiction_source IS
  'Which fallback resolved the jurisdiction. A low-confidence attribution stays visible in the evidence.';

-- THE idempotency guarantee (design §6.4). A duplicate webhook delivery, or a
-- backfill page overlapping live sync, is a no-op at the database level — not
-- in application code. The write is INSERT … ON CONFLICT DO NOTHING RETURNING *;
-- an empty return means "already applied", which is success, not error.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_sale_events_dedupe_idx
  ON nexus.sale_events (org_id, channel_id, provider_event_id, kind);

-- Serves every aggregation variant in one scan (design §5.1).
CREATE INDEX IF NOT EXISTS nexus_sale_events_agg_idx
  ON nexus.sale_events (org_id, jurisdiction, occurred_at DESC);

-- Keyset pagination for the ledger view.
CREATE INDEX IF NOT EXISTS nexus_sale_events_org_occurred_idx
  ON nexus.sale_events (org_id, occurred_at DESC, id DESC);

-- The console renders a refund linked to the sale it reverses; without this
-- the link is a sequential scan of the tenant's whole ledger.
CREATE INDEX IF NOT EXISTS nexus_sale_events_reverses_idx
  ON nexus.sale_events (org_id, reverses_event_id)
  WHERE reverses_event_id IS NOT NULL;

-- Drives the evaluation watermark: "which orgs have ledger activity since the
-- last run" (design §8 step 1), without scanning the ledger by org.
CREATE INDEX IF NOT EXISTS nexus_sale_events_ingested_idx
  ON nexus.sale_events (ingested_at DESC, org_id);

-- NX1.5 finding S-1. Composite unique target for the tenant-scoped reversal
-- FK below.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_sale_events_org_id_id_idx
  ON nexus.sale_events (org_id, id);

-- NX1.5 finding S-1. A refund must reverse a row belonging to the SAME
-- tenant. Without this, `reverses_event_id` is a bare UUID: an import that
-- echoes back an id it was handed — or a repository bug — produces a ledger
-- whose internal consistency cannot be proven, and the console's "reversal
-- linked to its original" join either renders broken or reaches across
-- tenants. Self-referential and composite, so it cannot be declared inline;
-- the guard makes re-application a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nexus_sale_events_reverses_fk'
      AND conrelid = 'nexus.sale_events'::regclass
  ) THEN
    ALTER TABLE nexus.sale_events
      ADD CONSTRAINT nexus_sale_events_reverses_fk
      FOREIGN KEY (org_id, reverses_event_id)
      REFERENCES nexus.sale_events (org_id, id);
  END IF;
END $$;
