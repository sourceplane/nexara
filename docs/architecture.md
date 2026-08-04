# Nexara — architecture

The shape of the system, and the reasons behind the shapes that were not
obvious. [`docs/overview.md`](./overview.md) is the front page; this is the
page for someone who has to change the thing.

The full technical design is
[`specs/epics/nexus/design.md`](../specs/epics/nexus/design.md). This document
is the as-built summary, and where the two disagree the code is right and both
documents are bugs.

---

## The request path

```
browser / CLI / SDK
        │
        ▼
   api-edge ──────────────────────────────────────┐
   · resolves the session → pinned actor headers  │  the ONLY public surface
   · idempotency replay, rate limits, CORS        │
   · facade per bounded context                   │
        │                              │          │
        ▼                              ▼          │
  nexus-worker                  channels-worker   │
  · exposure, jurisdictions     · connect/revoke  │
  · ledger read + import        · webhook ingress ◀── provider webhooks
  · registrations               · the drain       │   (signature, not session)
  · alert contact               · staleness       │
  · the determination engine                      │
        │                              │          │
        └──────────┬───────────────────┘          │
                   ▼                              │
            @saas/db (Hyperdrive → Postgres)      │
                                                  │
  admin-worker ── internal only, no edge route ───┘
```

Two things about that diagram are load-bearing.

**The `/channels` sub-tree is served by a different worker than the rest of
nexus, behind one facade.** `nexus-facade.ts` routes by path prefix to either
`NEXUS_WORKER` or `CHANNELS_WORKER`. The seller does not need to know there are
two workers, and the split exists because ingestion has a completely different
load profile and failure mode from reading a board.

**The provider webhook ingress is the only new trust path in the product.** It
is matched *before* the authenticated facade and dispatched without resolving
an actor, because a provider webhook carries a signature rather than a session.
The raw body is forwarded untouched: every provider signs the bytes as sent,
and re-serialising a parsed object breaks every signature for reasons that look
like a key problem.

---

## The determination engine is pure, and that is not a style preference

`apps/nexus-worker/src/engine/` imports **types only**. No database, no `Env`,
no `fetch`, and — the one that matters — **no clock**. `asOf` is always a
parameter.

A function that reads the clock cannot be replayed. Invariant 3 says a
determination made today must re-derive in two years from its stored inputs;
that is impossible if the code consults `Date.now()` anywhere in the path. The
purity is enforced by a test that reads the engine's own source
(`engine-purity.test.ts`), not by convention.

The engine's boundaries are where the bugs would be, so each has a named test:

| Boundary | Why it bites |
|---|---|
| Half-open rolling windows | `[D − 12 months + 1 day, D + 1 day)`. `BETWEEN` double-counts the edge. |
| The previous-calendar-year discontinuity | The window jumps on 1 January; a naive implementation reports zero for a day. |
| A rule change mid-window | Two measurements, not one average. |
| UTC vs jurisdiction date | A 31 December 23:00 PST sale is a 1 January UTC row. Without the rule's own timezone it lands in the wrong measurement year — the single most likely silent bug in the product. |
| A refund in a later period than its sale | It reduces the window it lands in, not the one the sale did. |
| `threshold_logic = 'both'` with only sales crossing | Not crossed. |
| Marketplace treatment flipping the outcome | Same ledger, two lawful answers, depending only on the state. |
| `threshold_logic = 'none'` over a ledger with real sales | Terminal `no_obligation`, never `clear` at 0%. |

`reproducibility.test.ts` re-runs the pinned `ENGINE_VERSION` against a stored
inputs payload and asserts `status`, `crossedOn`, and `registrationDueOn` come
back identical. Breaking it requires an `ENGINE_VERSION` bump, not a patched
expectation.

---

## Tenancy: query scoping, and the three layers that make it hold

Design §7.3 rejected Postgres RLS for a specific reason. Workers reach Postgres
through **Hyperdrive, which pools connections**, so `SET app.current_org` on a
session outlives the request that set it and leaks a tenant context onto
whichever request borrows the socket next. Silent and cross-tenant is the worst
pair of properties a bug can have.

The cost of that choice is that query scoping has no runtime second line of
defence. So it is enforced structurally, at three layers:

1. **The authorization gate** runs before every repository call — membership
   context, then a policy decision, then **deny-as-404** so a denial is not a
   membership oracle.
2. **Composite foreign keys** make a cross-tenant *write* impossible at the
   database level. This arrived from the NX1.5 review rather than from the RLS
   direction, and it covers the write path completely.
3. **A CI scan** (`tests/db/src/tenancy-scan.test.ts`) fails any
   `nexus.`/`channels.` query lacking `org_id = $`, and any such SQL found
   *outside* the repository modules. Exemptions are declared at the call site
   from a **closed list of three reasons** — never by table name, because
   exempting a table disarms the scan for every future read of it.

**The residual risk, stated plainly:** a missing `org_id = $1` in a *read*
would return another tenant's data if it reached production. Layer 3 is what
stops it reaching production, and it is a test rather than a runtime guard.
That is a real difference from RLS and it is accepted knowingly. See
[`connector-gate.md`](../specs/epics/nexus/connector-gate.md) §Q5 for the
options that were considered and why each was rejected.

---

## Ingestion: how the backfill seam is covered from both sides

