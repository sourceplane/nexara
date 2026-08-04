# Implementation Status — nexus

> Trust code reality over this doc. Where this file and the running system
> disagree, the system is the source of truth and this file is the bug.

## Summary

| ID | Status | Notes |
|----|--------|-------|
| NX0 | **Done** | Charter landed; repo + catalog reframed to Nexara; `docs/overview.md` is the front page |
| NX1 | **Done** | Contracts, migrations `200`–`240`, RBAC actions |
| NX1.5 | **Done** | Gate — 12 findings; 8 fixed, 4 accepted in writing ([`schema-review.md`](./schema-review.md)) |
| NX2 | **Done** | Determination engine + boundary, purity, and reproducibility tests |
| NX3 | **Done** | Aggregation, ledger append, tenant-scoping CI scan |
| NX4 | **Done** | `nexus-worker` + edge facade + SDK + CLI |
| NX5 | **Done** | Evaluation cron, determinations, alerts |
| NX6 | **Done** | `channels-worker` + Stripe; Q4/Q5/Q6 resolved in `connector-gate.md` |
| NX7 | **Done** | Shopify adapter |
| NX8 | Not started | Console |
| NX9 | Not started | Entitlements, demo tenant, docs, verification |

## As-built — NX7 (the Shopify adapter)

`apps/channels-worker/src/providers/shopify.ts` against the §6.1 seam, wired
into the registry. 41 new tests.

### The one line that could quietly cost money

Shopify reports amounts as **decimal strings** (`"129.95"`), unlike Stripe's
integer minor units. `toCents` **parses digits rather than multiplying a
float**: `Math.round(Number(x) * 100)` is right for the values you try and
wrong for the ones you do not, and "the ones you do not" is the entire tail of
a seller's order history. A malformed amount returns null and the event is
dropped — zero would be a silent under-count that reads as "a quiet month".

### The fallback order, and the level recorded on every row

`shipping_address` → `billing_address` → the jurisdiction implied by the
order's `tax_lines`. Each level has its own test, and the level that fired is
on the canonical event, because R4 requires a low-confidence attribution to be
**visible** rather than laundered into a fact.

Two sub-cases that are easy to get wrong and are tested: a US address with no
province falls *through* to the next level rather than inventing a state, and
a bare two-letter tax-line code is read as a US state — Shopify emits both
`US-WA` and `WA`, and guessing wrong puts a Washington sale in a country
called WA.

### Marketplace facilitation: either signal, not both

`source_name` naming a known marketplace, **or** a tax line flagged
`channel_liable` — Shopify's own "the sales channel remitted this, not the
merchant", which is what facilitation means. Either alone can be wrong: a
seller can route Amazon orders through a custom app with an unfamiliar
`source_name`, and a marketplace can decline to remit where it has no
obligation. Requiring **both** would under-report facilitation and quietly pull
sales back into a seller's own threshold; accepting **either** over-reports it,
which under a `marketplace_treatment = 'exclude'` rule flags a seller for
review rather than silently clearing them. An unrecognised source defaults to
*the seller's own sale* — the direction that does not silently exclude revenue.

### The acceptance criterion, end to end

"Excluded under `exclude` and included under `include`, from the same ledger,
changing only the rule" is asserted **through the real engine**, not by
checking a boolean. The boolean is not the claim; the claim is that one
seller's ledger produces two different lawful answers depending on the state,
and that the explainer can show both side by side honestly.

## As-built — NX6 (channels-worker and Stripe)

Gated on Q4, Q5, and Q6; all three are answered in
[`connector-gate.md`](./connector-gate.md) before any of this was written.

- `apps/channels-worker` — the provider seam, the registry, the Stripe adapter,
  signed single-use connect state, the credential envelope, the drain
  (cron `* * * * *`), and the staleness module.
- `packages/db/src/channels/` — the second SQL surface, for
  `nexus.channels` writes and `nexus.inbound_deliveries`.
- `apps/api-edge` — `isChannelIngressRoute` matched **before** the
  authenticated facade, and `CHANNELS_WORKER` bound alongside `NEXUS_WORKER`.
- `tests/channels-worker` — 39 tests.

### The gate's three answers, in one line each

- **Q4** — the baseline is the channel's own **median** interval × 6, floored
  at 24h and capped at three weeks. A ten-orders-a-day seller is flagged after
  a silent day; a one-order-a-week seller is not nagged. The median rather than
  the mean because order intervals are heavily skewed and the mean is dominated
  by a Black Friday burst.
