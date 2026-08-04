# nexus — Design

Status: Ready for implementation. This is the technical design for the `nexus`
and `channels` product bounded contexts.

## 1. The shape of the problem

A US state can require an out-of-state seller to register and collect sales tax
once that seller's activity in the state crosses an **economic nexus
threshold**. Forty-eight jurisdictions enforce one. They disagree on almost
everything about it:

| They disagree on | Examples |
|---|---|
| The amount | $100,000 in most; $500,000 in California, Texas, New York |
| What is measured | *gross* sales, *retail* sales, or *taxable* sales |
| Whether transaction count also counts | some states dropped the 200-transaction test, some kept it |
| How the two combine | sales **or** transactions; sales **and** transactions; sales only |
| The window | rolling twelve months; the current calendar year; the *previous* calendar year |
| Marketplace sales | some count Amazon/Etsy sales toward your threshold, some exclude them |
| The deadline once crossed | next month; next quarter; 30/60 days; the first of the following month |

A seller cannot hold that in their head, and a spreadsheet cannot hold it
either, because the answer changes every time an order lands. The product is a
watcher: ingest every sale, keep a per-jurisdiction running measurement in the
right window on the right basis, compare it to the rule in force *on that date*,
and say something before the state does.

Three properties make this different from a dashboard:

- **It is evidence.** When a state sends a notice, the seller's defence is the
  determination record. It must be reproducible, not just plausible.
- **It is append-only.** Any product that mutates a financial ledger loses the
  argument by construction.
- **It is versioned.** Rules change with effective dates. A determination made
  under the 2026.08 rule set must stay evaluable under the 2026.08 rule set
  forever, even after 2027.01 lands.

The platform already owns tenancy, RBAC, an append-only event log, metering,
billing, notifications, signed webhooks, and an audited admin surface. This epic
adds the two things it does not have: a context that understands a sale crossing
a border, and a context that gets sales out of Stripe and Shopify without losing
or double-counting one.

## 2. Bounded contexts

Two new Cloudflare Workers, each owning one Postgres schema.

| Context | Worker | Owns | Cron |
|---|---|---|---|
| `channels` | `apps/channels-worker` | connections, OAuth connect state, the inbound-delivery inbox, backfill cursors, and the drain that normalises provider payloads into canonical sale events | `* * * * *` |
| `nexus` | `apps/nexus-worker` | the sale-event ledger, per-jurisdiction aggregation, rule sets, the determination engine, determinations, registrations, alerts | `7 * * * *` |

Both mirror the shipped worker anatomy exactly — `index.ts → router.ts →
handlers/* → @saas/db/<context> → Hyperdrive`, with `env.ts`, `http.ts`,
`ids.ts`, `pagination.ts`, `mappers.ts`, and thin `membership-client` /
`policy-client` facades over service bindings. Nothing about the shape is novel
to a reviewer who has read `projects-worker`.

**Why two workers and not one.** Ingestion and evaluation have different failure
modes, different rate profiles, and different cron cadences. Splitting them
means a Shopify outage cannot delay a threshold evaluation, and a slow
evaluation cannot back up webhook receipt. It mirrors the platform's own split
(`integrations-worker` ingests, `metering-worker` rolls up), and it keeps the
NX6/NX7 connector work off the critical path of NX2–NX5.

**Why not extend `integrations-worker`.** Its provider seam
(`src/providers/types.ts`) is shaped for GitHub Apps — a numeric
`installationId`, App-JWT minting, `completeConnect(installationId)`. Stripe
Connect and Shopify are OAuth token flows over a different lifecycle. Forcing
them through that interface costs more than it saves. What `channels-worker`
*does* reuse is the machinery that carries the risk: the inbox drain
(`src/drain.ts` — cron + table + bounded retries, no Queues), signed single-use
connect state (`src/state.ts`), the credential envelope (`src/encryption.ts`),
and the registry pattern. We copy the discipline, not the interface.

`nexus-worker` consumes `membership-worker` (authorization context),
`policy-worker` (RBAC decision), `notifications-worker` (threshold alerts), and
`events-worker` (audit). `channels-worker` consumes `membership-worker` and
`policy-worker`. Neither takes a `billing-worker` binding; entitlement gating
lands in NX9 through the metering path.

The one piece of real domain IP is the **determination engine** — a pure,
dependency-free, exhaustively unit-tested module under
`apps/nexus-worker/src/engine/`. It is isolated from all I/O for the same reason
the draft engine was in the reference product: it is the part that must be
readable and provable on its own.