The classic bug is to backfill history and *then* start listening, losing
everything that happened in between. The order here is deliberate
(design §6.3), and it is the whole answer to "did we lose or double-count
anything":

1. insert the channel with `backfill_started_at = now()`;
2. **register the webhook and start capturing live deliveries BEFORE the
   backfill begins** — live capture's lower bound is that instant;
3. the backfill walks history backwards from that same instant;
4. the seam is therefore covered from both sides, deliberately overlapping;
5. nothing is double-counted, because deduplication is a **database
   constraint** (`nexus_sale_events_dedupe_idx`), not a code path;
6. nothing is lost, because live capture started first.

A channel mid-backfill is `backfilling`, never `connected`. A channel serving a
partial ledger that looks complete is the failure mode that state exists to
make visible, and the console renders it as such.

### The provider seam

Everything above `SalesProvider` — handlers, repository, contracts, console,
SDK, CLI — is provider-generic. Only `stripe.ts` and `shopify.ts` know their
provider, and `CanonicalSaleEvent` is the single normalisation target. Adding a
third provider is one file and its fixtures; that is what the seam is for.

Two disciplines inside it fail *closed*:

- `completeConnect` returning null means the account could not be verified, and
  the caller writes no channel row. A channel we cannot authenticate against
  would read as "connected, no sales" — indistinguishable from a seller who is
  genuinely clear.
- `verifyInboundSignature` returns a boolean and never throws, so a malformed
  header is a rejection rather than a 500 a caller could use to distinguish
  "bad signature" from "bad request".

Money conversion lives inside the adapter that needs it. Stripe reports integer
minor units and is passed through; Shopify reports decimal strings and is
**parsed digit-wise**, never `Math.round(Number(x) * 100)` — that is right for
the values you try and wrong for the ones you do not, and "the ones you do not"
is the tail of a seller's order history.

---

## Evaluation and alerting

An hourly cron evaluates orgs with new ledger activity since their watermark.
Three properties are worth knowing:

- **Only changed positions write a determination.** Running it twice in a row
  is not a way to manufacture history.
- **Alerts are exactly-once by unique index** (`nexus_alerts_once_idx`), not by
  a distributed lock — which would be wrong under concurrency anyway. The alert
  row is written *before* the notification is enqueued: losing an email is
  recoverable; sending a seller five copies of "you have crossed a tax
  threshold" is not.
- **An unverified rule set produces internal-only determinations and no
  customer-facing alert** (§11) — while still emitting the audit event, because
  suppressing that would leave a hole in the history exactly where a dispute
  would look.

Where the alert goes is the seller's own choice, stored in
`nexus.alert_contacts`. With none set, a per-environment address is the floor,
and with neither the alert row records `no_recipient_configured` — so "no email
went out" is a queryable fact rather than something a support ticket discovers.

---

## Rule data, and the gate on it

Rules are **versioned reference data with effective dates**, not code. A rule
set is global (no `org_id`), and `nexus.rules` carries an exclusion constraint
so two rules for one jurisdiction cannot overlap in time — the schema, not the
loader, is what makes "the rule in force on that date" a well-defined question.

`rule_sets.verified` is **a gate, not a label**. No customer-facing
determination may be produced from an unverified set. Enforcement is in the
engine's *caller*, which marks such determinations `internal_only` and
suppresses their alerts; the console renders a banner in place of a status. A
UI-only gate is not a gate, and a gate with no UI is a gate a merchant cannot
see — so there are two halves and both are required.

The rule set shipped today is **synthetic and unverified by design**. Who
publishes and verifies rule sets, with what tax-practice accountability, is
open question Q1 in
[`risks-and-open-questions.md`](../specs/epics/nexus/risks-and-open-questions.md).

---

## Observability

The structured timing line on every handler, `observability: { enabled: true }`
on the workers, and the domain event log in `events-worker` — which **is** the
compliance audit trail; there is no second one.

The signal that matters most is a counter: **determinations produced from an
unverified rule set that are not marked internal-only**. If that is ever
non-zero in production, the §11 gate has a hole and nothing else will say so.

One prohibition is absolute: **raw provider payloads never reach a log sink.**
A retention policy on the inbox is worthless if the same bytes are also sitting
in logs outside it.

---

## Where things live

| Path | What |
|---|---|
| `apps/nexus-worker/src/engine/` | The pure determination engine. Types only, no clock. |
| `apps/nexus-worker/src/handlers/` | Exposure, jurisdictions, evaluate, ledger, registrations, alert contact. |
| `apps/channels-worker/src/providers/` | The provider seam and its two adapters. |
| `apps/channels-worker/src/drain.ts` | Inbox → ledger, with the retention sweep after it. |
| `packages/db/src/nexus/`, `.../channels/` | The **only** SQL surfaces for these contexts. Enforced by test. |
| `packages/db/src/migrations/2*` | The schema, one directory per migration, checksummed in the manifest. |
| `packages/contracts/src/{nexus,channels}.ts` | Wire types and the enumerations that mirror CHECK constraints. |
| `apps/web-console-next/src/components/nexus/` | Console presentation logic — pure, and unit-tested where a display rule could state a falsehood. |
| `apps/admin-worker/src/handlers/nexus-support.ts` | The read-only support view. Internal; see [`support-view.md`](../specs/epics/nexus/support-view.md). |

For running it, see [`runbook.md`](./runbook.md).
