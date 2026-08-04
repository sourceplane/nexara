# Implementation Status — nexus

> Trust code reality over this doc. Where this file and the running system
> disagree, the system is the source of truth and this file is the bug.

## Summary

| ID | Status | Notes |
|----|--------|-------|
| NX0 | Charter landed; repo/catalog framing not started | This PR lands the spec set only |
| NX1 | Not started | Contracts, migrations `200`–`240`, RBAC actions |
| NX2 | Not started | Determination engine + boundary and reproducibility tests |
| NX3 | Not started | Aggregation, ledger append, tenant-scoping CI scan |
| NX4 | Not started | `nexus-worker` + edge facade + SDK + CLI |
| NX5 | Not started | Evaluation cron, determinations, alerts |
| NX6 | Not started | `channels-worker` + Stripe |
| NX7 | Not started | Shopify adapter |
| NX8 | Not started | Console |
| NX9 | Not started | Entitlements, demo tenant, docs, verification |

## As-built (introducing PR)

**Documentation only. No code, no schema, no components.**

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
- NX0's repo/catalog reframing, as its own PR.