- **Q5** — **no** session-scoped Postgres mechanism is safe under Hyperdrive
  pooling, and the one transaction-scoped mechanism that is (`SET LOCAL`) costs
  a transaction wrapper on every read for a guard that only fires after the CI
  scan has already failed. The belt-and-braces Q5 wanted arrived from a
  different direction: NX1.5's composite foreign keys make a cross-tenant
  *write* impossible. Q5 closes; R6 stays as a standing risk.
- **Q6** — payload purged 7 days after `applied`, 30 after terminal `failed`.
  The row is the dedupe **receipt** and the payload is the **PII**, so purging
  nulls the payload and keeps the row; deleting it would let a redelivery after
  the window be re-applied and double-counted.

### The seam, tested rather than asserted

Design §6.3's acceptance criterion — a backfill page overlapping a live
delivery for the same charge produces one ledger row — is driven through the
**real drain** against an in-memory Postgres stand-in that implements
`ON CONFLICT DO NOTHING` honestly, including transaction rollback. Asserting it
about the index alone would test the schema; this tests the pipeline.

### The only new trust path

`POST /v1/channels/:provider/webhook` is matched before the authenticated
facade and dispatched without `resolveActor`. Four properties are enforced in
order and each has a test: the **raw bytes** are verified (re-serialising a
parsed body changes them); an unsigned delivery **never reaches the inbox**;
a duplicate returns 200 and does nothing; and every rejection returns the
**same shape**, because the difference between "bad signature" and "unknown
provider" is an oracle for someone probing which provider a tenant uses.

Three drain queries are necessarily un-scoped and each carries a
`tenancy-exempt: pre-attribution-inbox` marker at its call site — including the
attribution lookup, which was briefly reached for by a cast and is now declared
on the repository interface so the scan sees it and a reviewer can argue with
it.

## As-built — NX5 (evaluation, determinations, alerts)

- `apps/nexus-worker/src/scheduled.ts` — the hourly tick, wired to
  `7 * * * *` (offset from `metering-worker`'s `5 * * * *` so the two do not
  contend for the same Hyperdrive pool). The account's 5-cron limit was lifted
  by the 2026-06-11 Workers Paid upgrade, so unlike `integrations-worker`'s
  drain this trigger is attached, not parked.
- `apps/nexus-worker/src/alerts.ts` — transitions → `nexus.alerts` →
  notification, with the §11 gate.
- `apps/nexus-worker/src/events-client.ts` — `nexus.*` on the platform event
  log.

### `nexus.threshold.crossed` needed no registry entry

`webhooks-worker` fans out **every** event type on the log except its own
lifecycle events, so emitting the event *is* the registration. Adding an
allow-list to register it against would have created a second source of truth
about which events exist — a registry that could disagree with the log is worse
than no registry.

### Ordering that is load-bearing

The alert row is written **before** the notification is enqueued, and the
watermark advances **after** both. If the notification fails, the row still
exists and the alert is not retried into a duplicate email; if the worker dies
between the determination and the alert, next hour re-runs both — which is free,
because `nexus_alerts_once_idx` makes the re-run a no-op. Losing an email is
recoverable; sending a seller five copies of "you have crossed a tax threshold"
is not.

### One recipient gap, recorded rather than hidden

Design §8 says "enqueue the notification" and does not say to whom. There is no
clean answer inside NX5's scope: resolving org members' emails would need
either a second SQL surface on `membership.`/`identity.` tables — the exact
failure the tenancy scan exists to prevent, arriving from the other direction —
or a new cross-context route on two other workers.

The right answer is that a seller names their own tax contact, and the place to
ask is the console, which does not exist until NX8. So NX5 ships the mechanism
with a per-environment `NEXUS_ALERT_EMAIL` var, explicitly labelled a stopgap:
when it is unset the alert row and the outgoing webhook still fire and the row
records `notification_ref = 'no_recipient_configured'`. The gap is **queryable**
rather than something a support ticket discovers. Carried as an NX8 follow-up.

### Verification

- 198 tests in `tests/nexus-worker` (was 171).
- The acceptance criteria are the test names: crossing produces exactly one
  determination, one alert row, one email, and one audit trail; re-running
  immediately produces none of them; an unverified rule set produces an
  internal-only determination and **no** customer-facing alert — while still
  emitting the audit event, because suppressing that would leave a hole in the
  history exactly where a dispute would look.
