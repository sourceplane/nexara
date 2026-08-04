-- 220_nexus_rules: versioned reference data — rule sets and rules.
--
-- Context: nexus
-- Epic: nexus (NX1)
--
-- **Neither table has an org_id, and that is deliberate.** They are shared
-- global reference data: a state's economic-nexus threshold is the same fact
-- for every seller. This is stated here so that a reviewer who notices a table
-- without tenant scoping finds the reason already written down instead of
-- filing it as a finding. The corollary is a rule, not a preference: no tenant
-- data may ever be joined *into* these tables, and the CI tenancy scan exempts
-- them by explicit name, never by pattern (design §3.3, §7.3).
--
-- Rules are DATA, not code. A threshold change is a new rule row with an
-- effective date in a new rule set version — additive, never a mutation — so a
-- determination made under 2026.08 stays evaluable under 2026.08 forever, even
-- after 2027.01 lands. That is what makes invariant 3 hold across years.

-- Required by the range-overlap EXCLUDE constraint below (NX1.5 finding S-4).
-- btree_gist lets a GiST index carry the scalar equality columns alongside the
-- daterange, which is what makes "no two rules for the same jurisdiction in
-- the same set may overlap in time" expressible as a constraint rather than as
-- a hope about how rule sets get authored. Ships with Supabase Postgres.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS nexus.rule_sets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human-ordered, e.g. '2026.08.01'.
  version      TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A GATE, not a label (design §11):
  --   > No customer-facing determination may be produced from a rule set with
  --   > verified = false.
  -- Enforcement is in the engine's caller, not the UI. Until a rule set is
  -- verified against primary sources by a named human with tax-practice
  -- accountability, every environment runs unverified — which is a working
  -- state, not a blocked one.
  verified     BOOLEAN NOT NULL DEFAULT false,
  source_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE nexus.rule_sets IS
  'Published rule sets. GLOBAL reference data — deliberately not tenant-scoped. Exempt by name from the CI tenancy scan.';
COMMENT ON COLUMN nexus.rule_sets.verified IS
  'A gate, not a label. An unverified set produces internal-only determinations and no customer-facing alert.';

CREATE UNIQUE INDEX IF NOT EXISTS nexus_rule_sets_version_idx
  ON nexus.rule_sets (version);

