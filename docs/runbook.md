# Nexara — product runbook

What to do when the product misbehaves. The **platform** operating contract —
workspaces, deploys, migrations, secrets — is
[`ai/context/operations.md`](../ai/context/operations.md); this page is the
nexus-specific half, written for whoever is on the other end of "my board says
something wrong".

Every procedure below assumes the CLI (`nexara …`), which every command
supports with `--output json` so a check can be scripted rather than clicked.

---

## "Why does my board say this?"

The most common question, and the one the product is built to answer without a
narrator.

1. **Open the jurisdiction.** `/orgs/:slug/jurisdictions/US-TX`, or
   `nexara nexus jurisdiction show --jurisdiction US-TX`.
2. **Read the explainer.** It carries the rule-set version, the rule id, the
   engine version, the window (half-open — the end date is *not* measured), the
   measured value against the threshold, which basis and marketplace treatment
   applied, and the raw inputs exactly as stored.
3. **If the numbers look wrong, they are wrong in the ledger, not in the
   engine.** Filter the ledger by that jurisdiction and compare. The usual
   causes, in order of frequency:
   - a channel stopped delivering (see below) — the board reads *calmer* than
     reality, never louder;
   - orders attributed by a **fallback** — the ledger names which one, and
     `Billing address (fallback)` is a poor proxy for where a service was
     consumed;
   - marketplace-facilitated orders excluded by that state's rule, which is
     correct and is stated on the card.

Do **not** "fix" a determination. There is no way to, by design: a
determination is immutable, and a support tool that could change one turns the
audit record into an opinion. If the ledger was wrong, correct the ledger and
re-evaluate; the new determination is a new row and the old one stays.

## A channel has gone quiet

R3: absence of data is indistinguishable from absence of sales, and a silent
connector produces a board that keeps saying `clear`.

The staleness baseline is the channel's **own observed cadence** —
`max(24h, 6 × median interval)`, capped at three weeks — so a seller with one
order a week is not told they are broken. A channel past that is `degraded` and
reads as **Quiet** on the console with copy that names the ambiguity rather
than resolving it.

To triage:

1. `nexara nexus … ` — or the console's Channels page — and read **Recent
   deliveries**. Deliveries arriving but failing is a different problem from no
   deliveries at all.
2. **Failing deliveries:** the reason is a short, sanitised code (never
   provider body content). `append_failed_internal` means the ledger write was
   rejected — check the drain's logs for that request id.
3. **No deliveries:** the webhook registration or the credential is the
   suspect. Disconnect and reconnect the channel. **This does not lose ledger
   history** — the ledger is append-only and a disconnect stops ingestion only.
   The reconnect's backfill covers the gap, and the dedupe index makes the
   overlap free.

## A delivery failed terminally

The drain retries with backoff to `MAX_ATTEMPTS` and then marks the delivery
`failed`. Terminal failures keep their payload for **30 days** (applied ones
for 7), because a failed delivery is precisely the one someone will want to
look at, and also the one nobody looks at today.

A terminally failed delivery means **a sale is missing from the ledger**, which
means a position may be understated. Re-drive it by asking the provider to
redeliver the webhook; the dedupe receipt survives the payload purge, so a
redelivery of something already applied is a no-op rather than a double count.

## Alerts are not arriving

Three states, and the console's Exposure page shows which one you are in:

| What the board says | What is true | Fix |
|---|---|---|
| "Alerts go to *address*" | Working. | — |
| "Alerts are going to an address you did not choose" | An environment-level default is receiving them. | Set the org's tax contact. |
| "**No one is being told when you cross a threshold**" | Positions are recorded; no email is sent. | Set the org's tax contact. |

`nexara nexus alert-contact --email finance@example.com` sets it;
`--clear` returns the org to the environment default. Alerts with no recipient
still write their alert row with `notification_ref = 'no_recipient_configured'`
— so the gap is queryable:

```sql
SELECT org_id, count(*)
FROM nexus.alerts
WHERE notification_ref = 'no_recipient_configured'
GROUP BY org_id;
```

Note that an **unverified rule set raises no customer-facing alert at all**
(§11), by design. If a seller expected an alert and the board shows the
unverified banner, that is the gate working, not a delivery failure.

## The §11 counter is non-zero in production

The signal that matters most:

```sql
SELECT count(*) FROM nexus.determinations d
JOIN nexus.rule_sets rs ON rs.version = d.rule_set_version
WHERE rs.verified = false AND d.internal_only = false;
```

