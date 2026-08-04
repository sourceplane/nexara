# nexus — The Connector Gate (Q4, Q5, Q6)

Status: **Resolved.** NX6 is open.

`implementation-plan.md` states that NX6 opens on Q4, Q5, and Q6 — a channel
staleness baseline, the Hyperdrive isolation spike, and the retention decision
for raw delivery payloads. None of the three blocks anything before it, which
is why the connectors sit where they sit. This document answers all three so
that the answers are on the record rather than implied by the code that
happens to have been written.

Two are engineering-owned and are decided here. The third (Q6) is
product + engineering; engineering's half is decided and implemented, and the
part that is genuinely product's is stated as a bounded default with the
decision it is standing in for named.

---

## Q4 — What is the volume-aware staleness baseline for a channel?

**The question.** R3: a connector that silently stops delivering produces a
board that keeps saying `clear`, because absence of data reads identically to
absence of sales. A fixed staleness window does not work — a low-volume seller
can legitimately go a week without an order, and alerting them every week
teaches them to ignore the alert that matters.

**Resolved: the baseline is the channel's own observed cadence, with a floor
and a ceiling.**

A channel is `degraded` when the time since `last_event_at` exceeds

```
max(MIN_QUIET_HOURS, QUIET_MULTIPLE × medianIntervalHours) capped at MAX_QUIET_HOURS
```

with `MIN_QUIET_HOURS = 24`, `QUIET_MULTIPLE = 6`, `MAX_QUIET_HOURS = 21 × 24`.

- **A seller with ten orders a day** has a median interval near 2.4 hours; the
  floor governs, so they go `degraded` after a day of silence. That is right:
  for that seller, a silent day is an outage.
- **A seller with one order a week** has a median interval near 168 hours;
  `6 ×` puts the threshold at six weeks, capped to three. That is also right:
  they are not broken, they are quiet, and telling them otherwise is noise.
- **A brand-new channel** has no interval to take a median of. It is exempt
  until `backfill_completed_at` is set *and* at least five events have
  arrived — a channel with four lifetime orders has no cadence, and inventing
  one from a sample of four produces a confidently wrong baseline, which is
  the failure mode this whole product is organised against.

**Why the median and not the mean.** A seller's order intervals are heavily
skewed — a Black Friday burst followed by a quiet January. The mean of that
distribution is dominated by the burst and would put the threshold far too
tight in January. The median is the typical gap, which is the thing being
asked about.

**Where it lives.** `apps/channels-worker/src/staleness.ts`, pure and
synchronous, taking the interval sample as a parameter. It reads no clock, for
the same reason the determination engine does not: a function that reads the
clock cannot be replayed against a stored sample when someone asks why a
channel was flagged.

**What it deliberately does not do.** It does not alert the seller. A
`degraded` channel is an operational signal on the board and in the §12
metrics; turning it into an email is a product decision about how much noise a
compliance product is allowed to make, and there is no evidence yet to make it
on. The state is recorded so that decision has data when it is taken.

---

## Q5 — Is any Postgres-side isolation reachable under Hyperdrive pooling?

**The question.** Design §7.3 chose query scoping over RLS because
`SET LOCAL app.current_org` on a pooled connection leaks a tenant context onto
whichever request borrows the socket next — silent and cross-tenant, the worst
pair of properties a bug can have. R6 asks whether *any* Postgres-side
belt-and-braces is reachable regardless, since connector-written rows are the
highest-volume tenant data in the system.

**Resolved: no session-scoped mechanism is safe, and one transaction-scoped
mechanism is — but it is not worth its cost. Structural isolation is used
instead, and it is already in place.**

### What was considered, and why each was rejected

| Option | Verdict |
|---|---|
| RLS with `SET app.current_org` (session-scoped) | **Unsafe.** Hyperdrive pools connections; a session GUC outlives the request that set it. This is the footgun §7.3 already names. |
| RLS with `SET LOCAL app.current_org` (transaction-scoped) | **Safe but not sufficient.** `SET LOCAL` is rolled back at transaction end, so it cannot leak. But the repository's reads are single statements in autocommit — each would have to be wrapped in an explicit transaction purely to carry the GUC, doubling round trips on the hottest path in the product for a control that only fires when another control has already failed. |
| RLS with a per-request database role | **Unreachable.** Requires a role per tenant and `SET ROLE`, which is session-scoped and lands back in the first row's problem. |
| A per-tenant schema | **Rejected on cost.** Forty-eight jurisdictions × N tenants of DDL, and every migration becomes a fan-out. This is a real architecture for a very small number of very large tenants; it is the wrong one for a self-serve SaaS. |

