# Epic: nexus

**Turn the starter into Nexara — economic-nexus threshold monitoring for
ecommerce sellers.**

An ecommerce seller owes sales tax in a US state once their sales into that
state cross an *economic nexus* threshold. The thresholds differ per state, in
amount, in what counts toward them, and in the window they are measured over.
Most sellers discover they crossed one when a state sends a notice, years and
penalties later. Nexara watches the line and says so on the day it is crossed.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** — charter only; no code has landed |
| Cluster | **NX** (NX0–NX9) — the first *product* bounded context on this starter |
| Owner(s) | new `apps/nexus-worker`, new `apps/channels-worker`, `apps/api-edge`, `packages/{contracts,policy-engine,db,sdk,cli}`, `apps/web-console-next` |
| Target branch | `main` |
| Builds on | the shipped platform: identity/membership, policy engine, `@saas/db` + Hyperdrive, metering/billing, notifications, events, webhooks, SDK/CLI, console foundation |
| Decisions locked | Two new bounded contexts (`nexus`, `channels`); org = the seller/tenant; money is integer cents everywhere including the engine; `nexus.sale_events` is append-only and never `UPDATE`d — a refund is a new negative row referencing the original; rules are **versioned reference data, not code**, and are global (no `org_id`); every determination stores `rule_set_version` + `rule_id` + `engine_version` + its exact `inputs` so it is reproducible years later; the evaluation engine is pure and I/O-free; tenant isolation is query-level scoping enforced by a single repository surface **plus a CI scan**, not Postgres RLS (Hyperdrive pools connections); the only unauthenticated ingress is signature-verified provider webhooks; **no customer-facing determination is produced from an unverified rule set** |

## Thesis

The platform already owns everything a compliance SaaS needs except the
compliance: tenancy, RBAC, an append-only event log, metered entitlements,
billing, notifications, signed outgoing webhooks, and an audited admin surface.
What is missing is one bounded context that knows about money crossing a border,
and one that knows how to get that money out of Stripe and Shopify without
losing or double-counting a cent.

So the product is small and the discipline is large. Three invariants carry it:

1. **Money is integer cents.** `BIGINT`, columns named `*_cents`. No floats, no
   `NUMERIC`, nowhere — including inside the engine.
2. **The ledger is never updated in place.** No `UPDATE` statement exists
   against `nexus.sale_events` anywhere in the codebase. A refund is a new row
   with negative cents and `reverses_event_id` pointing at the original.
3. **A determination is reproducible.** It stores the rule-set version, the rule
   id, the engine version, and the exact aggregate it was computed from — so a
   determination made today can be re-derived in two years when a seller gets a
   state notice and asks why we said what we said.

Invariant 3 is the product. Anyone can render a progress bar; the defensible
claim is *"here is the rule that applied, the window it measured, the numbers it
measured, and the code version that decided — re-run it yourself."*

## Read order

1. `README.md` (this file) — charter.
2. [`design.md`](./design.md) — bounded contexts, data model, the engine, the
   aggregation, ingestion sequencing, tenancy, and the explicit non-goals.
3. [`implementation-plan.md`](./implementation-plan.md) — NX0–NX9 with
   acceptance criteria.
4. [`risks-and-open-questions.md`](./risks-and-open-questions.md) — what could
   make this wrong, and what is still undecided.
5. [`IMPLEMENTATION-STATUS.md`](./IMPLEMENTATION-STATUS.md) — as-built record.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| NX0 | Product identity: repo + catalog framing from "starter" to Nexara; this epic doc set | Draft |
| NX1 | Contracts + schema: `@saas/contracts/{nexus,channels}`, migrations `200`–`240`, RBAC actions | Ready |
| NX2 | Determination engine: pure `engine/{periods,measure,threshold,deadline}`, exhaustively unit-tested without a database | Ready |
| NX3 | Aggregation + ledger: `@saas/db/nexus` repository, the single-scan jurisdiction aggregate, dedupe-constrained append | Ready |
| NX4 | `nexus-worker` + edge + SDK + CLI: exposure, jurisdiction detail, evaluate, ledger import | Ready |
| NX5 | Evaluation cron, immutable determinations, threshold alerts (notifications + events + outgoing webhook type) | Ready |
| NX6 | `channels-worker`: provider seam, inbound inbox + drain, Stripe adapter, backfill/live-sync sequencing | Ready |
| NX7 | Shopify adapter: ship-to jurisdiction resolution + marketplace-facilitator identification | Ready |
| NX8 | Console: exposure board, jurisdiction detail + determination explainer, ledger, channels, registrations, storefront | Ready |
| NX9 | Commercial + evidence: metered plans and entitlements, seeded demo tenant, docs/catalog, stage + prod verification | Ready |

## Delivery cut lines

Two defensible stopping points, because the first one has a commercial deadline
attached and the second does not:

- **Demo cut — NX0 → NX4 plus the exposure board from NX8.** A merchant logs in
  and sees a real exposure board computed by the real engine from a real ledger
  seeded through `POST /ledger/import`. No OAuth, no live webhooks, no Shopify.
  The demo must **say so on its own about page** — what is seeded, what is
  synthetic, and that the rule set is unverified. Roughly one working day on top
  of the live baseline.
- **Full product — NX0 → NX9.** Roughly twelve working days.

The cut line runs *after* NX2 and NX3, never through them. If the calendar
slips, connectors slip; the engine and its tests do not.

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| US state economic-nexus thresholds (sales and/or transaction counts) | Sales-tax *calculation*, rate lookup, or filing |
| Rolling-12-month, calendar-year, and previous-calendar-year measurement periods | Returns preparation, remittance, or any money movement |
| Gross / retail / taxable measurement bases | Registration *filing* with a state (we surface the deadline; a human files) |
| Marketplace-facilitator inclusion/exclusion per jurisdiction | Marketplace facilitator obligations of the marketplace itself |
| Stripe and Shopify ingestion; CSV import | Amazon, eBay, Walmart, PayPal, Square adapters (additive, later) |
| International VAT/GST registration thresholds, **display-only** | International VAT/GST evaluation and alerting |
| Threshold alerting, registration deadline tracking, immutable evidence | Tax advice of any kind |

## Verification bar

The engine (periods, measurement bases, threshold logic, marketplace treatment,
deadlines) is unit-tested **without a database**, table-driven, with one case per
boundary listed in `design.md` §5.3. Backend milestones are verified on stage by
an authenticated CLI walkthrough (`nexara nexus …`, `--output json`) and smoke-
checked on prod after promotion. NX8 is verified live with an authenticated
browser walkthrough and screenshots.

One additional bar specific to this epic: **reproducibility is a test, not a
claim.** `reproducibility.test.ts` re-runs the pinned `ENGINE_VERSION` against a
stored `inputs` payload and its `rule_id`, and asserts the stored `status`,
`crossed_on`, and `registration_due_on` come back byte-identical. A change that
breaks it is a breaking change and requires an `ENGINE_VERSION` bump, not a
patched expectation.
