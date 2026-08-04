-- 230_nexus_determinations: the reproducibility record.
--
-- Context: nexus
-- Epic: nexus (NX1)
--
-- This table is the product. Anyone can render a progress bar; the defensible
-- claim is "here is the rule that applied, the window it measured, the numbers
-- it measured, and the code version that decided — re-run it yourself."
--
-- Never updated. Re-running engine_version against inputs and rule_id must
-- reproduce status, crossed_on, and registration_due_on exactly; that is
-- reproducibility.test.ts, not a comment.
--
-- Growth is bounded by the change-detection rule (design §8 step 4): a row is
-- written only when the status or the measured value changed. Without it,
-- forty-eight jurisdictions × hourly evaluation × N tenants makes the history
-- unreadable within a week — which is a correctness requirement for the
-- history view, not an optimisation (R5).

CREATE TABLE IF NOT EXISTS nexus.determinations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL,
  jurisdiction            TEXT NOT NULL,
  evaluated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── the reproducibility triple ──
  -- Stored as values, not as foreign keys to mutable rows: a determination
  -- must stay readable after its rule set is superseded, and rule_set_version
  -- is what a human quotes back to a state.
  rule_set_version        TEXT NOT NULL,
  rule_id                 UUID NOT NULL,
  engine_version          TEXT NOT NULL,

  -- ── the window actually measured ──
  period_start            TIMESTAMPTZ NOT NULL,
  period_end              TIMESTAMPTZ NOT NULL,

  -- ── what we measured, and what against ──
  measured_sales_cents    BIGINT NOT NULL,
  measured_transactions   INTEGER NOT NULL,
  threshold_sales_cents   BIGINT,
  threshold_transactions  INTEGER,

  -- 'no_obligation' is the terminal answer for threshold_logic='none' and is
  -- deliberately distinct from 'clear': 'clear' means measured and below the
  -- line, 'no_obligation' means there is no line. A board that renders them
  -- alike has lost the distinction the rule row exists to carry.
  status                  TEXT NOT NULL
                            CHECK (status IN
                              ('no_obligation', 'clear', 'approaching', 'crossed', 'registered')),

  crossed_on              DATE,
  registration_due_on     DATE,

  -- The exact aggregate handed to the engine. This is what makes the row
  -- re-derivable years later without the ledger being intact.
  inputs                  JSONB NOT NULL,

  -- True when produced from an unverified rule set. Such rows raise no alert
  -- and the console renders the §11 banner in place of a status. Denormalised
  -- from rule_sets.verified deliberately: the gate must be readable from the
  -- determination alone, without a join to a row that may since have been
  -- flipped to verified.
  internal_only           BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT nexus_determinations_period_ck CHECK (period_end > period_start),

  -- crossed_on is set exactly when the position is crossed-or-beyond.
  CONSTRAINT nexus_determinations_crossed_ck CHECK (
    (status IN ('crossed', 'registered')) = (crossed_on IS NOT NULL)
  ),

  -- A deadline without a crossing is meaningless.
  CONSTRAINT nexus_determinations_due_ck CHECK (
    registration_due_on IS NULL OR crossed_on IS NOT NULL
  ),

  -- 'no_obligation' is terminal: no measurement was computed, so no threshold
  -- was measured against. A row claiming both is a bug in the caller.
  CONSTRAINT nexus_determinations_no_obligation_ck CHECK (
    status <> 'no_obligation'
    OR (threshold_sales_cents IS NULL AND threshold_transactions IS NULL)
  )
);

COMMENT ON TABLE nexus.determinations IS
  'Immutable determination record. NEVER UPDATEd. Re-running engine_version against inputs and rule_id must reproduce status, crossed_on, and registration_due_on exactly.';
COMMENT ON COLUMN nexus.determinations.inputs IS
  'The exact aggregate handed to the engine, stored verbatim. The reproducibility test reads this column.';
COMMENT ON COLUMN nexus.determinations.crossed_on IS
  'The jurisdiction-local date on which the measurement was first OBSERVED to cross. Not a claim about the legal instant of crossing.';
COMMENT ON COLUMN nexus.determinations.internal_only IS
  'Produced from an unverified rule set. No alert is raised and the console renders the unverified banner instead of a status.';

-- "Current position" is the first row of this index; the history is the rest.
CREATE INDEX IF NOT EXISTS nexus_determinations_current_idx
  ON nexus.determinations (org_id, jurisdiction, evaluated_at DESC, id DESC);

-- The board reads one row per jurisdiction for a tenant; this keeps the
-- whole-org sweep off the per-jurisdiction index.
CREATE INDEX IF NOT EXISTS nexus_determinations_org_evaluated_idx
  ON nexus.determinations (org_id, evaluated_at DESC, id DESC);

-- NX1.5 finding S-6. Composite unique target for the tenant-scoped FK from
-- nexus.alerts, so an alert cannot cite another tenant's determination.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_determinations_org_id_id_idx
  ON nexus.determinations (org_id, id);

-- Design §12: "determination produced from verified = false" must be a
-- countable signal. If it is ever non-zero in prod the gate has a hole, and
-- nothing else in the system will say so.
CREATE INDEX IF NOT EXISTS nexus_determinations_internal_only_idx
  ON nexus.determinations (evaluated_at DESC)
  WHERE internal_only;
