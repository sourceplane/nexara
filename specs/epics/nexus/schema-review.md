# nexus — Schema and Tenant-Isolation Review (NX1.5)

Status: **Complete.** All findings are closed or accepted in writing. NX3 is
open.

| Field | Value |
|-------|-------|
| Scope | migrations `200`–`240` as landed by NX1; the tenancy argument of design §7.3; the dedupe index as the sole idempotency guarantee (§6.4); the `rule_sets`/`rules` un-scoped exemption (§3.3); the PII surface of `inbound_deliveries` against Q6 |
| Reviewed at | the migrations hold no rows in any environment |
| Findings | 12 — 7 fixed in the NX1 migrations, 1 fixed in contracts, 4 accepted in writing |
| Blocks | NX3 (aggregation and the repository) |

## How this was read

The instruction for this gate is adversarial: *assume the repository has a bug
and ask what the blast radius is*, and treat "the design doc already addresses
this" as a claim to test rather than an answer. Three questions were asked of
every table:

1. **If the handler's `org_id` scoping were wrong, what would the database
   still refuse?** Design §7.3 chooses query scoping over RLS for a real reason
   and states plainly that a repository bug is then a cross-tenant bug. That is
   true for *reads*. It did not have to be true for *writes*, and in the
   as-landed schema it was — which is findings S-1, S-2, and S-6.
2. **What write path reaches the ledger without passing the dedupe index?** —
   S-8, S-9.
3. **What does this row still contain after the thing it was for is done?** —
   S-3, S-10.

Findings that changed the schema were folded into the NX1 migrations, which is
the point of sequencing this gate before NX3: the tables hold no rows, so a
finding costs a checksum bump rather than a migration plus a backfill plus a
rewritten determination history.

---

## Findings

### S-1 — A refund could reverse another tenant's sale · **High** · fixed

`nexus.sale_events.reverses_event_id` was a bare `UUID` with no foreign key.
Nothing in the database required it to name a row in the same organization, so
the guarantee rested entirely on the import handler passing an id it had
already scoped — and the ledger's internal consistency was therefore
unprovable rather than proven.

The blast radius is not primarily a data leak: `org_id` is set from the session,
so the refund lands in the caller's own ledger and does not alter a victim's
totals. It is worse than that in a way specific to this product. The console
renders a refund as a reversal *linked to its original*; a row pointing across
tenants makes that join either render broken or reach into another tenant's
ledger. And a determination computed from a ledger that cannot be shown to be
internally consistent is not evidence, which is the only thing this table is
for.

**Disposition — fixed** in `200_nexus_core`: a unique index on
`(org_id, id)` plus

```sql
FOREIGN KEY (org_id, reverses_event_id) REFERENCES nexus.sale_events (org_id, id)
```

added through a `pg_constraint`-guarded `DO` block, because a self-referential
composite FK cannot be declared inline and `ADD CONSTRAINT` has no
`IF NOT EXISTS`.

### S-2 — A ledger row could claim another tenant's channel · **High** · fixed

Same class as S-1, on `channel_id`, and with a larger radius. The dedupe index
is `(org_id, channel_id, provider_event_id, kind)`, so `channel_id` is *part of
the idempotency key*. A row carrying a channel id belonging to another org
occupies a dedupe slot that the owning tenant's real event would later need,
and the per-channel ledger filter in the console mis-scopes silently.

**Disposition — fixed** in `200_nexus_core`: unique index
`nexus_channels_org_id_id_idx (org_id, id)` and an inline composite FK on
`sale_events (org_id, channel_id)`. This is the same pattern the platform
already uses for `projects.environments → projects.projects`; the reviewer's
note is that the product context did not inherit it and nobody would have
noticed until a bug did.

**Why S-1 and S-2 matter more than their size.** Design §7.3's tradeoff is
stated as "RLS is defence-in-depth against a repository bug; query scoping has
none". After these two, that sentence is too pessimistic for the write path:
the write path now has a second line of defence that costs two unique indexes
and no runtime. Reads are still unprotected, which is S-11.

### S-3 — The PII retention policy was unimplementable · **High** · fixed

`nexus.inbound_deliveries.payload` was `JSONB NOT NULL`. Q6's working
assumption is that raw provider payloads are purged on a schedule after
`applied`, keeping only the canonical ledger row. With the column `NOT NULL`,
purging the payload requires **deleting the row** — and the row is the
`(provider, provider_delivery_id)` dedupe receipt. Delete it and a provider
redelivering an old webhook after the purge window is re-applied, double-
counting a sale into a threshold measurement.

