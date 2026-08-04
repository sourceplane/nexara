# channels-worker — runbook

## Named signals (design §12)

| Signal | Why it matters |
|---|---|
| a delivery at terminal `failed` | a permanently dropped sale is a wrong board, and the drain's own retries make it look like a success path until attempt five |
| `channels.drain_tick` with `divergent > 0` | a provider amended an already-ingested event; the first amount stands forever (R9) |
| a channel `degraded` past its cadence | absence of data reads exactly like absence of sales (R3) |
| `backfill_completed_at` never set | a channel stuck mid-backfill serves a partial ledger that looks complete |

**One prohibition.** Raw provider payloads never reach a log line. `last_error`
is a log sink by another name — it is bounded to a short reason code and must
never echo body content.

## When a connect flow parks

`POST …/channels/connect` returning **501 `provider_unconfigured`** means the
environment's credential set for that provider is incomplete. That is the
registry failing closed on purpose. Check `GET /health` — provider readiness is
reported per provider, not as one boolean, precisely so this is answerable
without guessing.

## When deliveries arrive but the board does not move

Walk it in order:

1. `GET …/channels/deliveries` — are they `applied`, or `skipped`?
2. `skipped: unattributed` means no live channel matches the provider account
   in the payload. The seller likely revoked and reconnected, or the webhook is
   configured against a different account than the one connected.
3. `skipped: no_sale_events` is normal — providers send many event types that
   are not sales.
4. If they are `applied`, the ledger has them and the question is an
   evaluation one; go to `nexus-worker`'s runbook.

## When you must re-drive a delivery

There is no "replay" endpoint, deliberately. The ledger dedupes, so a replay
would be a no-op for anything already applied — and for anything *not* applied,
the reason it was skipped is recorded and is the thing to fix. Re-driving
around a recorded skip reason is how a wrong ledger gets built confidently.
