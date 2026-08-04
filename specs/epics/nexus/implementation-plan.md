# nexus — Implementation Plan (NX0–NX9)

Recommended order is the numbering, with two deliberate properties:

- **NX2 (the engine) lands before any I/O exists.** It is pure, it is the
  product's only real IP, and it is the artefact a reviewer reads first.
- **The connectors (NX6, NX7) are last of the backend work on purpose.** They
  are the largest and the least defensible to rush. If the calendar slips, they
  slip; the engine and its tests do not.

NX1–NX4 plus the exposure board from NX8 constitute the **demo cut** (see the
epic README § Delivery cut lines).

---

## NX0 — Product identity — Draft

The repo still describes itself as a reusable SaaS starter, in `README.md`, in
`intent.yaml`'s `metadata.description`, and in the catalog front page that Orun
renders from them. Nexara is a product now, and the workspace should say so
before a customer or a prospect is shown it.

- **Repo.** Rewrite `README.md`'s opening and Status sections in product terms
  (what Nexara does, for whom), keeping the platform paragraph as *how it is
  built* rather than *what it is*.
- **Intent.** `metadata.description`, `repo.displayName`, `repo.description`,
  `repo.tags`, and `repo.links`.
- **Catalog.** Author `docs/overview.md` as the workspace front page and point
  `repo.docs.overview` at it; keep `ai/context/{operations,deployment}.md` as
  the role-tagged pages.
- **Specs.** This epic doc set plus `specs/README.md` and
  `specs/epics/README.md`.

Acceptance: the Orun workspace front page describes Nexara, not a starter; a
reader who lands on the repo cold can say what the product does within one
screen; `orun plan` resolves the catalog with the new repo entity and no
validation error.

## NX1 — Contracts and schema — Ready

The written shape of both bounded contexts, before any behaviour.

- **Contracts.** `packages/contracts/src/nexus.ts` and `.../channels.ts` — plain
  TypeScript types plus `as const` arrays, `PublicX` wire shapes with
  `CreateXRequest`/`XResponse` pairs, ids as public strings, dates as ISO
  strings. **No zod**; validation is hand-rolled in the worker, per the platform
  convention. Both added to the package's `exports` map. Public id prefixes:
  `chn_`, `sev_`, `det_`, `reg_`, `dlv_`.
- **DB.** Migrations `200_nexus_core`, `210_nexus_ingestion`, `220_nexus_rules`,
  `230_nexus_determinations`, `240_nexus_registrations` (design §3), each with a
  `packages/db/src/manifest.ts` entry carrying its sha256.
- **Policy.** The nine actions of design §7.2 registered in
  `@saas/policy-engine` — per-role arrays **and** the flat validation `Set` —
  with the effective-permission snapshots updated.

Acceptance: `db-migrate` plans clean on a PR and applies clean on merge; the
manifest checksums match; a `viewer` resolves exactly the four read actions and
a `builder` resolves seven; `pnpm typecheck` clean across
`contracts`/`policy-engine`/`db`.

## NX2 — Determination engine — Ready

The pure core. No database, no `Env`, no `fetch`, no `Date.now()` — `asOf` is
always a parameter.

- **Engine.** `apps/nexus-worker/src/engine/{periods,measure,threshold,deadline}.ts`
  plus a barrel exporting `ENGINE_VERSION`.
- **Tests.** `tests/nexus-worker/src/engine-*.test.ts`, table-driven, with **one
  case per boundary in design §5.3** — half-open rolling windows, the
  previous-calendar-year discontinuity, a mid-window rule change, the UTC vs
  jurisdiction-date year boundary, a refund landing in a later period than its
  sale, `threshold_logic='both'` with only sales crossing, and marketplace
  treatment flipping the outcome.
- **Reproducibility.** `reproducibility.test.ts` re-runs the pinned
  `ENGINE_VERSION` against a stored `inputs` payload and its rule, asserting
  `status`, `crossed_on`, and `registration_due_on` return byte-identical.

Acceptance: every §5.3 boundary has a named failing-then-passing test; the
engine directory imports nothing but types from `@saas/contracts`; the
reproducibility test passes and is wired into the quality lane. A change that
breaks it requires an `ENGINE_VERSION` bump, not a patched expectation.

