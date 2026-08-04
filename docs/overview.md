# Nexara

**Economic-nexus threshold monitoring for ecommerce sellers.**

An ecommerce seller owes sales tax in a US state once their sales into that
state cross an *economic nexus* threshold. The thresholds differ per state — in
amount, in what counts toward them, and in the window they are measured over.
Most sellers discover they crossed one when a state sends a notice, years and
penalties later.

Nexara watches the line and says so on the day it is crossed.

## What it does

1. **Ingests every sale.** Stripe and Shopify connect over OAuth; a CSV import
   covers everything else. Each order lands in an append-only ledger with the
   provider's own timestamp, the ship-to jurisdiction, and all three
   measurement bases captured at ingest.
2. **Measures per jurisdiction, in the right window, on the right basis.**
   Rolling twelve months, current calendar year, or previous calendar year —
   whichever that state uses — against gross, retail, or taxable sales, with
   marketplace-facilitated orders included or excluded per that state's rule.
3. **Compares against the rule in force on that date.** Rules are versioned
   reference data with effective dates, not code.
4. **Records the answer as evidence.** Every determination stores the rule-set
   version, the rule id, the engine version, and the exact aggregate it was
   computed from.
5. **Says something before the state does.** A threshold crossing raises an
   alert, an audit event, and a signed outgoing webhook, with the registration
   deadline computed from that jurisdiction's own deadline rule.

## Why it is defensible

Anyone can render a progress bar. Three invariants make this evidence rather
than a dashboard:

| # | Invariant | Consequence |
|---|-----------|-------------|
| 1 | **Money is integer cents.** `BIGINT`, columns named `*_cents`, no floats anywhere — including inside the engine. | Sums are exact. A rounding drift cannot move a seller across a threshold. |
| 2 | **The ledger is never updated in place.** A refund is a new row with negative cents pointing at the original. | Every aggregate is a plain `SUM`, and the ledger replays to any point in time. |
| 3 | **A determination is reproducible.** Rule-set version + rule id + engine version + the exact inputs are stored on the row. | A determination made today can be re-derived in two years, when a seller gets a state notice and asks why we said what we said. |

Invariant 3 is the product. The defensible claim is not *"you are clear"* — it
is *"here is the rule that applied, the window it measured, the numbers it
measured, and the code version that decided. Re-run it yourself."*

## What it deliberately does not do

Nexara reports a measurement against a rule. It does not advise.

| In scope | Out of scope |
|----------|--------------|
| US state economic-nexus thresholds (sales and/or transaction counts) | Sales-tax *calculation*, rate lookup, or filing |
| Rolling-12-month, calendar-year, and previous-calendar-year windows | Returns preparation, remittance, or any money movement |
| Gross / retail / taxable measurement bases | Registering with a state on a seller's behalf |
| Marketplace-facilitator inclusion/exclusion per jurisdiction | The marketplace's own facilitator obligations |
| Stripe and Shopify ingestion; CSV import | Amazon, eBay, Walmart, PayPal, Square (additive, later) |
| International VAT/GST registration thresholds, **display-only** | International VAT/GST evaluation and alerting |
| Threshold alerting, registration deadline tracking, immutable evidence | Tax advice of any kind |

A jurisdiction that enforces no threshold — New Hampshire, Oregon, Montana,
Delaware, Alaska — gets an explicit rule row saying so, not an absent one. "No
obligation" and "no data" must never render alike: the first is the answer, the
second is a bug in our rule set.

## How it is built

Nexara runs on Cloudflare Workers and Supabase Postgres, as an
[Orun](https://opencode.ai/docs) component-native desired-state repo. The
product sits on a shipped multi-tenant platform — identity, organizations,
RBAC, an append-only event log, metering, billing, notifications, signed
outgoing webhooks, and an audited admin surface — so the product contexts only
have to know about money crossing a border.

| Context | Worker | Owns |
|---------|--------|------|
| `nexus` | `apps/nexus-worker` | the sale-event ledger, per-jurisdiction aggregation, rule sets, the determination engine, determinations, registrations, alerts |
| `channels` | `apps/channels-worker` | connections, connect state, the inbound-delivery inbox, backfill cursors, and the drain that normalises provider payloads into canonical sale events |

Everything reaches the outside world through one public edge API
(`apps/api-edge`) and one Next.js console (`apps/web-console-next`). The
determination engine is a pure, dependency-free module with no database, no
`fetch`, and no clock — `asOf` is always a parameter, because a function that
reads the clock cannot be replayed.

## Rule-data provenance

`rule_sets.verified` is a gate, not a label:

> No customer-facing determination may be produced from a rule set with
> `verified = false`.

Enforcement is in the engine's caller, not the UI — a UI-only gate is not a
gate. Until a rule set is verified against primary sources by a named human
with tax-practice accountability, every environment runs a synthetic set with
`verified = false`, and the console renders an explicit banner instead of a
status.

## Further reading

- [Operating contract](../ai/context/operations.md) — how to run it.
- [Live deployment manifest](../ai/context/deployment.md) — what is deployed, where.
- [`specs/epics/nexus/`](../specs/epics/nexus/) — the charter, the technical
  design, the milestone plan, and the open questions.