## 3. Data model

Migrations claim the `200` decade block (the platform's contexts end at
`190_integrations_delivery_attribution`). Each is a single `up.sql`, no
`down.sql`, `IF NOT EXISTS` throughout, and each appends an entry to
`packages/db/src/manifest.ts` (`id`, `context`, `path`, sha256 `checksum`,
`description`) — the runner refuses an unlisted or drifted file.

```
200_nexus_core             channels + the sale-event ledger
210_nexus_ingestion        the inbound-delivery inbox
220_nexus_rules            rule sets + rules (global, NOT tenant-scoped)
230_nexus_determinations   the immutable determination record
240_nexus_registrations    registrations + the alert log
```

### 3.1 `nexus.channels` — a connected sales channel

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | surfaced as `chn_<hex>` |
| `org_id` | `UUID NOT NULL` | tenant key |
| `provider` | `TEXT NOT NULL` | `CHECK IN ('stripe','shopify','csv')` |
| `external_account_id` | `TEXT NOT NULL` | Stripe account / Shopify shop domain |
| `display_name` | `TEXT NOT NULL` | |
| `status` | `TEXT NOT NULL DEFAULT 'backfilling'` | `CHECK IN ('backfilling','connected','degraded','revoked')` |
| `credentials_ref` | `TEXT` | a **pointer** into the secret store; tokens are never stored in this table |
| `backfill_started_at` | `TIMESTAMPTZ` | the live/backfill seam — see §6.3 |
| `backfill_completed_at` | `TIMESTAMPTZ` | |
| `backfill_cursor` | `TEXT` | provider pagination cursor, walking backwards |
| `lookback_floor` | `DATE NOT NULL` | 36 months by default |
| `created_at`/`updated_at`/`revoked_at` | `TIMESTAMPTZ` | |

Unique on `(org_id, provider, external_account_id) WHERE revoked_at IS NULL` —
reconnecting a revoked account is legal, connecting the same live account twice
is not.

### 3.2 `nexus.sale_events` — the ledger

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | surfaced as `sev_<hex>` |
| `org_id` | `UUID NOT NULL` | tenant key |
| `channel_id` | `UUID NOT NULL` | |
| `source` | `TEXT NOT NULL` | `CHECK IN ('backfill','webhook','csv')` |
| `provider_event_id` | `TEXT NOT NULL` | Stripe charge/balance-transaction id, Shopify order id |
| `kind` | `TEXT NOT NULL` | `CHECK IN ('sale','refund')` |
| `reverses_event_id` | `UUID` | required when `kind='refund'` |
| `occurred_at` | `TIMESTAMPTZ NOT NULL` | the **provider's** timestamp — the measurement date |
| `jurisdiction` | `TEXT NOT NULL` | `US-CA`, `US-TX`, `GB`, `DE` |
| `ship_to_country` / `ship_to_region` | `TEXT` | retained for audit; `jurisdiction` is derived |
| `gross_cents` / `retail_cents` / `taxable_cents` | `BIGINT NOT NULL` | all three bases captured at ingest, because rules disagree on which applies |
| `transaction_count` | `INTEGER NOT NULL DEFAULT 1` | |
| `marketplace_facilitated` | `BOOLEAN NOT NULL DEFAULT false` | |
| `currency` | `TEXT NOT NULL` | |
| `ingested_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | distinct from `occurred_at` |

Two indexes carry the design:

```sql
-- THE idempotency guarantee (§6.4). A duplicate webhook delivery, or a backfill
-- page overlapping live sync, is a no-op at the database level — not in app code.
CREATE UNIQUE INDEX nexus_sale_events_dedupe_idx
  ON nexus.sale_events (org_id, channel_id, provider_event_id, kind);

-- Serves every aggregation variant in one scan (§5.1).
CREATE INDEX nexus_sale_events_agg_idx
  ON nexus.sale_events (org_id, jurisdiction, occurred_at DESC);