**This must be zero.** A non-zero result means a determination produced from an
unverified rule set escaped as customer-facing — the gate has a hole, and
nothing else in the system will say so. Treat it as a stop-the-line defect:
the product's whole claim is that it does not assert what it has not verified.

## Evaluation is not running

The cron runs hourly at `7 * * * *` and processes orgs with ledger activity
newer than their watermark, up to a per-tick cap.

- **A single org failing does not stop the tick** — that is asserted by test.
- **Watermarks only move forward** (`GREATEST`), so two evaluations racing
  cannot move one backwards and skip work.
- To force one org now: `nexara nexus evaluate`. It runs the same code the cron
  runs and writes a determination only for positions that changed, so calling
  it repeatedly is safe and is not a way to manufacture history.

If nothing is being evaluated at all, check the watermark:

```sql
SELECT org_id, last_ingested_at, last_evaluated_at
FROM nexus.evaluation_watermarks ORDER BY last_evaluated_at DESC LIMIT 20;
```

A watermark ahead of the ledger means the tick believes it has already seen
everything.

## A seller disputes a position from months ago

This is the case the product exists for, and it needs no special tooling.

1. Find the determination — the jurisdiction page lists history newest-first,
   and selecting a past entry re-renders the explainer **against that
   determination's own stored inputs**.
2. Everything needed to reproduce it is on the row: rule-set version, rule id,
   engine version, and the exact aggregate. Re-run that engine version against
   those inputs and it returns the same answer; that is asserted on every build
   by `reproducibility.test.ts`.
3. If the answer today differs, the *ledger* changed (a late refund, a
   corrected attribution) — and the old determination still stands as the
   record of what was known then. That is the point of not updating in place.

## A whole surface reads "we couldn't load this"

The console shows an error card — *"We couldn't load your exposure board"* —
on every nexus page for an organization, while the org itself still appears in
the switcher.

That combination is authorization, not data. The sidebar is populated from
`membership.organization_members`; the gate reads
`membership.role_assignments`. **An org can appear in the switcher while the
subject has no role assignment in it**, and the gate then denies.

Every denial returns an identical 404 on purpose — a distinguishable response
would be a membership oracle — so do not try to tell the causes apart from the
wire. The reason is in the log instead:

```
{"level":"warn","msg":"nexus.authz_denied","reason":"…","action":"organization.nexus.read",
 "orgId":"org_…","subjectType":"user","subjectId":"usr_…"}
```

| `reason` | What it means | Fix |
|---|---|---|
| `membership_unavailable` | no role assignment for this subject in this org, **or** membership-worker was unreachable | check `membership.role_assignments` for the pair; if the row is missing, re-add the member in Settings → Members. If it is missing for *every* member of the org, the org was created by a path that skipped the role assignment — see below |
| `policy_denied` | the role exists but does not grant this action | the role is too narrow; check the §7.2 matrix in `packages/policy-engine` against the `action` field |

`reason` is `membership_unavailable` for **every** subject in an org → suspect
provisioning rather than roles. `create-organization` writes the member row and
the `owner` role assignment in one transaction, so a normally-created org has
both; an org with one and not the other was created some other way. The
decommissioned Solo profile's `ensurePersonalOrg` was exactly such a path — it
POSTed the org and swallowed every error, checking nothing — so
`personal-…`-slugged orgs from that era are the first place to look.

The fastest confirmation is to create a fresh organization through
`/onboarding` and load its board. If the new org works and the old one does
not, it is that org's rows, not the code.

## Support needs to look at a tenant

`GET /v1/internal/support/organizations/:orgId/nexus` returns that tenant's
channel and backfill state, determination history with the stored inputs
verbatim, registrations, and the delivery inbox with failures first.

It is **read-only without exception** and audited like every other support
action. It is **not reachable from a browser** today — `admin-worker` is
internal-only and the platform has no staff identity to authenticate one
against. See [`support-view.md`](../specs/epics/nexus/support-view.md) for the
blocker and what the missing page costs once that lands.

## Things that are never the fix

- **Editing a ledger row.** There is no update path. A correction is a new row.
- **Overriding a determination.** There is no write path, in the API or the
  SDK, and there will not be one.
- **Turning off the unverified banner.** It is the presentation half of a gate
  whose other half is in the engine's caller; removing it hides a state that
  still exists.
- **Widening a tenancy-scan exemption to make a query pass.** The closed list
  of three reasons is closed on purpose. A new reason is a design decision that
  belongs in review, not in a red build.
