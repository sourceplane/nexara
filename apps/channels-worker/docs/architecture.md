# channels-worker — architecture

`index.ts → router.ts → handlers/* → @saas/db/channels → Hyperdrive`, plus a
`scheduled` drain. The shipped worker anatomy unchanged.

## The provider seam

`providers/types.ts` is the whole extension point. Everything above it —
handlers, repository, contracts, console, SDK, CLI — is provider-generic;
only `providers/stripe.ts` and (NX7) `providers/shopify.ts` know their
provider, and `CanonicalSaleEvent` is the single normalisation target and the
only shape the ledger accepts.

`providers/registry.ts` resolves a provider from per-environment credentials
and returns **null** when the set is incomplete. Callers report a parked,
safe error rather than a 500: an adapter that "works" until it reaches the
network produces a channel that looks connected and ingests nothing, which is
indistinguishable from a seller with no sales.

## Why this is not `integrations-worker`

That worker's seam is shaped for GitHub Apps — a numeric `installationId`,
App-JWT minting, `completeConnect(installationId)`. Stripe Connect and Shopify
are OAuth token flows over a different lifecycle, and forcing them through
that interface costs more than it saves.

What **is** reused is the machinery that carries the risk: the inbox drain
(cron + table + bounded retries, no Queues), signed single-use connect state,
and the credential envelope. We copy the discipline, not the interface.

## Tenancy

Three queries here are necessarily un-scoped — the delivery receipt, the
drain's claim, and the attribution lookup — and each carries a
`tenancy-exempt: pre-attribution-inbox` marker at its call site. A webhook is
authenticated by a signature, not a session, so the org is unknown until the
drain resolves it. Every **tenant-facing** read still scopes, and the CI scan
in `tests/db` enforces the distinction.