```

**Design choice — capture all three bases at ingest, not on read.** A rule may
measure gross, retail, or taxable, and the same order contributes different
amounts to each. Deriving the other two later requires re-fetching the provider
payload; capturing them costs sixteen bytes.

**Design choice — refunds are rows, not updates.** `kind='refund'` with negative
cents and `reverses_event_id` set. The payoff is that every aggregate is a plain
`SUM` with no special-casing, and that the ledger can be replayed to any point in
time. This is invariant 2 and it is not negotiable.

### 3.3 `nexus.rule_sets` / `nexus.rules` — versioned reference data

`rule_sets`: `id`, `version` (`'2026.08.01'`, unique), `published_at`,
`verified BOOLEAN NOT NULL DEFAULT false`, `source_note`.

`rules`: `id`, `rule_set_id` → `rule_sets`, `jurisdiction`, `effective_from
DATE NOT NULL`, `effective_to DATE`, `measurement_basis
CHECK IN ('gross','retail','taxable')`, `measurement_period
CHECK IN ('rolling_12m','calendar_year','previous_calendar_year')`,
`sales_threshold_cents BIGINT`, `transaction_threshold INTEGER`,
`threshold_logic CHECK IN ('sales_only','transactions_only','either','both')`,
`marketplace_treatment CHECK IN ('include','exclude')`,
`registration_deadline_rule JSONB NOT NULL`, `notes`.

**Note the deliberate omission: neither table has an `org_id`.** They are shared
global reference data. This is stated here so that a reviewer who notices a
table without tenant scoping finds the reason already written down instead of
filing it as a finding. The corollary is that no tenant data may ever be joined
*into* these tables, and the CI scan of §7.3 exempts them by name, not by
pattern.

`rule_sets.verified` is a gate, not a label. §11.

### 3.4 `nexus.determinations` — the reproducibility record

| Column | Notes |
|---|---|
| `id`, `org_id`, `jurisdiction`, `evaluated_at` | surfaced as `det_<hex>` |
| `rule_set_version`, `rule_id`, `engine_version` | **the reproducibility triple** |
| `period_start`, `period_end` | the window actually measured |
| `measured_sales_cents`, `measured_transactions` | what we measured |
| `threshold_sales_cents`, `threshold_transactions` | what we measured against |
| `status` | `CHECK IN ('clear','approaching','crossed','registered')` |
| `crossed_on`, `registration_due_on` | `DATE`, null until crossed |
| `inputs` | `JSONB NOT NULL` — the exact aggregate handed to the engine |

Never updated. Re-running `engine_version` against `inputs` and `rule_id` must
reproduce `status`, `crossed_on`, and `registration_due_on` exactly; that is a
test (`reproducibility.test.ts`), not a comment.

Index `(org_id, jurisdiction, evaluated_at DESC)` — "current position" is the
first row of that index, and the history is the rest of it.

### 3.5 `nexus.registrations` / `nexus.alerts`

`registrations`: `org_id`, `jurisdiction`, `status
CHECK IN ('planned','filed','active','closed')`, `registered_on`,
`permit_ref`, `notes`. Unique on `(org_id, jurisdiction) WHERE status <> 'closed'`.

`alerts`: `org_id`, `jurisdiction`, `determination_id`, `kind
CHECK IN ('approaching','crossed','deadline')`, `sent_at`, `notification_ref`,
with

```sql
CREATE UNIQUE INDEX nexus_alerts_once_idx
  ON nexus.alerts (org_id, jurisdiction, determination_id, kind);
```

That index is the "alert exactly once, even if the cron double-fires" guarantee.
It is cheaper and more honest than a distributed lock.

### 3.6 `nexus.inbound_deliveries` — the inbox

`id`, `org_id` (nullable until attributed), `channel_id` (nullable),
`provider`, `provider_delivery_id`, `payload JSONB`, `signature_verified
BOOLEAN NOT NULL`, `status CHECK IN ('received','applied','skipped','failed')`,
`attempts`, `next_attempt_at`, `last_error`, `received_at`, `applied_at`.

Unique on `(provider, provider_delivery_id)`; a partial index on
`(status, next_attempt_at) WHERE status = 'received'` drives the drain.

## 4. The determination engine

```
apps/nexus-worker/src/engine/
  index.ts      barrel + `export const ENGINE_VERSION = "1.0.0"`
  periods.ts    rollingWindow(asOf) | calendarYearWindow(asOf) | previousCalendarYearWindow(asOf)
  measure.ts    pick basis + apply marketplace treatment → { salesCents, transactions }
  threshold.ts  evaluate(measured, rule) → 'clear' | 'approaching' | 'crossed'
  deadline.ts   registrationDueOn(crossedOn, rule.registrationDeadlineRule) → Date
