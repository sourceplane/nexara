-- 250_nexus_synthetic_rule_set: the unverified starter rule set.
--
-- Context: nexus
-- Epic: nexus (NX4)
--
-- **This rule set is `verified = false`, and that is the point.**
--
-- Design §11 states the gate:
--
--   > No customer-facing determination may be produced from a rule set with
--   > verified = false.
--
-- Q1 — who publishes and verifies rule sets, from which primary sources — is
-- open, and its resolution has a shape even though its answer does not:
-- verification is a claim about primary tax sources, so `verified = true` is
-- set by a named human with tax-practice accountability and never by an
-- engineer reading a state website. Until that person exists, every
-- environment runs this set, every determination it produces is marked
-- internal_only, and the console renders the §11 banner instead of a status.
--
-- That is a working state, not a blocked one: the engine, the ledger, the
-- board, and the evidence trail are all exercisable end to end. What is NOT
-- exercisable is telling a customer they owe something — which is exactly the
-- claim we have no basis to make yet.
--
-- The numbers below are approximate and STRUCTURAL. They exist so the product
-- has fifty-odd real-shaped rules to run against, covering every measurement
-- basis, all three periods, both marketplace treatments, all five threshold
-- logics, and every deadline-rule variant. **Do not read them as tax advice,
-- and do not flip `verified` without replacing them.**
--
-- Idempotent: keyed on the rule-set version, so re-application is a no-op.

INSERT INTO nexus.rule_sets (version, verified, source_note)
VALUES (
  '2026.08.01-synthetic',
  false,
  'SYNTHETIC starter data, structurally representative and NOT verified against primary sources. Every determination produced from this set is internal-only (design 11). Replace before setting verified = true; see open question Q1.'
)
ON CONFLICT (version) DO NOTHING;

-- The no-threshold states get an EXPLICIT row with threshold_logic = 'none'
-- rather than an absent one, so "no obligation" and "no data" can never render
-- alike: the first is the answer, the second is a bug in our rule set.
--
-- The international rows (GB, DE) are display-only in v1 (design 3.3):
-- stored, versioned, and shown, but never evaluated into a determination or an
-- alert. Nothing here distinguishes them; the evaluator's jurisdiction filter
-- does, in one place.
INSERT INTO nexus.rules (
  rule_set_id, jurisdiction, effective_from, effective_to,
  measurement_basis, measurement_period, measurement_timezone,
  sales_threshold_cents, transaction_threshold,
  threshold_logic, marketplace_treatment, registration_deadline_rule)
SELECT s.id, v.jurisdiction, DATE '2019-01-01', NULL,
       v.measurement_basis, v.measurement_period, v.measurement_timezone,
       v.sales_threshold_cents, v.transaction_threshold,
       v.threshold_logic, v.marketplace_treatment, v.registration_deadline_rule
FROM nexus.rule_sets s
CROSS JOIN (VALUES
  ('US-AL', 'gross', 'previous_calendar_year', 'America/Chicago', 25000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-AK', 'gross', 'rolling_12m', 'America/Anchorage', NULL, NULL, 'none', 'include', '{"kind":"none"}'::jsonb),
  ('US-AZ', 'gross', 'previous_calendar_year', 'America/Phoenix', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-AR', 'gross', 'previous_calendar_year', 'America/Chicago', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-CA', 'gross', 'previous_calendar_year', 'America/Los_Angeles', 50000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_quarter"}'::jsonb),
  ('US-CO', 'retail', 'previous_calendar_year', 'America/Denver', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-CT', 'gross', 'rolling_12m', 'America/New_York', 10000000, 200, 'both', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-DE', 'gross', 'rolling_12m', 'America/New_York', NULL, NULL, 'none', 'include', '{"kind":"none"}'::jsonb),
  ('US-DC', 'retail', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-FL', 'taxable', 'previous_calendar_year', 'America/New_York', 10000000, NULL, 'sales_only', 'exclude', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-GA', 'retail', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-HI', 'gross', 'previous_calendar_year', 'Pacific/Honolulu', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-ID', 'gross', 'previous_calendar_year', 'America/Boise', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-IL', 'retail', 'rolling_12m', 'America/Chicago', 10000000, 200, 'either', 'exclude', '{"kind":"first_of_next_quarter"}'::jsonb),
  ('US-IN', 'gross', 'previous_calendar_year', 'America/Indiana/Indianapolis', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-IA', 'gross', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-KS', 'gross', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-KY', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-LA', 'gross', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"days_after_crossing","days":30}'::jsonb),
  ('US-ME', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-MD', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-MA', 'retail', 'previous_calendar_year', 'America/New_York', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-MI', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-MN', 'retail', 'rolling_12m', 'America/Chicago', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-MS', 'gross', 'rolling_12m', 'America/Chicago', 25000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-MO', 'taxable', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_quarter"}'::jsonb),
  ('US-MT', 'gross', 'rolling_12m', 'America/Denver', NULL, NULL, 'none', 'include', '{"kind":"none"}'::jsonb),
  ('US-NE', 'retail', 'previous_calendar_year', 'America/Chicago', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-NV', 'retail', 'previous_calendar_year', 'America/Los_Angeles', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-NH', 'gross', 'rolling_12m', 'America/New_York', NULL, NULL, 'none', 'include', '{"kind":"none"}'::jsonb),
  ('US-NJ', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-NM', 'taxable', 'previous_calendar_year', 'America/Denver', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-NY', 'gross', 'rolling_12m', 'America/New_York', 50000000, 100, 'both', 'include', '{"kind":"days_after_crossing","days":30}'::jsonb),
  ('US-NC', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-ND', 'taxable', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-OH', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-OK', 'taxable', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-OR', 'gross', 'rolling_12m', 'America/Los_Angeles', NULL, NULL, 'none', 'include', '{"kind":"none"}'::jsonb),
  ('US-PA', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_quarter"}'::jsonb),
  ('US-RI', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-SC', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-SD', 'gross', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-TN', 'retail', 'rolling_12m', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-TX', 'gross', 'rolling_12m', 'America/Chicago', 50000000, NULL, 'sales_only', 'include', '{"kind":"first_of_month_after_days","days":30}'::jsonb),
  ('US-UT', 'gross', 'previous_calendar_year', 'America/Denver', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-VT', 'gross', 'rolling_12m', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-VA', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-WA', 'retail', 'previous_calendar_year', 'America/Los_Angeles', 10000000, NULL, 'sales_only', 'exclude', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-WV', 'gross', 'previous_calendar_year', 'America/New_York', 10000000, 200, 'either', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-WI', 'gross', 'previous_calendar_year', 'America/Chicago', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('US-WY', 'gross', 'previous_calendar_year', 'America/Denver', 10000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('GB', 'gross', 'rolling_12m', 'Europe/London', 9000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb),
  ('DE', 'gross', 'calendar_year', 'Europe/Berlin', 1000000, NULL, 'sales_only', 'include', '{"kind":"first_of_next_month"}'::jsonb)
) AS v (jurisdiction, measurement_basis, measurement_period, measurement_timezone,
        sales_threshold_cents, transaction_threshold,
        threshold_logic, marketplace_treatment, registration_deadline_rule)
WHERE s.version = '2026.08.01-synthetic'
ON CONFLICT (rule_set_id, jurisdiction, effective_from) DO NOTHING;