### What is used instead

The isolation argument is now structural at **three** layers rather than one,
and the NX1.5 review is what moved it from one to three:

1. **The authorization gate** runs before every repository call (§7.1).
2. **Composite foreign keys** make a cross-tenant *write* impossible at the
   database level (NX1.5 findings S-1, S-2, S-6). This is the belt-and-braces
   Q5 was looking for; it arrived from a different direction than RLS and it
   covers the write path completely.
3. **The CI tenancy scan** fails any `nexus.`/`channels.` query lacking
   `org_id = $`, and any such SQL found *outside* the repository module
   (S-11). Exemptions are declared at the call site from a closed list of
   three reasons, never granted by table name (S-9).

**Residual risk, stated plainly.** A missing `org_id = $1` in a **read** still
returns another tenant's data if it ever reaches production. Layer 3 is what
stops it reaching production, and it is a test rather than a runtime guard.
That is a real difference from RLS and it is accepted knowingly: the
alternative costs a transaction wrapper on every read for a guard that only
fires after the scan has already failed to.

**Q5 is closed as "no, and it does not matter as much as it did when the
question was asked."** R6 stays open in the register as a standing risk rather
than an open question, because the risk is permanent and the question is not.

---

## Q6 — How long is the raw `inbound_deliveries` payload kept?

**The question.** A raw Shopify order payload carries customer names and
addresses. It is needed only until the delivery is applied. The working
assumption was that payloads are purged on a schedule; that assumption was not
a decision.

**Resolved, in two halves.**

### Engineering's half — decided and implemented

**The payload is purged as soon as the delivery reaches a terminal state, plus
a bounded grace period, and purging never destroys the dedupe receipt.**

The NX1.5 review found that the original schema made this impossible: `payload
JSONB NOT NULL` meant purging required deleting the row, and the row is the
`(provider, provider_delivery_id)` receipt — so a provider redelivering an old
webhook after the purge window would have been re-applied and double-counted
into a threshold. The column is now nullable with paired constraints:

```sql
CHECK ((purged_at IS NULL) = (payload IS NOT NULL))
CHECK (purged_at IS NULL OR status IN ('applied', 'skipped', 'failed'))
```

The row is the receipt; the payload is the PII; purging separates them.

**Grace period: 7 days after `applied_at`.** Long enough that a support
question about a delivery from earlier in the week can still be answered from
the payload; short enough that the window is a week rather than a liability.
Terminally `failed` deliveries keep their payload for **30 days**, because a
failed delivery is precisely the one someone will want to look at, and it is
also the one that will not be looked at today.

The sweep runs in the same cron as the drain, batched, after the drain's own
work — a purge that competes with ingestion for the tick's budget would
starve the thing that matters.

**And the adjacent decision design §12 already took holds:** payloads never
reach a log sink. A retention policy on the inbox is worthless if the same
bytes are also sitting in logs outside it.

### Product's half — a bounded default, and what it stands in for

Whether a seller can request a longer retention (for their own audit) or a
shorter one (for their own compliance posture) is a product decision with
contractual implications, and there is no customer to ask yet. The default
above holds for every tenant.

What is committed to now is that the decision is **implementable when it is
taken**: retention is a per-row timestamp and a sweep predicate, not a
`DELETE` policy baked into the schema, so making it per-tenant later is a
column and a lookup rather than a migration against live PII.

---

## What this gate changed about NX6

Nothing about NX6's scope, and two things about its content:

- The drain gains a **retention sweep** it would not otherwise have had, and
  the sweep runs after the drain rather than before it.
- Staleness is a **pure module with its own tests**, not an inline `if` in the
  cron. Q4's answer is a judgement call with numbers in it, and a judgement
  call with numbers in it belongs somewhere a reviewer can argue with it.