```

Conventions, matching the reference product's engine directory exactly: engine
files import **only types** from `@saas/contracts`, never `@saas/db`, never
`Env`, never `fetch`. Every function is synchronous and deterministic. No
`Date.now()` inside the engine — `asOf` is always a parameter, because a
function that reads the clock cannot be replayed.

`approaching` is a configurable fraction of the threshold (default `0.8`) so the
console can render a meter rather than a boolean, and so a seller gets warning
before the crossing rather than notice after it.

`ENGINE_VERSION` is semver and it is a contract. Any change to how a status is
derived is a major bump; the stored determinations continue to name the version
that produced them.

## 5. Aggregation

### 5.1 One scan, every rule variant

The naive shape runs a query per (measurement basis × marketplace treatment ×
period). Instead, return **all three bases split by marketplace treatment** in a
single grouped scan and let the pure engine choose:

```sql
SELECT jurisdiction,
       SUM(gross_cents)       FILTER (WHERE NOT marketplace_facilitated) AS direct_gross_cents,
       SUM(retail_cents)      FILTER (WHERE NOT marketplace_facilitated) AS direct_retail_cents,
       SUM(taxable_cents)     FILTER (WHERE NOT marketplace_facilitated) AS direct_taxable_cents,
       SUM(transaction_count) FILTER (WHERE NOT marketplace_facilitated) AS direct_txns,
       SUM(gross_cents)       FILTER (WHERE marketplace_facilitated)     AS mkt_gross_cents,
       SUM(retail_cents)      FILTER (WHERE marketplace_facilitated)     AS mkt_retail_cents,
       SUM(taxable_cents)     FILTER (WHERE marketplace_facilitated)     AS mkt_taxable_cents,
       SUM(transaction_count) FILTER (WHERE marketplace_facilitated)     AS mkt_txns
FROM nexus.sale_events
WHERE org_id = $1
  AND occurred_at >= $2
  AND occurred_at <  $3
