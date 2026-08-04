# nexus — Risks and Open Questions

Status: Live. Close entries with a note when resolved; do not delete them.

## Risks

### R1 — A wrong determination is worse than no determination · High

The product's output looks like a compliance position. A seller who trusts a
`clear` that should have been `crossed` accrues liability and penalties, and the
determination record — our defence — becomes the evidence against us.

Mitigations: the `verified` gate (design §11); every §5.3 boundary case as a
named test before handlers exist; the reproducibility test as a merge blocker;
and product copy that never states a legal conclusion — we report a measurement
against a rule, we do not advise.

### R2 — Rule data drifts and nobody notices · High

Thresholds and measurement bases change by legislation. A stale rule set
silently produces confident wrong answers, and because determinations are
immutable, the wrong answers persist in the record.

Mitigations: rules are versioned data with effective dates, so a new rule set is
additive rather than a mutation; `rule_sets.verified` requires a human;
rule-set diffing ("what changed, and which of your positions moved") is a named
follow-on. **Open:** who owns rule-set publication, and at what cadence. Until
that is answered, no environment may run a `verified = true` set.

### R3 — Ingestion gaps are invisible · High

A connector that silently stops delivering produces a board that keeps saying
`clear` because no sales arrived. Absence of data reads identically to absence
of sales.

Mitigations: `channels.status` with a `degraded` state; a staleness check in the
hourly job that flags a channel with no delivery inside its expected cadence;
`backfill_completed_at` distinguishing "not yet ingested" from "nothing to
ingest". **Open:** the per-provider expected cadence — a low-volume seller can
legitimately go days without an order, so the check needs a volume-aware
baseline rather than a fixed window.

### R4 — Jurisdiction resolution is a guess dressed as a fact · Medium

Ship-to jurisdiction falls back through three sources (design §6.2). A digital
seller may have no shipping address at all, and billing address is a poor proxy
for where a service was consumed.

Mitigations: the fallback level that fired is recorded on every ledger row and
surfaced in the explainer, so a low-confidence attribution is visible rather
than laundered. **Open:** whether digital-goods sourcing rules (which differ
again per state) belong in v1 or in a follow-on.

### R5 — Determination table growth · Medium

Forty-eight jurisdictions × hourly evaluation × N tenants makes an unreadable
history very quickly.

Mitigated by the change-detection rule in NX5 (write only on a status or
measured-value change), which is a correctness requirement for the history view,
not an optimisation. It has a test.

### R6 — Query-scoped isolation has no second line of defence · Medium

Design §7.3 chooses query scoping over RLS for a real reason, and accepts that a
repository bug is then a cross-tenant bug.

Mitigations: single repository surface, the authz gate before every call, and
the CI scan in NX3. **Open:** whether a Postgres-side belt-and-braces layer is
reachable at all under Hyperdrive pooling — worth a spike before NX6, since
connector-written rows are the highest-volume tenant data in the system.

### R7 — Timezone handling is the most likely silent bug · Medium

`occurred_at` is UTC; measurement dates are jurisdictional. The failure mode is
a handful of orders landing in the wrong year, which moves a threshold by
exactly enough to matter and produces no error anywhere.

Mitigated by §5.3 case 4 as an explicit test, and by never deriving a date from
a timestamp outside `engine/periods.ts`.

### R9 — An amended provider event is silently dropped · High

Raised by the NX1.5 review as finding S-8. The ledger dedupes on
`(org_id, channel_id, provider_event_id, kind)` with `ON CONFLICT DO NOTHING`.
A provider that re-sends the same event id with **different amounts** — a
Stripe charge amended after currency conversion settles, a Shopify order edited
before fulfilment — is discarded, and the first amount stands forever. Because
the ledger is append-only there is no correction path in the v1 design at all.

This cannot be fixed in the schema without either putting business logic into a
constraint or making the ledger updatable, and the second loses invariant 2 and
the evidentiary argument with it.

