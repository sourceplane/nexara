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
| Q3 | Do digital-goods sourcing rules belong in v1? | R4, rule schema | product |
| Q4 | What is the volume-aware staleness baseline for a channel? | R3, NX6 | engineering |
| Q5 | Is any Postgres-side isolation reachable under Hyperdrive pooling? | R6 | engineering — spike before NX6 |
| Q6 | Retention: how long is the raw `inbound_deliveries` payload kept? It contains customer PII and is only needed until the delivery is applied. | NX6 | product + engineering |

Q6 is the one with a regulatory edge — a raw Shopify order payload carries names
and addresses. The current assumption is that payloads are purged on a schedule
after `applied`, keeping only the canonical ledger row. That assumption is not
yet a decision.