- Also asserted: `crossed → approaching` does not re-alert (a position
  oscillating around 80% would otherwise mail the seller hourly, and an alert
  that arrives hourly stops being an alert); one org's failure does not stop
  the others; a missing rule set is a state, not an incident.

## As-built — NX4 (worker, edge, SDK, CLI)

The read product end to end, over a ledger that can be seeded. This closes the
demo cut apart from NX8's exposure board.

- `apps/nexus-worker` becomes a real worker: `component.yaml`,
  `wrangler.template.jsonc`, `wiring.fixture.json`, docs, and handlers for
  `list-exposure`, `get-jurisdiction`, `evaluate`, `import-ledger`,
  `list-ledger`, `registrations`, `health`.
- `apps/api-edge/src/nexus-facade.ts`, registered **before** `isOrgRoute`;
  `NEXUS_WORKER` in `env.ts` and both wrangler environments; a `nexus`
  `RouteFamily` and rate-limit entry; `"nexus"` as its own idempotency
  namespace.
- `packages/sdk/src/nexus.ts` — `client.exposure`, `client.ledger`,
  `client.registrations`, with the nexus contract types re-exported.
- `packages/cli/src/commands/nexus.ts` — eight commands, all with
  `--output json` parity.
- `packages/db/src/migrations/250_nexus_synthetic_rule_set/up.sql`.

### Observability is wired here, not at NX9

Design §12 asks for `observability: { enabled: true }` on both new workers, and
NX4 is where it lands rather than NX9 — logging retrofitted after the
connectors exist is logging designed around what already broke. This is the
first worker in the repo to set it; if it proves out it should be lifted to the
rest of the fleet as its own change, not smuggled in through this epic.

### The synthetic rule set, and why a migration seeds it

Nothing in NX0–NX3 could actually be *run*: the engine needs rules, and no
rules existed. `250_nexus_synthetic_rule_set` seeds 51 US jurisdictions plus
two display-only international rows, covering every measurement basis, all
three periods, both marketplace treatments, all five threshold logics, and
every deadline-rule variant — including explicit `threshold_logic = 'none'`
rows for Alaska, Delaware, Montana, New Hampshire, and Oregon.

**It is `verified = false`, and that is the point.** Q1 is open, and design
§11's gate holds: every determination produced from it is written with
`internal_only = true`, no customer-facing alert fires, and the CLI prints a
banner instead of a bare status. The engine, the ledger, the board, and the
evidence trail are all exercisable end to end; what is *not* exercisable is
telling a customer they owe something, which is exactly the claim we have no
basis to make yet.

### Two structural decisions

1. **`src/evaluation.ts` is not a handler.** The `POST /evaluate` handler and
   NX5's cron must run identically — a cron that re-implements a handler is how
   the two drift until a support question can no longer be answered by pressing
   the button. It reads no clock; `asOf` is a parameter, exactly as in the
   engine.
2. **`handlers/gate.ts` is one function, not six copies.** A gate that is
   subtly different in one handler is the bug this whole design exists to make
   impossible, and six copies is six chances.

### One thing the first draft got wrong

`list-exposure` originally reimplemented the meter's max-under-`either` /
min-under-`both` rule locally, with a comment promising the two copies would
agree. That is a promise, and this is a product that sells against promises.
The engine is pure and synchronous, so both handlers now call
`evaluateThreshold` and there is exactly one definition of what the meter
means.

### Verification

- 171 tests in `tests/nexus-worker` (was 144). The new suite drives the real
  membership and policy `Fetcher` stubs rather than stubbing the gate, because
  the thing most worth testing is that a handler cannot forget to run it.
- `pnpm typecheck` 50/50, `pnpm lint` 43/43, `pnpm test` 29/29 packages.
- `wrangler deploy --dry-run` succeeds against the rendered fixture config.

## As-built — NX3 (aggregation and the ledger)

- `packages/db/src/nexus/{types,repository,index}.ts` — the single SQL surface
  for the `nexus` schema, `Result`-typed, org-scoped, keyset-paginated,
  closures over an injected `SqlExecutor`. Package `exports` entry added.
- `tests/db/src/tenancy-scan.test.ts` — the isolation control.
- `tests/db/src/nexus-repository.test.ts` — 30 tests over three layers.