-- Newest-first listing, and the "which set is current" lookup.
CREATE INDEX IF NOT EXISTS nexus_rule_sets_published_idx
  ON nexus.rule_sets (published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS nexus.rules (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NX1.5 finding S-5: RESTRICT, not CASCADE.
  --
  -- The first draft cascaded. A determination stores `rule_id` and re-running
  -- the engine against it is the product's whole defence; cascading a rule set
  -- delete would silently destroy that evidence and leave determinations
  -- pointing at nothing. Rule sets are additive and are never deleted in
  -- normal operation — so the only time this constraint fires is the one time
  -- it must.
  rule_set_id               UUID NOT NULL REFERENCES nexus.rule_sets (id) ON DELETE RESTRICT,

  -- 'US-CA', 'US-TX' for states; a bare ISO country code ('GB', 'DE') for the
  -- international VAT/GST registration thresholds. Nothing in this schema
  -- distinguishes them — the evaluator's jurisdiction filter does, in one
  -- place — because international rows are carried display-only in v1.
  jurisdiction              TEXT NOT NULL,

  effective_from            DATE NOT NULL,
  effective_to              DATE,

  measurement_basis         TEXT NOT NULL
                              CHECK (measurement_basis IN ('gross', 'retail', 'taxable')),
  measurement_period        TEXT NOT NULL
                              CHECK (measurement_period IN
                                ('rolling_12m', 'calendar_year', 'previous_calendar_year')),

  -- The IANA zone the measurement DATES are taken in.
  --
  -- occurred_at is a UTC instant; a threshold window is a range of the
  -- jurisdiction's own calendar dates. A 31 December 23:00 PST sale is a
  -- 1 January UTC row, and without this column it lands in the wrong
  -- measurement year — the most likely silent bug in the product (design §5.3
  -- case 4, R7). It lives on the rule rather than in engine code because it is
  -- per-jurisdiction reference data with an effective date, exactly like every
  -- other column here; a state that changes its sourcing basis changes it in a
  -- new rule-set version, not in a code deploy.
  measurement_timezone      TEXT NOT NULL DEFAULT 'UTC',

  sales_threshold_cents     BIGINT,
  transaction_threshold     INTEGER,

  -- 'none' is a POSITION, not a gap. Forty-eight jurisdictions enforce a
  -- threshold; New Hampshire, Oregon, Montana, Delaware, and Alaska (at the
  -- state level) enforce none, and they get an explicit row saying so with
  -- both threshold columns null. Absent data and deliberately absent
  -- obligation must not render identically: the first is a bug in our rule
  -- set, the second is the answer.
  threshold_logic           TEXT NOT NULL
                              CHECK (threshold_logic IN
                                ('none', 'sales_only', 'transactions_only', 'either', 'both')),

  marketplace_treatment     TEXT NOT NULL
                              CHECK (marketplace_treatment IN ('include', 'exclude')),

  registration_deadline_rule JSONB NOT NULL,
  notes                     TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A window must be non-empty.
  CONSTRAINT nexus_rules_effective_range_ck
    CHECK (effective_to IS NULL OR effective_to > effective_from),

  -- The logic and the thresholds must agree. A 'sales_only' rule with a null
  -- sales threshold would divide the meter by null and render as 0% — which
  -- is precisely the "renders confidently wrong" failure this product exists
  -- to avoid. Catch it at write time, in the one place it cannot be skipped.
  CONSTRAINT nexus_rules_threshold_logic_ck CHECK (
    (threshold_logic = 'none'
       AND sales_threshold_cents IS NULL AND transaction_threshold IS NULL)
    OR (threshold_logic = 'sales_only'         AND sales_threshold_cents IS NOT NULL)
    OR (threshold_logic = 'transactions_only'  AND transaction_threshold IS NOT NULL)
    OR (threshold_logic IN ('either', 'both')
       AND sales_threshold_cents IS NOT NULL AND transaction_threshold IS NOT NULL)
  ),

  CONSTRAINT nexus_rules_positive_thresholds_ck CHECK (
    (sales_threshold_cents IS NULL OR sales_threshold_cents > 0)
    AND (transaction_threshold IS NULL OR transaction_threshold > 0)
  ),

  -- The deadline rule is a tagged union, not a free-text field, so
  -- engine/deadline.ts can be a total function over it.
  CONSTRAINT nexus_rules_deadline_kind_ck CHECK (
    registration_deadline_rule ->> 'kind' IN (
      'days_after_crossing', 'first_of_next_month', 'end_of_next_month',
      'first_of_next_quarter', 'first_of_month_after_days', 'none')
  ),

  -- NX1.5 finding S-4. Within one rule set, a jurisdiction's rules must
  -- partition time — no two may be in force on the same day.
  --
  -- The unique index on (rule_set_id, jurisdiction, effective_from) below
  -- stops two rules *starting* together, which is what a first reading catches
  -- and is not enough: two rules with different starts and open ends are both
  -- in force forever after the later one begins. "The rule in force on date D"
  -- then has two answers, the lookup picks one by ORDER BY, and design §5.3
  -- case 3 — splitting a window at a mid-window rule change — silently
  -- measures the wrong segment. That is R2's "confidently wrong answer, and
  -- because determinations are immutable it persists in the record".
  --
  -- A NULL effective_to makes the daterange unbounded above, which is exactly
  -- "still in force", so the constraint needs no sentinel date.
  CONSTRAINT nexus_rules_no_overlap_excl EXCLUDE USING gist (
    rule_set_id WITH =,
    jurisdiction WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  )
);

COMMENT ON TABLE nexus.rules IS
  'Per-jurisdiction rules with effective dates. GLOBAL reference data — deliberately not tenant-scoped. Exempt by name from the CI tenancy scan.';
COMMENT ON COLUMN nexus.rules.measurement_timezone IS
  'IANA zone the measurement dates are taken in. Without it a 31 Dec 23:00 PST sale lands in the wrong measurement year.';
COMMENT ON COLUMN nexus.rules.threshold_logic IS
  '"none" is a first-class answer, not a missing row. The engine treats it as terminal and never computes a measurement.';

-- One rule per jurisdiction per effective_from within a set. A rule set that
-- contains two rules starting the same day for the same state is ambiguous,
-- and an ambiguous rule set produces a determination that cannot be defended.
CREATE UNIQUE INDEX IF NOT EXISTS nexus_rules_set_jurisdiction_from_idx
  ON nexus.rules (rule_set_id, jurisdiction, effective_from);

-- The hot lookup: "the rule in force for this jurisdiction on this date,
-- in this rule set".
CREATE INDEX IF NOT EXISTS nexus_rules_lookup_idx
  ON nexus.rules (rule_set_id, jurisdiction, effective_from DESC);