So the schema as written forced a choice between honouring the retention policy
and honouring idempotency. That is not a tradeoff anyone would have made
deliberately; it is what happens when a column is marked `NOT NULL` because it
is always present at *insert* time.

**Disposition — fixed** in `210_nexus_ingestion`: `payload` is nullable, with

```sql
CHECK ((purged_at IS NULL) = (payload IS NOT NULL))
CHECK (purged_at IS NULL OR status IN ('applied', 'skipped', 'failed'))
```

The row is the receipt; the payload is the PII; purging separates them. The
second constraint stops a purge from destroying work the drain has not done.

### S-4 — Two rules could be in force for the same jurisdiction on the same day · **High** · fixed

`nexus_rules_set_jurisdiction_from_idx` is unique on
`(rule_set_id, jurisdiction, effective_from)`, which stops two rules from
*starting* on the same date. That is the failure a first reading catches and it
is not the one that happens. Two rules with **different** starts and both
`effective_to IS NULL` are both in force from the later start onward, forever.

"The rule in force on date D" then has two answers. The lookup picks one by
`ORDER BY effective_from DESC`, which is probably the intended one — and design
§5.3 case 3, splitting a window at a mid-window rule change, then measures one
segment under a rule that was supposed to have ended. No error is raised
anywhere. This is R2 exactly: *a stale rule set silently produces confident
wrong answers, and because determinations are immutable the wrong answers
persist in the record.*

**Disposition — fixed** in `220_nexus_rules`:

```sql
CONSTRAINT nexus_rules_no_overlap_excl EXCLUDE USING gist (
  rule_set_id WITH =, jurisdiction WITH =,
  daterange(effective_from, effective_to, '[)') WITH &&
)
```

A `NULL` upper bound makes the range unbounded above, which is precisely "still
in force", so no sentinel date is needed. The constraint requires `btree_gist`
(the migration creates it; it ships with Supabase Postgres) — an operational
dependency worth naming because it is the only extension this context adds.

**Accepted alternative, rejected:** validate non-overlap at publish time in
application code. Rejected because rule publication is exactly the path a
future operator tool, a seed script, and a migration will all write to
independently, and "validated in the one place that writes it" is a claim with
a short shelf life.

### S-5 — Deleting a rule set would cascade away the evidence · **High** · fixed

`rules.rule_set_id` was declared `ON DELETE CASCADE`. A determination stores
`rule_id`, and re-running the engine against that rule and the stored `inputs`
is the product's entire defence when a seller receives a state notice.
Cascading a rule-set delete destroys the rules, leaves every determination
citing them pointing at nothing, and does so with no error at the moment it
matters.

Rule sets are additive and are never deleted in normal operation, which is
exactly why the cascade looked harmless. The one time it fires is the one time
it must not.

**Disposition — fixed** in `220_nexus_rules`: `ON DELETE RESTRICT`.

### S-6 — An alert could cite another tenant's determination · **High** · fixed

`nexus.alerts.determination_id` had no foreign key. An alert carries a
seller's measured position into their inbox; one citing a foreign
determination sends one seller's numbers to another seller.

**Disposition — fixed**: unique index `(org_id, id)` on `nexus.determinations`
(230) and a composite FK from `nexus.alerts` (240).

### S-7 — The engine's return type admitted a status it cannot produce · **Medium** · fixed

`DeterminationOutcome.status` was typed as the full `DeterminationStatus`
union, which includes `'registered'`. The engine is pure: it receives an
aggregate and a rule, and neither knows whether the seller has registered.
`'registered'` is a *board projection* status, applied over the top from
`nexus.registrations`.

Typing it into the engine's output invites a caller to write a branch that
never runs, and — worse for a reviewer — makes the engine look as though it
consults registration state, which would break its purity claim.

**Disposition — fixed** in `@saas/contracts/nexus`: a narrower `EngineStatus`
(`no_obligation | clear | approaching | crossed`) types the engine's output;
`DeterminationStatus` keeps all five for the board and the stored row.

### S-8 — `ON CONFLICT DO NOTHING` silently discards a *changed* re-delivery · **High** · accepted, with a required behaviour

The dedupe key is `(org_id, channel_id, provider_event_id, kind)`. A provider
that re-sends the same event id with **different amounts** — a Stripe charge
amended after currency conversion settles, a Shopify order edited before
fulfilment — hits the conflict and is dropped. The ledger keeps the first
amount forever, and because the ledger is append-only there is no correction
path in the design at all.

This is the sharpest thing in this review, and it cannot be fixed in the
schema: the database is doing exactly what it was asked to do, and asking it to
compare payloads on conflict would put business logic in a constraint.

