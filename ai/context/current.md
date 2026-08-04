# Current Context (compact)

Keep this file current as product work begins.

## State

nexara is freshly scaffolded. Deployment phases may still be in
progress; the docs flow (phase 08) records the verified live state.

- **What is deployed, where:** [deployment.md](deployment.md) - the
  generated manifest (placeholder until the docs flow runs).
- **How to operate it:** [operations.md](operations.md).
- Established design decisions and risks: [decisions.md](decisions.md),
  [open-risks.md](open-risks.md).

## Active epic

**[`nexus`](../../specs/epics/nexus/) (cluster NX)** — turn the starter into
Nexara: economic-nexus threshold monitoring for ecommerce sellers. An
append-only sale-event ledger fed by connected sales channels, aggregated per
jurisdiction, evaluated against versioned rule data by a pure engine, and
recorded as immutable, reproducible determinations.

Status: **Ready — agreed and implementable, no code yet.** Read
[`specs/epics/nexus/README.md`](../../specs/epics/nexus/README.md) first; the
locked decisions are the `Decisions locked` row of its status table. Commercial
date: **15 September 2026**.

## Next

- ~~**NX0** — reframe `README.md` and `intent.yaml` from "starter" to Nexara,
  and author `docs/overview.md` as the catalog front page.~~ **Done.**
- ~~**NX1** — contracts and schema.~~ **Done.** Migrations `200`–`240`,
  `@saas/contracts/{nexus,channels}`, the nine RBAC actions.
- ~~**NX1.5** — the schema and tenant-isolation gate.~~ **Done.** 12 findings
  in [`schema-review.md`](../../specs/epics/nexus/schema-review.md); 8 fixed
  into the NX1 migrations before they were applied anywhere, 4 accepted in
  writing. Two carry forward as **NX3 requirements**: the CI tenancy scan must
  also fail `nexus.`/`channels.` SQL found outside the repository module
  (S-11), and `appendSaleEvents` must distinguish an identical duplicate from a
  differing one (S-8).
- ~~**NX2** — the pure determination engine.~~ **Done.** `ENGINE_VERSION`
  1.0.0, 144 tests, every §5.3 boundary named, purity enforced by a source
  scan, and four frozen reproducibility vectors. Mutation-checked.
- ~~**NX3** — aggregation and the ledger repository.~~ **Done.** The single
  SQL surface for the `nexus` schema, the §5.1 single-scan aggregate, the
  dedupe-constrained append, and the tenancy scan — which now also fails
  `nexus.`/`channels.` SQL found *outside* the repository (S-11) and reports an
  amended re-delivery as `divergent` rather than as an ordinary duplicate
  (S-8). Mutation-checked against three isolation bypasses.
- ~~**NX4** — the worker, the edge facade, the SDK, and the CLI.~~ **Done.**
  The read product end to end. A synthetic `verified = false` rule set is
  seeded by migration `250` so the slice is actually runnable; every
  determination it produces is `internal_only` and the CLI prints the §11
  banner rather than a status.
- ~~**NX5** — the hourly evaluation cron, change detection, and threshold
  alerts.~~ **Done.** Cron attached at `7 * * * *`. `nexus.threshold.crossed`
  needed no registry entry — `webhooks-worker` fans out every event type on the
  log, so emitting it *is* the registration. **One gap carried to NX8:** the
  alert recipient is a per-environment `NEXUS_ALERT_EMAIL` stopgap; a seller
  naming their own tax contact needs a console to ask in. When unset the alert
  row records `no_recipient_configured` rather than failing silently.
- ~~**NX6** — `channels-worker` and the Stripe adapter.~~ **Done.** Q4, Q5,
  and Q6 are resolved in
  [`connector-gate.md`](../../specs/epics/nexus/connector-gate.md), which is
  what opened the milestone. The backfill/live seam is tested through the real
  drain, not asserted about the index.
- **NX7 → NX9** — the Shopify adapter, the console, then the commercial
  surface and live verification.
- Two questions to answer before they get expensive: who publishes and verifies
  rule sets (Q1), and whether the tenant is a seller or an accounting firm
  holding many sellers (Q2). Q4, Q5, and Q6 gate NX6. **R9** (a provider
  amending an already-ingested event is silently dropped) is new from the
  NX1.5 review. All in
  [`risks-and-open-questions.md`](../../specs/epics/nexus/risks-and-open-questions.md).
