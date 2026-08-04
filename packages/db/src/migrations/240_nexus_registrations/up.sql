-- 240_nexus_registrations: registrations and the alert log.
--
-- Context: nexus
-- Epic: nexus (NX1)
--
-- We surface a registration deadline; a human files. Nexara never files with a
-- state on a seller's behalf, so `registrations` is the seller's own record of
-- where they stand, tracked so the board can say "crossed, and you have
-- registered" rather than raising the same alert forever.
--
-- `alerts` exists for exactly one reason: to make "alert exactly once, even if
-- the cron double-fires" a database constraint instead of a distributed lock.
-- The unique index below is cheaper and more honest than a lock, and it is
-- correct under concurrent cron invocations, which a lock with a TTL is not.

CREATE TABLE IF NOT EXISTS nexus.registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  jurisdiction  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned', 'filed', 'active', 'closed')),
  registered_on DATE,
  permit_ref    TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A registration that claims to be active without a date cannot support the
  -- board's "registered since" line, and a closed registration is history.
  CONSTRAINT nexus_registrations_active_ck CHECK (
    status <> 'active' OR registered_on IS NOT NULL
  )
);

COMMENT ON TABLE nexus.registrations IS
  'Seller-owned registration state per jurisdiction. Nexara surfaces the deadline; a human files. Every query must scope by org_id.';

-- One open registration per jurisdiction. Re-registering after closing is
-- legal; two live registrations in the same state is not.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_registrations_open_idx
  ON nexus.registrations (org_id, jurisdiction)
  WHERE status <> 'closed';

CREATE INDEX IF NOT EXISTS nexus_registrations_org_idx
  ON nexus.registrations (org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS nexus.alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL,
  jurisdiction     TEXT NOT NULL,
  determination_id UUID NOT NULL,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('approaching', 'crossed', 'deadline')),
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The notifications-worker's handle for the enqueued message, so a support
  -- question about a missing email is answerable without guessing.
  notification_ref TEXT,

  -- NX1.5 finding S-6. Tenant-scoped: an alert cites a determination, and an
  -- alert citing another tenant's determination would send one seller's
  -- numbers to another seller's inbox. The uniqueness index this references
  -- lives in 230.
  CONSTRAINT nexus_alerts_determination_fk
    FOREIGN KEY (org_id, determination_id)
    REFERENCES nexus.determinations (org_id, id)
);

COMMENT ON TABLE nexus.alerts IS
  'Append-only alert log. The unique index below IS the exactly-once guarantee — cheaper and more honest than a distributed lock, and correct under a double-firing cron.';

-- "Alert exactly once, even if the cron double-fires."
CREATE UNIQUE INDEX IF NOT EXISTS nexus_alerts_once_idx
  ON nexus.alerts (org_id, jurisdiction, determination_id, kind);

CREATE INDEX IF NOT EXISTS nexus_alerts_org_sent_idx
  ON nexus.alerts (org_id, sent_at DESC, id DESC);

-- ── Evaluation watermark ───────────────────────────────────
-- The hourly job asks "which orgs have ledger activity since I last looked"
-- (design §8 step 1). Without a durable watermark that question is either a
-- full ledger scan or a fixed lookback window that silently drops late
-- arrivals — a backfill page landing an hour after the cron ran is exactly the
-- case that must not be missed.

CREATE TABLE IF NOT EXISTS nexus.evaluation_watermarks (
  org_id            UUID PRIMARY KEY,
  -- Highest ingested_at consumed by a completed evaluation. Deliberately
  -- ingested_at and not occurred_at: the question is "what have I not yet
  -- seen", and a backfilled 2024 sale ingested today is unseen.
  last_ingested_at  TIMESTAMPTZ NOT NULL,
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE nexus.evaluation_watermarks IS
  'Per-org evaluation watermark keyed on ingested_at, so a late-arriving backfill page is picked up rather than skipped by a fixed lookback.';
