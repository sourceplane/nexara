# Epics

Status: Normative index

Orun-style work programs for nexara. Each epic is a folder carrying a canonical
doc set: `README.md` (status table + thesis + read order + milestones at a
glance), `design.md`, `implementation-plan.md` (milestones with "done when"),
`IMPLEMENTATION-STATUS.md` (as-built), plus `risks-and-open-questions.md` /
`test-plan.md` where they carry weight.

## The epics

| Epic | Cluster | Status | Owner(s) | What it is |
|------|---------|--------|----------|------------|
| [`nexus/`](./nexus/) | **NX** | Draft (charter only — no code) | new `nexus-worker` + `channels-worker`, `api-edge` facade, `packages/{contracts,policy-engine,db,sdk,cli}`, `web-console-next` | The product: economic-nexus threshold monitoring for ecommerce sellers. An append-only sale-event ledger fed by connected sales channels, aggregated per jurisdiction, evaluated against versioned rule data by a pure engine, and recorded as immutable, reproducible determinations that alert a merchant before a state finds them. |

## Lifecycle

- Status legend: see [`../README.md`](../README.md) § Status legend.
- A parked program lives as a single README; when a leg is picked up it is
  promoted to the full doc set.
- A tightly-coupled child program lives under its parent in
  `<slug>/sub-epics/<child-slug>/` with the same doc set, surfaced from the
  parent's milestone table rather than as a top-level register row.
