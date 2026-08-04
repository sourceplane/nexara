# nexus-worker — runbook

## Health

`GET /health` reports binding presence for the database, membership, policy,
events, and notifications. It does **not** ping Postgres — a health check that
opens a connection per probe is a load generator.

## Named signals (design §12)

Ordinary 5xx rates do not cover this product's risks, all of which fail
quietly. Watch these:

| Signal | Why | Where |
|---|---|---|
| a determination with `internal_only = false` while the rule set is unverified | the §11 gate has a hole, and nothing else will say so | `nexus_determinations_internal_only_idx` |
| `ledger.divergent_duplicate` | a provider amended an already-ingested event and the first amount stands forever (R9) | worker log line, ids only |
| a channel with no `last_event_at` inside its cadence | absence of data reads exactly like absence of sales (R3) | `nexus_channels_staleness_idx` |
| `backfill_completed_at` never set | a channel stuck mid-backfill serves a partial ledger that looks complete | `nexus.channels` |
| `ENGINE_VERSION` at evaluation time | when a determination is disputed years later, the log is the corroborating record for the row's own claim | timing log line |

**One prohibition.** Raw provider payloads are never written to a log line.
They carry customer names and addresses, the inbox already holds them under a
retention policy, and a log sink is precisely where that policy stops applying.
Log the delivery id and the channel id.

## When the board is empty

Check, in order:

1. Is a rule set published? `GET /nexus/exposure` returns **412
   `no_rule_set`**, not an empty board — an empty board would say "you are
   clear", which is a claim we have no basis to make.
2. Has an evaluation run? A jurisdiction with a rule but no determination
   renders as a card with no measurement, which is correct and different from
   absent.
3. Is there a ledger? `GET /ledger` — a tenant with no channel and no import
   has nothing to measure.

## When a determination looks wrong

Do **not** edit it. The row is immutable by design and the history is the
evidence. Re-derive it instead: take the row's `inputs`, its `rule_id`, and its
`engine_version`, and re-run the engine. If the answer differs, the engine
changed without an `ENGINE_VERSION` bump and that is the bug —
`reproducibility.test.ts` should have caught it.

There is no determination override anywhere in this product, including in the
support surface. A support tool that can change a determination turns the audit
record into an opinion, which is the one thing this product sells against.