GROUP BY jurisdiction
```

Refunds are already negative rows, so `SUM` handles reversals with no special
casing — the payoff for invariant 2.

### 5.2 One query per window, not per jurisdiction

Measurement periods differ per jurisdiction but there are only three of them.
The evaluator groups jurisdictions by `(measurement_period, window)` and issues
**one query per distinct window** — in practice three, covering all forty-eight
states. A per-jurisdiction query loop is the obvious wrong answer and it is
called out here so nobody writes it.

### 5.3 The boundary cases

These are where compliance products actually break. Every one gets a table-driven
test in NX2, written *before* the handlers exist:

1. Rolling-twelve-month window is half-open: `>= start AND < end`. Never `BETWEEN`.
2. A state measuring the **previous** calendar year: on 2 January the answer
   changes discontinuously, and that is correct.
3. An `effective_from` rule change mid-window: the window is split and each
   segment evaluated under its own rule version.
4. `occurred_at` is stored UTC but the measurement date is the **jurisdiction's**
   date. A 31 December 23:00 PST sale is a 1 January UTC row and must not land
   in the wrong year.
5. A refund dated in a later period than the sale it reverses — the refund
   reduces the later window, not the earlier one.
6. `threshold_logic = 'both'` where sales cross but transactions do not: not
   crossed.
7. `marketplace_treatment = 'exclude'` flipping the outcome versus `'include'`
   on the same ledger.

## 6. Ingestion

### 6.1 The provider seam

```ts
export interface SalesProvider {
  id: "stripe" | "shopify";
  displayName: string;
  buildAuthorizeUrl(input: { state: string; redirectUri: string }): string;
  completeConnect(input: { code: string; nowMs: number }): Promise<ProviderAccountFacts | null>;
  verifyInboundSignature(rawBody: ArrayBuffer, headers: Headers): Promise<boolean>;
  /** One page of history, walking backwards. Returns the next cursor or null. */
  fetchHistoryPage(input: { cursor: string | null; before: Date; floor: Date })
    : Promise<{ events: CanonicalSaleEvent[]; nextCursor: string | null }>;
  /** A signature-verified webhook payload → zero or more canonical events. */
  normalize(payload: unknown): CanonicalSaleEvent[];
  revoke(nowMs: number): Promise<boolean>;
}
```

Everything above the adapter — handlers, repository, contracts, console, SDK,
CLI — is provider-generic. Only `providers/stripe.ts` and `providers/shopify.ts`
know their provider, and `providers/registry.ts` resolves one from per-
environment credentials, returning `null` (and a parked safe error) when the
credential set is incomplete. `CanonicalSaleEvent` is the single normalisation
target and the only shape the ledger accepts.

Returning `null` from `completeConnect` means the account could not be verified;
callers **fail closed**. Same discipline as the shipped integrations adapter.

### 6.2 Shopify's two hard parts

Both live entirely inside `providers/shopify.ts`, and both get a comment naming
the fallback order:

- **Ship-to jurisdiction.** `shipping_address` → `billing_address` → the
  jurisdiction implied by the order's `tax_lines`. Which fallback fired is
  recorded on the canonical event, because "we guessed" must be visible in the
  evidence.
- **Marketplace-facilitator identification.** `order.source_name` combined with
  the presence of a facilitator-remitted tax line. Getting this wrong moves a
  seller across a threshold they never crossed, or hides one they did.

### 6.3 Backfill and live sync — the sequencing

The whole answer is the ordering:

1. On connect, insert the channel with `status='backfilling'` and
   **`backfill_started_at = now()`**.
2. **Register the webhook and start capturing live deliveries before the
   backfill begins.** Live capture's lower bound is `backfill_started_at`.
3. Backfill walks history **backwards** from `backfill_started_at` by cursor,
   page by page, down to `lookback_floor`. Backfill's upper bound is also
   `backfill_started_at`.
4. The seam is therefore covered from **both** sides, deliberately overlapping.
   Whichever writer reaches an event first wins; the other's insert is a no-op.
5. Nothing is double-counted, because deduplication is
   `nexus_sale_events_dedupe_idx` — a database constraint, not application
   logic. The write is `INSERT … ON CONFLICT DO NOTHING RETURNING *`; an empty
   return means "already applied", which is success, not error.
6. Nothing is lost, because live capture starts **before** backfill, not after.
   The classic bug is the reverse order, which silently loses everything that
   happens during the backfill run.
7. `backfill_completed_at` is set when the cursor exhausts or reaches the floor;
   `status → 'connected'`.

Every step of that is legible in the schema, so the claim is verifiable rather
than asserted.

### 6.4 Idempotency, in four layers

| Layer | Mechanism |
|---|---|
| Delivery receipt | `nexus.inbound_deliveries` unique on `(provider, provider_delivery_id)` — a duplicate POST returns 200 and does nothing |
| Ledger append | `nexus_sale_events_dedupe_idx` + `ON CONFLICT DO NOTHING` |
| Drain | the delivery is marked `applied` **in the same transaction** that inserts the sale event — exactly-once by construction |
| Client-originated writes | the edge's `replayOrExecute(request, requestId, env, "nexus", …)`, KV-backed, keyed on `Idempotency-Key` |

Three of the four are constraints rather than code, which is the point.

The drain itself is the shipped pattern with the payload type swapped: cron
`* * * * *`, batch 50, `MAX_ATTEMPTS = 5`, backoff 1m/2m/4m/8m/16m then terminal
`failed`, each delivery processed independently. We are not inventing retry
semantics.

## 7. Tenancy and isolation

### 7.1 The gate

Every handler runs the platform's three-step gate before touching a repository:
resolve the actor's membership context from `membership-worker`, ask
`policy-worker` whether the action is allowed on the org-scoped resource, and
treat both a membership miss and a policy denial as **404** (deny-as-not-found,
existence-hiding) — the platform-wide convention.

### 7.2 New RBAC actions

Registered in `packages/policy-engine/src/index.ts`, in the per-role arrays
**and** in the flat validation `Set` (missing the `Set` makes an action silently
fail validation):

| Action | owner | admin | builder | viewer |
|---|---|---|---|---|
| `organization.nexus.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.nexus.evaluate` | ✓ | ✓ | ✓ | |
| `organization.ledger.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.ledger.import` | ✓ | ✓ | ✓ | |
| `organization.channel.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.channel.connect` | ✓ | ✓ | | |
| `organization.channel.revoke` | ✓ | ✓ | | |
| `organization.registration.read` | ✓ | ✓ | ✓ | ✓ |
| `organization.registration.write` | ✓ | ✓ | ✓ | |

Connecting and revoking a payment-processor account is an owner/admin act.
A `builder` runs the product; they do not attach the money.

### 7.3 Isolation: query scoping, not RLS — and why

**What we do.** `org_id = $1` in every `WHERE` clause, with the repository
module as the *only* place SQL is written, behind the §7.1 gate.

**Why not Postgres RLS.** Workers reach Postgres through Hyperdrive, which pools
connections. `SET LOCAL app.current_org` on a pooled connection is a footgun: a
missed `RESET`, or a statement that escapes the transaction, leaks a tenant
context onto the next request that borrows the socket. The failure is silent and
cross-tenant, which is the worst pair of properties a bug can have.

**The tradeoff, stated plainly.** RLS is defence-in-depth against a repository
bug; query scoping has none, so it must be enforced structurally instead:

- one repository module is the only SQL surface for each schema;
- `requireOrgAction(...)` runs before every repository call;
- **a CI test scans repository sources and fails any `nexus.` or `channels.`
  query that lacks `org_id = $`**, with `nexus.rule_sets` and `nexus.rules`
  exempt by explicit name (§3.3).

That third item is ~20 lines and it is what turns the claim into a control. It
lands in NX3, with the repository, not later.

## 8. Alerting, audit, and webhooks

`apps/nexus-worker/src/index.ts` exports both `fetch` and `scheduled`. The
hourly job (`7 * * * *`, offset from `metering-worker`'s `5 * * * *` so the two
do not contend):

1. list orgs with ledger activity since the last evaluation watermark;
2. group their jurisdictions by measurement period → three aggregate queries;
3. run the pure engine per `(jurisdiction, rule)`;
4. insert a `nexus.determinations` row **only when the status or the measured
   value changed** — otherwise the table grows by forty-eight rows an hour per
   tenant, forever, and the history stops being readable;
5. on a `clear → approaching` or `* → crossed` transition, insert
   `nexus.alerts` (the unique index makes this exactly-once) and enqueue the
   notification.

Four platform capabilities are consumed rather than rebuilt:

- **Notifications** — `enqueueNotification(...)` from `@saas/notifications-client`
  with `buildIdempotencyKey("nexus.alert", orgId, jurisdiction, determinationId)`.
- **Audit** — `nexus.channel.connected`, `nexus.backfill.completed`,
  `nexus.determination.created`, `nexus.threshold.crossed` emitted to
  `events-worker`. That append-only log **is** the compliance audit trail; we do
  not build a second one.
- **Outgoing webhooks** — `nexus.threshold.crossed` registered as a subscribable
  event type in `webhooks-worker`, signed and replayable, so a seller's own
  systems can react.
- **Metering + entitlements** — see §9.

## 9. Entitlements and metering

Metered dimensions, ingested to `metering-worker`: `jurisdictions_monitored`,
`sale_events_ingested`, `channels_connected`.

Proposed plans, bound in `billing-worker`:

| Plan | Channels | Jurisdictions | Notes |
|---|---|---|---|
| Starter | 1 | 10 | single-store sellers |
| Growth | 3 | all US | the default |
| Firm | unlimited | all US + intl. display | multi-client orgs for accountants |

This is deliberately in scope. A compliance tool without a monetisation model is
a spreadsheet; the platform already ships metered plans, so charging for the
product costs an afternoon rather than a milestone.

## 10. Non-goals and follow-ons

**Non-goals, permanently.** Sales-tax calculation or rate lookup; returns
preparation; remittance or any money movement; filing a registration with a
state on a seller's behalf; tax advice in any form.

**Follow-ons, named but not in NX0–NX9.**

- Additional adapters: Amazon, eBay, Walmart, PayPal, Square — additive against
  the §6.1 seam, one milestone each.
- International VAT/GST *evaluation* (v1 is display-only).
- A public, unauthenticated share link for an accountant to view one tenant's
  exposure read-only — the only genuinely new trust path, so it ships separately
  with its own review.
- Rule-set diffing: "what changed between 2026.08 and 2027.01, and which of your
  positions moved as a result."
- Physical-nexus inputs (inventory locations, employees, trade shows), which
  interact with economic nexus but are a separate data-acquisition problem.

## 11. Rule-data provenance and the unverified gate

`rule_sets.verified` is a gate, not a label. The rule:

> No customer-facing determination may be produced from a rule set with
> `verified = false`.

Enforcement is in the engine's caller, not the UI: an unverified rule set
produces a determination marked internal-only, and the console renders an
explicit banner rather than a status. A UI-only gate is not a gate.

Until a rule set is human-verified against primary sources, the demo tenant and
any pre-launch environment run on a synthetic set with `verified = false` and
`source_note` explaining exactly that. This costs nothing and it is the
difference between a product that is careful and a product that says it is.
