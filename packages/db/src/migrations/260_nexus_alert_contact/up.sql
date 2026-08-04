-- 260_nexus_alert_contact — where a seller's threshold alerts go (R10).
--
-- NX5 shipped the alert mechanism with a per-environment `NEXUS_ALERT_EMAIL`
-- var and labelled it a stopgap: with nothing configured, the alert row and
-- the outgoing webhook still fire and the row records
-- `notification_ref = 'no_recipient_configured'`, so the gap is queryable
-- rather than something a support ticket discovers. This migration closes it
-- the way NX5 said it should be closed — the seller names their own contact.
--
-- Two shape decisions worth the sentences:
--
--   * **It lives in `nexus`, not in `config` or `membership`.** Resolving org
--     members' emails from the evaluation cron would mean a second SQL surface
--     on another context's tables — the exact failure the tenancy scan exists
--     to prevent, arriving from the other direction — or a new cross-context
--     route on two other workers, called by a job that has no actor to
--     authorize as. A context owning its own notification target is the
--     smaller thing.
--
--   * **One row per org, org_id as the primary key.** A list of recipients is
--     a mailing list, and a mailing list is a feature with its own semantics
--     (who removes whom, what happens on member departure). One accountable
--     contact is the honest v1 and it upgrades to a list without a rewrite:
--     the primary key becomes a unique index and nothing else moves.

CREATE TABLE IF NOT EXISTS nexus.alert_contacts (
  org_id     UUID PRIMARY KEY,
  -- Deliberately NOT a foreign key to a user: the tax contact is frequently an
  -- accountant or a shared finance inbox rather than a console user, and
  -- requiring them to have a login would push sellers to use their own address
  -- and then never see the alert.
  email      TEXT NOT NULL
               CHECK (length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1),
  -- Free-text label so a seller can tell "our bookkeeper" from "me". Never
  -- used for routing.
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE nexus.alert_contacts IS
  'Where threshold alerts for one org are sent. One accountable contact per org; NEXUS_ALERT_EMAIL remains the environment-level fallback when none is set.';
COMMENT ON COLUMN nexus.alert_contacts.email IS
  'Often an accountant or a shared finance inbox rather than a console user, which is why this deliberately carries no foreign key into the identity context.';
