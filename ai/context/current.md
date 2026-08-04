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
- **NX1 → NX4** — contracts and schema, the pure determination engine,
  aggregation, then the worker/edge/SDK/CLI slice. This is the demo cut.
- **NX1.5 is a hard gate between NX1 and NX3.** The schema and tenant-isolation
  review is written down in `schema-review.md` before the aggregation is built
  on the schema. Do not skip it because the migrations "look fine" — that is the
  state in which it is cheapest to act on a finding, which is the whole point.
- Two questions to answer before they get expensive: who publishes and verifies
  rule sets (Q1), and whether the tenant is a seller or an accounting firm
  holding many sellers (Q2). Q4, Q5, and Q6 gate NX6. All in
  [`risks-and-open-questions.md`](../../specs/epics/nexus/risks-and-open-questions.md).