## NX3 — Aggregation and ledger — Ready

- **Repository.** `packages/db/src/nexus/{types.ts,repository.ts,index.ts}` —
  `Result`-typed (`{ ok: true; value } | { ok: false; error }`), org-scoped,
  keyset-paginated, closures over an injected `SqlExecutor`, connection opened
  and disposed by the handler. Package `exports` entry added.
- **Aggregate.** The single-scan query of design §5.1, and the group-by-window
  dispatch of §5.2 — one query per distinct window, never per jurisdiction.
- **Append.** `appendSaleEvents(...)` writing `INSERT … ON CONFLICT DO NOTHING
  RETURNING *`; an empty return is success, meaning "already applied".
- **The CI scan.** A test that reads the repository sources and fails any
  `nexus.`/`channels.` query lacking `org_id = $`, with `nexus.rule_sets` and
  `nexus.rules` exempt by explicit name.

Acceptance: aggregating a seeded ledger returns the same numbers as a
hand-computed fixture for all three window types; a duplicate append is a no-op
and reports as such; refunds reduce the correct window; the CI scan fails when a
deliberately unscoped query is introduced, and passes on `main`.

## NX4 — nexus-worker, edge, SDK, CLI — Ready

The read product, end to end, over a ledger that can be seeded.

- **Worker.** `apps/nexus-worker` with the standard anatomy and handlers:
  `list-exposure`, `get-jurisdiction`, `evaluate`, `import-ledger`,
  `list-ledger`, `health`. Bindings `PLATFORM_DB`, `MEMBERSHIP_WORKER`,
  `POLICY_WORKER`.
- **Edge.** `apps/api-edge/src/nexus-facade.ts` registered in the dispatch chain
  **before** `isOrgRoute`; `NEXUS_WORKER` in `env.ts` and the wrangler template
  (stage + prod); a `nexus` `RouteFamily` and rate-limit entry; `"nexus"` as the
  idempotency namespace.
- **SDK.** `packages/sdk/src/nexus.ts` — `ExposureClient`, `LedgerClient`,
  `RegistrationsClient` — registered on the client as `client.exposure`,
  `client.ledger`, `client.registrations`, with contract types re-exported.
- **CLI.** `packages/cli/src/commands/nexus.ts` registered in `cli-runner.ts`:
  `nexus exposure`, `nexus jurisdiction show <code>`, `nexus evaluate --now`,
  `ledger import --file`, `ledger list`, `registration list` — all with
  `--output json` parity.

Acceptance: a `builder` can import a ledger and read the exposure board; a
`viewer` reads but cannot import (deny-as-404); an unknown jurisdiction code is
a 404 and a malformed import is a wholesale 422 with no partial writes; the
whole flow is walkable on stage from the CLI.

## NX5 — Evaluation, determinations, alerts — Ready

- **Cron.** `scheduled` on `nexus-worker` at `7 * * * *` implementing design §8:
  activity watermark → group by window → engine → conditional determination
  insert.
- **Change detection.** A determination row is written **only** when status or
  measured value changed. Verified by a test that runs two consecutive
  evaluations over an unchanged ledger and asserts one row, not two.
- **Alerts.** `nexus.alerts` insert gated by its unique index, then
  `enqueueNotification` with a scoped idempotency key.
- **Audit + webhooks.** `nexus.*` events emitted to `events-worker`;
  `nexus.threshold.crossed` registered as a subscribable outgoing webhook type.

Acceptance: crossing a threshold produces exactly one determination, one alert
row, one email, and one audit entry — and re-running the cron immediately
produces none of them; an unverified rule set produces an internal-only
determination and **no** customer-facing alert (design §11).

## NX6 — channels-worker and Stripe — Ready

- **Worker.** `apps/channels-worker` mirroring the shipped integrations anatomy:
  `state.ts` (signed single-use connect state), `encryption.ts` (credential
  envelope), `drain.ts` (cron `* * * * *`, batch 50, `MAX_ATTEMPTS = 5`, backoff
  1m/2m/4m/8m/16m), `providers/{types,registry,stripe}.ts`, handlers
  `connections`, `ingest`, `backfill`, `deliveries`, `health`.