**No contract dependency.** `@saas/db` has never imported `@saas/contracts` and
still does not: the column unions are declared locally, mirroring the Postgres
CHECK constraints, and the mapping to wire shapes lives in the worker's
`mappers.ts` where a divergence is visible. The `inputs` and
`registration_deadline_rule` JSONB columns are typed opaque here — a db-layer
definition of the reproducibility payload would be a second definition that
could drift from the one the engine actually replays.

### The two NX1.5 requirements, discharged

**S-11 — the scan verifies the claim, not just the queries.** Scanning the
repository verifies the queries it finds; it does not verify that they are all
of them. The scan now also walks `apps/` and `packages/` and fails any
`nexus.`/`channels.` SQL found outside `packages/db/src/{nexus,channels}`,
which converts "one repository module is the only SQL surface" from a
convention into a test.

**S-8 — an amended re-delivery is no longer a silent no-op.** `appendSaleEvents`
returns `divergent[]` alongside `applied`/`duplicates`: on a conflict it reads
the stored rows back and reports any whose monetary values differ from what was
submitted. One extra query, and only when something conflicted — on the
steady-state path, never.

### Exemptions are declared at the call site, not granted by table name

The design proposed exempting `nexus.rule_sets` and `nexus.rules` by name.
NX1.5 finding S-9 narrowed that: a query may skip `org_id = $` only with a
`tenancy-exempt: <reason>` marker within sixteen lines above it, and only for
one of three reasons — `global-reference-data`, `cross-tenant-sweep`,
`pre-attribution-inbox`. Exempting by table name would have disarmed the scan
for every *future* read of those tables. Two further assertions stop the
markers from being load-bearing in the wrong direction: a
`global-reference-data` marker cannot cover a query that also touches a tenant
table, and a `cross-tenant-sweep` may select org ids and timestamps but not
money, jurisdictions, or payloads.

### One finding the scan produced on its first run

`listSaleEventsPaged` and `listDeterminationsPaged` built their `WHERE` from a
`clauses` array whose first element was `"org_id = $1"`. The scan flagged both,
and it was right to: a tenant predicate assembled into a join is one refactor
away from not being there, and neither a reader nor the scan can see it. Both
now read `WHERE org_id = $1${andAll(clauses)}` — the predicate is structural,
the array holds only optional filters.

### Verification

- 664 tests in `tests/db` (was 634).
- **Mutation-checked.** Three deliberate isolation bypasses each turned the
  scan red: dropping `org_id` from a read, inventing an exemption reason, and
  putting a `nexus.` query in `apps/nexus-worker/src/`.
- The repository tests assert in three layers: query *shape* (half-open bounds,
  the `FILTER` split, the `ON CONFLICT` target, `DISTINCT ON`, `GREATEST`),
  *mapping* (`BIGINT`-as-string, the safe-integer guard, `DATE` without a
  timezone shift), and *behaviour* over a seeded ledger with a refund in it,
  against hand-computed fixtures for all three window types.

## As-built — NX2 (the determination engine)

The pure core, landed before any I/O exists. `apps/nexus-worker` is created
here as a plain workspace package — **no `component.yaml` and no wrangler
template yet**, because it is not a worker until NX4 gives it a `fetch`
handler, and declaring a Cloudflare component that cannot deploy would put a
permanently red lane in the convergence.

- `apps/nexus-worker/src/engine/` — `dates.ts` (civil-date arithmetic),
  `zones.ts` (the *only* instant ⇄ jurisdiction-date conversion in the
  codebase), `periods.ts`, `measure.ts`, `threshold.ts`, `deadline.ts`, and the
  barrel exporting `ENGINE_VERSION = "1.0.0"`, `evaluate`, and
  `evaluateSegmented`.
- `tests/nexus-worker/` — a new verify-only component. 144 tests across six
  suites.

### The eight §5.3 boundaries, each with a named test

| # | Boundary | Where |
|---|----------|-------|
| 1 | Half-open rolling window, never `BETWEEN` | `engine-periods.test.ts` |
| 2 | The previous-calendar-year discontinuity across New Year | `engine-periods.test.ts` |
| 3 | A mid-window rule change splits the window | `engine-boundaries.test.ts` |
| 4 | UTC storage vs the jurisdiction's date (31 Dec 23:00 PST) | `engine-periods.test.ts` |
| 5 | A refund landing in a later period than its sale | `engine-boundaries.test.ts` |
| 6 | `threshold_logic='both'` with only sales crossing | `engine-threshold.test.ts` |
| 7 | Marketplace treatment flipping the outcome on one ledger | `engine-threshold.test.ts` |
| 8 | `threshold_logic='none'` terminal on a ledger with real sales | `engine-threshold.test.ts` |