Mitigations, each a milestone requirement rather than an intention: NX3's
`appendSaleEvents` reads back a conflicting row and distinguishes an *identical*
duplicate from a *differing* one; NX6's drain marks a differing duplicate
`skipped` with its own reason and raises the §12 signal, because that is the
one case where a silent no-op is wrong. **Open:** a first-class amendment event
(`kind = 'amendment'`, delta cents, pointing at the original) is the correct
long-term answer and is additive against the current schema — it is not in
NX0–NX9.

### R10 — A threshold alert may have nobody to send to · Medium

Raised at NX5. Design §8 says "enqueue the notification" and does not say to
whom, and there is no clean answer inside the nexus context: resolving org
members' emails needs either a second SQL surface on `membership.`/`identity.`
tables — the exact failure design §7.3's scan exists to prevent, arriving from
the other direction — or new cross-context routes on two other workers.

NX5 ships the mechanism against a per-environment `NEXUS_ALERT_EMAIL` var,
labelled a stopgap in the code. When it is unset the alert row and the outgoing
`nexus.threshold.crossed` webhook still fire, and the row records
`notification_ref = 'no_recipient_configured'` — so "a threshold moved and
nobody was told" is a queryable fact rather than something a support ticket
discovers.

Mitigation: the outgoing webhook is a working machine-readable alert today.
**Open:** a seller naming their own tax contact needs a console to ask in, so
the resolution lands with NX8. A compliance alert arguably *should* go to a
named finance contact rather than to whoever happens to hold an admin role,
which makes the stopgap closer to the eventual design than a member fan-out
would have been.

### R8 — Provider API and webhook-shape drift · Low

Stripe and Shopify version their APIs and change payload shapes.

Mitigated by the provider seam: shape knowledge is confined to the adapter, and
`normalize()` is fixture-tested. Pin API versions explicitly per adapter rather
than tracking the account default.

## Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| Q1 | Who publishes and verifies rule sets, at what cadence, from which primary sources? | any `verified = true` environment | product |
| Q2 | Is the tenant a seller, or an accounting firm holding many sellers? The org/sub-org shape differs, and the Firm plan (design §9) presumes the latter. | NX9 plan modelling | product |
| Q3 | Do digital-goods sourcing rules belong in v1? Sharpened by the international rows, which exist precisely for non-resident *digital services* sellers — a seller with no shipping address anywhere. | R4 — **not** NX1; see below | product |
| Q4 | What is the volume-aware staleness baseline for a channel? | R3, NX6 | engineering |
| Q5 | Is any Postgres-side isolation reachable under Hyperdrive pooling? | R6 | engineering — spike before NX6 |
| Q6 | Retention: how long is the raw `inbound_deliveries` payload kept? It contains customer PII and is only needed until the delivery is applied. | NX6 | product + engineering |

**Q3 does not block NX1**, and this is worth stating because it looks like it
should. Digital-goods sourcing would enter the schema as an additional column on
`nexus.rules` and an additional branch in `engine/measure.ts` — additive against
rules that are already versioned reference data, so adopting it later costs a
new rule-set version rather than a migration against live determinations. NX1
proceeds on the current shape. What v1 *does* commit to is recording the
jurisdiction-resolution fallback level on every ledger row (R4), which is what
makes the question answerable from real data instead of from argument when
product picks it up.

Q1's resolution has a shape even though its answer is open: rule-set
verification is a claim about primary tax sources, so `verified = true` is set
by a named human with tax-practice accountability, and never by an engineer
reading a state website. Until that person exists, §11 holds and every
environment runs unverified — which is a working state, not a blocked one.

Q6 is the one with a regulatory edge — a raw Shopify order payload carries names
and addresses. The current assumption is that payloads are purged on a schedule
after `applied`, keeping only the canonical ledger row. That assumption is not
yet a decision. Design §12 takes the adjacent decision now regardless: payloads
never reach a log sink, because a retention policy on the inbox is worthless if
the same bytes are also sitting in logs outside it.