- **Ingress.** `POST /v1/channels/:provider/webhook` routed **before** the
  authenticated facade — provider webhooks carry a signature, not a session, and
  `verifyInboundSignature` is the gate. This is the only new trust path in the
  epic and it gets its own review.
- **Sequencing.** Design §6.3 implemented in order: channel row →
  `backfill_started_at` → webhook registration → live capture → backwards
  backfill to `lookback_floor` → `backfill_completed_at`.

Acceptance: connecting a Stripe test account backfills 24 months and captures
live events with zero duplicates and zero gaps across the seam, proven by a test
that replays an overlapping backfill page and a live delivery for the same
charge; an unsigned or wrongly-signed delivery is rejected and never reaches the
inbox; a provider outage retries and then terminates at `failed` without
blocking other deliveries.

## NX7 — Shopify adapter — Ready

- **Adapter.** `providers/shopify.ts` against the §6.1 seam.
- **Ship-to jurisdiction.** `shipping_address` → `billing_address` → the
  jurisdiction implied by the order's `tax_lines`, with the fallback that fired
  recorded on the canonical event.
- **Marketplace facilitation.** `order.source_name` plus a facilitator-remitted
  tax line.

Acceptance: fixture orders resolve to the correct jurisdiction through each
fallback level, and the level used is visible in the ledger row; a
facilitator-remitted order is flagged and is excluded under a rule with
`marketplace_treatment = 'exclude'` and included under `'include'` — from the
same ledger, changing only the rule.

## NX8 — Console — Ready

- **Pages** under `apps/web-console-next/src/app/(app)/orgs/[orgSlug]/`:
  `exposure` (the board — one card per jurisdiction with a threshold meter),
  `jurisdictions/[code]` (rule in force, measured vs threshold, determination
  history, and the explainer), `ledger` (append-only, filterable, refunds shown
  as reversals linked to their original), `channels` (connect, backfill
  progress), `registrations` (status and deadlines).
- **Components** in `src/components/nexus/`: `exposure-card`,
  `threshold-meter`, `determination-explainer`, `channel-connect-card`.
- **Storefront.** A public `src/app/nexara/` route group — marketing and
  self-serve signup.
- **Wiring.** `qk.exposure` / `qk.jurisdiction` / `qk.channels` query keys,
  sidebar nav entries, Cmd-K palette entries.

**Build `determination-explainer` first.** It renders the rule version in force,
the window dates, measured against threshold, which basis and marketplace
treatment applied, and the raw `inputs` behind a disclosure. It is the visual
proof of invariant 3 and the single screen worth showing anyone.

Acceptance: an authenticated user completes connect → backfill → exposure →
jurisdiction detail → registration entirely in the console; the explainer's
numbers reconcile exactly with the stored determination; an unverified rule set
renders the §11 banner instead of a status. Verified live with an authenticated
browser walkthrough and screenshots.

## NX9 — Commercial and evidence — Ready

- **Entitlements.** The metered dimensions and plans of design §9, wired through
  `metering-worker` and `billing-worker`, with quota denial surfacing as a
  console upgrade prompt rather than an error.
- **Demo tenant.** A seeded 18-month, six-jurisdiction ledger: Texas crossed
  with a registration deadline; Washington `approaching` at ~87%; enough
  marketplace-facilitated Washington orders that the outcome flips between
  `include` and `exclude` (the explainer shows both); California, New York,
  Florida, Illinois `clear` at varying fill; one large refund reversing a Q4
  sale, visible as a second row linked to the original.
- **Docs and catalog.** Re-run the docs flow; author
  `docs/{overview,architecture,runbook}.md`; enrich `catalog.entities` in
  `intent.yaml` with the `nexus` and `channels` domains and systems; per-
  component `overview.md` + `runbook.md`.
- **Verification.** Stage walkthrough via CLI, then prod smoke after promotion;
  deployment manifest regenerated from verified live state.

Acceptance: a new tenant on the Starter plan is blocked at the 11th jurisdiction
with an upgrade prompt, not a 500; the demo tenant's board tells the whole story
without a narrator; the workspace Docs hub renders the product's own docs; the
live deployment manifest carries no `TBD` placeholders.
