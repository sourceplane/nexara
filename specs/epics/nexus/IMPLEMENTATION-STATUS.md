# Implementation Status — nexus

> Trust code reality over this doc. Where this file and the running system
> disagree, the system is the source of truth and this file is the bug.

## Summary

| ID | Status | Notes |
|----|--------|-------|
| NX0 | **Done** | Charter landed; repo + catalog reframed to Nexara; `docs/overview.md` is the front page |
| NX1 | Not started | Contracts, migrations `200`–`240`, RBAC actions |
| NX1.5 | Not started | Gate — adversarial schema + isolation review, `schema-review.md` |
| NX2 | Not started | Determination engine + boundary and reproducibility tests |
| NX3 | Not started | Aggregation, ledger append, tenant-scoping CI scan |
| NX4 | Not started | `nexus-worker` + edge facade + SDK + CLI |
| NX5 | Not started | Evaluation cron, determinations, alerts |
| NX6 | Not started | `channels-worker` + Stripe |
| NX7 | Not started | Shopify adapter |
| NX8 | Not started | Console |
| NX9 | Not started | Entitlements, demo tenant, docs, verification |

## As-built — NX0 (product identity)

Documentation and catalog metadata only. No component, no schema, no code.

- `docs/overview.md` — new. The workspace front page: what Nexara does, the
  three invariants and why each is load-bearing, the scope boundary, how it is
  built, and the `verified` gate. Written for a customer or a prospect, which
  is a different reader from `README.md`'s.
- `README.md` — opening rewritten in product terms; the platform paragraph
  demoted to *how it is built*; a Status bullet added for the epic and a second
  one stating plainly that no environment runs a verified rule set; the two
  product workers added to the workspace layout.
- `intent.yaml` — `metadata.description` reframed; the `repo` entity gains
  `description`, `tags`, and `links`; `repo.docs.overview` now points at
  `docs/overview.md` rather than `README.md`, and `design.md` joins the
  role-tagged pages as the architecture doc.

**Decision recorded here because it is not obvious from the diff:** the catalog
front page and the repo README are deliberately *different documents*. Orun
renders `repo.docs.overview` to the workspace Docs library, where the reader is
someone evaluating the product; `README.md`'s reader is someone about to build
it. Pointing both at one file is what let the workspace describe a starter for
as long as it did.

## As-built (introducing PR)

**Documentation only. No code, no schema, no components.** The PR opens the
epic *and* takes it to `Ready`: the charter was reviewed against the demand
side of this market before implementation was authorised, and the readiness
pass added the NX1.5 review gate, the explicit no-obligation rule record, a
read-only support surface, an observability section, and a named commercial
date. See the PR body for the full delta.

- `specs/README.md` — the spec tree's index, status legend, and conventions.
  `specs/` did not previously exist in this repo; the product-only bootstrap
  ships no baseline specs, so this is the first entry.
- `specs/epics/README.md` — the epic register.
- `specs/epics/nexus/{README,design,implementation-plan,risks-and-open-questions}.md`
  and this file.
- `ai/context/current.md` — the "Next" section replaced with the active epic
  state, as that file's own instructions direct.

Deliberately **not** in this PR, so that the charter can be reviewed on its own
merits: the `README.md` and `intent.yaml` product reframing (that is NX0's
substance, and it changes the catalog front page), any `component.yaml`, any
migration, and any change to `packages/*`.

## Verification record

- No components changed, so `orun plan --changed` resolves an empty component
  set for this PR; CI validates the intent and the catalog unchanged.
- No `pnpm` surface touched.

## Open follow-ups

- Resolve Q1 (rule-set ownership) before any environment runs a
  `verified = true` rule set — see `risks-and-open-questions.md`.
- Resolve Q2 (tenant shape: seller vs accounting firm) before NX9 plan
  modelling; it is cheap now and expensive after billing is wired.
- Spike Q5 (Postgres-side isolation under Hyperdrive pooling) before NX6.
- Author `schema-review.md` at NX1.5 — the file does not exist yet and is the
  gate's only artefact. NX3 does not open without it.
- Resolve Q4 (channel staleness baseline) and Q6 (delivery-payload retention)
  before NX6; with Q5 they are the three questions that gate the connectors.
- NX0's repo/catalog reframing, as its own PR.