### Three decisions the design left open

1. **The rolling window is `[D − 12 months + 1 day, D + 1 day)`** in the
   jurisdiction's calendar — exactly twelve months of days, ending today
   *inclusive*. `[D − 12 months, D)` excludes today, and a product whose
   promise is "says so on the day it is crossed" cannot measure a window that
   ends yesterday.
2. **The comparator is `>=`** ("meets or exceeds"). Statutes split between
   "exceeds" and "or more" and the schema carries no per-rule comparator; `>=`
   is the conservative direction for a monitoring product. Pinned by
   `ENGINE_VERSION`; making it per-rule data is a named follow-on rather than a
   silent edit.
3. **`fractionOfThreshold` reports whichever threshold binds** — the max under
   `either` (you cross as soon as one does), the min under `both` (you cross
   only when both do). Reporting the max under `both` would show a meter at
   250% next to a status of `clear`, which reads as a product bug rather than
   as the rule doing its job.

### Verification

- 144 tests pass. `engine-purity.test.ts` reads the engine sources and fails
  any non-type import, any `@saas/db`/`fetch`/`Env`/`process.env` reference,
  any `Date.now()`/`new Date()`/`Math.random()`, and any `async`/`await`/
  `Promise` — turning design §4's purity conventions from a claim into a
  control.
- `reproducibility.test.ts` carries four frozen vectors shaped like stored
  `nexus.determinations` rows (crossed, approaching, no_obligation, and a
  year-boundary case where `crossedOn` differs from `asOf`'s UTC date). Each
  asserts `status`, `crossedOn`, `registrationDueOn`, and the measured values
  re-derive identically, that repeated evaluation is byte-identical, and that
  the engine does not mutate the `inputs` object it will write to the row.
- **Mutation-checked.** Three deliberate mutations — `>=` → `>`, dropping the
  rolling window's `+1 day`, and ignoring `marketplace_treatment: exclude` —
  each killed four tests. The suite is not vacuous.

## As-built — NX1.5 (the schema and isolation review gate)

`specs/epics/nexus/schema-review.md` — 12 findings, each with a severity and a
disposition. Seven changed the migrations and one changed the contracts; four
are accepted in writing with the reason stated.

The gate ran **before** the NX1 migrations were applied anywhere: CI's
`db-migrate` job on the NX1 PR runs `mode=plan`, so acting on a finding cost a
checksum bump rather than a migration plus a backfill plus a rewritten
determination history. That sequencing is the entire point of the milestone
carrying a `.5`.

**What the review changed.** The largest result is that design §7.3's tradeoff
— "RLS is defence-in-depth against a repository bug; query scoping has none" —
is now too pessimistic for the **write path**. Three composite foreign keys
(`sale_events.reverses_event_id`, `sale_events.channel_id`,
`alerts.determination_id`, each scoped `(org_id, …)`) mean a handler with
broken org scoping can no longer write a row that references another tenant.
That costs two unique indexes and no runtime. Reads remain exactly as exposed
as the doc says, which is finding S-11 and stays open against Q5.

Three findings were latent bugs rather than hardening:

- **S-3** — `inbound_deliveries.payload` was `NOT NULL`, which made Q6's
  retention policy unimplementable: purging the PII would have required
  deleting the row, and the row is the dedupe receipt, so a provider
  redelivering after the purge window would have been re-applied and
  double-counted. The column is now nullable with paired CHECK constraints.
- **S-4** — two rules for the same jurisdiction could be in force on the same
  day (the unique index stopped two rules *starting* together, which is not the
  failure that happens). An `EXCLUDE USING gist` over `daterange` now makes a
  rule set partition time. This adds `btree_gist` — the only extension this
  context requires.
- **S-5** — `rules.rule_set_id` cascaded on delete, which would have destroyed
  the rules that determinations cite. Now `RESTRICT`.

**What it accepted.** S-8 is the sharpest finding and cannot be fixed in the
schema: a provider re-sending the same event id with *different amounts* is
silently dropped by `ON CONFLICT DO NOTHING`, and an append-only ledger has no
correction path. Accepted, with two named behavioural requirements on NX3 and
NX6 and a new register entry, **R9**.

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