**Disposition — accepted, because** the alternative — an updatable ledger —
loses invariant 2 and with it the whole evidentiary argument. The residual risk
is closed by behaviour, recorded here as a requirement on the milestones that
implement it rather than as a hope:

- **NX3.** `appendSaleEvents` already reports `applied` and `duplicates`
  separately (the contract carries both). It must additionally, on a conflict,
  read back the stored row and compare the monetary fields; a *differing*
  duplicate is a distinct outcome from an identical one.
- **NX6.** A differing duplicate marks the delivery `skipped` with a reason of
  its own and raises the design §12 signal. It must not read as a successful
  no-op, because it is the one case where a no-op is wrong.
- **Follow-on.** A first-class amendment event (`kind='amendment'`, delta
  cents, `reverses_event_id` pointing at the original) is the correct long-term
  answer and is additive against this schema. Named in
  `risks-and-open-questions.md` as R9.

### S-9 — The drain's due-work query cannot be tenant-scoped · **Medium** · accepted, exemption narrowed

Design §7.3 names two exemptions from the CI tenancy scan: `nexus.rule_sets`
and `nexus.rules`. There is a third. `nexus.inbound_deliveries` is written
before attribution — a webhook is authenticated by a signature, not by a
session — so both the receipt insert and the drain's `WHERE status = 'received'`
claim query are necessarily un-scoped. A scan that exempts only the two named
tables would fail on the drain, and the obvious repair (exempt by pattern)
would quietly disarm the scan for every table whose name starts with the same
letters.

**Disposition — accepted, with the exemption narrowed rather than widened.**
The NX3 scan exempts `nexus.rule_sets` and `nexus.rules` wholesale by name, and
exempts `nexus.inbound_deliveries` **only** for the receipt insert and the
drain claim, each marked at its call site. Every tenant-facing read of the
inbox — the console's delivery list, the support view — must still carry
`org_id = $`. Recorded as an NX3 requirement.

### S-10 — `internal_only` freezes at write time, and should · **Low** · accepted

`determinations.internal_only` is denormalised from `rule_sets.verified` rather
than joined. A rule set verified *after* determinations were produced under it
leaves those rows flagged internal-only forever; a set later found wrong and
flipped back to `false` leaves earlier rows customer-facing.

Both look like staleness bugs and neither is. A determination records what we
said, under the rule set as it stood, at the time we said it. Re-deriving
`internal_only` through a live join would make the historical record change
under a reader's feet, which is what invariant 3 exists to forbid.

**Disposition — accepted, because** the alternative is a mutable audit trail.
Noted in the migration comment so the next reader does not "fix" it.

### S-11 — Cross-tenant *reads* still have no second line of defence · **Medium** · accepted

After S-1, S-2, and S-6, a repository bug can no longer write a cross-tenant
row. A missing `org_id = $1` in a **read** still returns another tenant's data,
and nothing in the database will stop it, because Q5 (is any Postgres-side
isolation reachable under Hyperdrive pooling?) is open and `SET LOCAL` on a
pooled connection is the footgun design §7.3 correctly refuses.

**Disposition — accepted, with the control strengthened.** The NX3 scan as
specified reads the repository sources. That verifies the queries it finds; it
does not verify the claim that the repository is *the only* SQL surface. The
scan must therefore also fail any `nexus.`/`channels.` SQL string found
**outside** `packages/db/src/nexus/`, which converts "one repository module is
the only SQL surface for each schema" from a convention into a test. Recorded
as an NX3 requirement. Q5's spike stays open and still gates NX6.

### S-12 — The ledger is deliberately PII-free, and this should be stated · **Informational**

Not a defect; recorded because its absence would eventually be read as an
oversight. `nexus.sale_events` carries `ship_to_country` and `ship_to_region`
and nothing else identifying — no name, no street address, no email, no
provider customer id. That is why the retention policy of Q6 only ever has to
cover `inbound_deliveries`: once a delivery is normalised, what survives into
the ledger is not personal data.

Any future adapter that wants to persist a customer identifier onto a ledger
row is not adding a column; it is changing this property, and it should come
back through this document.

---

## Verdict

The schema is sound for NX3 to build on. The isolation argument of design §7.3
is **stronger than the doc claims for writes** and exactly as weak as it claims
for reads.

Two things carried forward as requirements rather than intentions, both on NX3:

1. The CI tenancy scan must also fail `nexus.`/`channels.` SQL found outside
   the repository module (S-11), with the three named exemptions of S-9.
2. `appendSaleEvents` must distinguish an identical duplicate from a differing
   one (S-8).

One risk is new and belongs in the register: **R9 — a provider amending an
already-ingested event is silently dropped.** Added to
`risks-and-open-questions.md`.
