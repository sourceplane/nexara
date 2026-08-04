# Implementation Status — nexus

> Trust code reality over this doc. Where this file and the running system
> disagree, the system is the source of truth and this file is the bug.

## Summary

| ID | Status | Notes |
|----|--------|-------|
| NX0 | **Done** | Charter landed; repo + catalog reframed to Nexara; `docs/overview.md` is the front page |
| NX1 | **Done** | Contracts, migrations `200`–`240`, RBAC actions |
| NX1.5 | Not started | Gate — adversarial schema + isolation review, `schema-review.md` |
| NX2 | Not started | Determination engine + boundary and reproducibility tests |
| NX3 | Not started | Aggregation, ledger append, tenant-scoping CI scan |
| NX4 | Not started | `nexus-worker` + edge facade + SDK + CLI |
| NX5 | Not started | Evaluation cron, determinations, alerts |
| NX6 | Not started | `channels-worker` + Stripe |
| NX7 | Not started | Shopify adapter |
| NX8 | Not started | Console |
| NX9 | Not started | Entitlements, demo tenant, docs, verification |

## As-built — NX1 (contracts and schema)

The written shape of both bounded contexts, before any behaviour.

- `packages/contracts/src/nexus.ts`, `.../channels.ts` — plain TypeScript,
  `as const` enumerations mirroring the CHECK constraints one-for-one, no zod.
  Both added to the package `exports` map and the barrel.
- `packages/db/src/migrations/{200_nexus_core,210_nexus_ingestion,220_nexus_rules,230_nexus_determinations,240_nexus_registrations}/up.sql`
  plus their `manifest.ts` entries with sha256 checksums.
- `packages/db/src/types.ts` — `nexus` and `channels` registered as bounded
  contexts.
- `packages/policy-engine/src/index.ts` — the nine actions of design §7.2, in
  the per-role arrays **and** in the flat validation `Set`.

### Deviations from design §3, and why

Each of these is a place where the design doc as literally written could not
produce the behaviour the same doc requires elsewhere. They are listed here
rather than buried in the diff, and NX1.5 reviews them adversarially along
with everything else.

| # | Change | Why |
|---|--------|-----|
| 1 | `determinations.status` gains `'no_obligation'` | §3.4's CHECK list omits it, but §3.3, §5.3 case 8, and NX8's acceptance criteria all require `threshold_logic='none'` to return a terminal no-obligation that is *not* `clear`. The CHECK as written made the required behaviour unrepresentable. |
| 2 | `rules.measurement_timezone TEXT NOT NULL DEFAULT 'UTC'` | §5.3 case 4 requires the measurement date to be the jurisdiction's date, not UTC. With no timezone anywhere in the schema that is not implementable. It belongs on the rule because it is per-jurisdiction reference data with an effective date, exactly like every other column there. |
| 3 | `sale_events.jurisdiction_source` | §6.2 and R4 both require the fallback level that fired to be recorded on the ledger row and surfaced in the explainer. §3.2's column list has no home for it. |
| 4 | `nexus.evaluation_watermarks` | §8 step 1 says "orgs with ledger activity since the last evaluation watermark". No table held a watermark. Keyed on `ingested_at` rather than `occurred_at`, because a backfilled 2024 sale ingested today is unseen work. |
| 5 | `determinations.internal_only` | §11's gate has to be readable from the determination alone. A join to `rule_sets.verified` reads the flag as it stands *today*, which is the wrong answer once a set is later verified. |
| 6 | Sign, logic, and range CHECK constraints | A refund with positive cents inflates the measurement it is meant to reduce, and `SUM` is sign-blind by design, so nothing downstream would notice. Likewise a `sales_only` rule with a null threshold renders as 0% rather than erroring. Both are "confidently wrong output", which is the one thing this product cannot ship. |
| 7 | `channels.last_event_at`, `inbound_deliveries.purged_at` | R3's staleness check and Q6's retention sweep each need a column to hang off. Adding them now is free; adding them after the connectors write rows is a migration plus a backfill. |
| 8 | Public id prefixes `rst_` / `rul_` | The epic README fixes `chn_`, `sev_`, `det_`, `reg_`, `dlv_` but rule and rule-set ids also cross the boundary — `PublicDetermination.ruleId` is part of the reproducibility triple. |

### Verification

- `pnpm typecheck` — 48/48 clean.
- `pnpm lint` — 41/41 clean. (`packages/db/src/runner/cli.ts` carried a
  pre-existing unused-arg error that would have failed this milestone's lane;
  fixed in place rather than worked around.)
- `tests/db` — 611 pass, including a new `nexus-migration.test.ts` that pins
  each invariant at the schema level and enumerates every created table so a
  new one cannot slip past the tenancy assertions.
- `tests/policy-engine` — 223 pass, including a new `nexus-policy.test.ts`
  transcribing design §7.2's matrix cell by cell.
- `tests/contracts` — 138 pass, including a new `nexus.test.ts` pinning every
  enumeration against its CHECK constraint.

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
