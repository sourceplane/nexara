# nexus-worker — architecture

`index.ts → router.ts → handlers/* → @saas/db/nexus → Hyperdrive`, the shipped
worker anatomy unchanged. Nothing about the shape is novel to a reviewer who
has read `projects-worker`.

## Modules

| Module | Responsibility |
|---|---|
| `engine/` | The pure determination engine. Imports **only types** from `@saas/contracts`. |
| `evaluation.ts` | The orchestration between the repository and the engine. Shared by the `evaluate` handler and NX5's cron, so the two cannot drift. |
| `handlers/gate.ts` | The three-step authorization gate, in one place rather than six copies. |
| `jurisdictions.ts` | Which codes are evaluable (US only in v1; international rows are display-only) and their display names. |
| `mappers.ts` | Repository rows → wire shapes. The seam where a CHECK-constraint change that the contract has not absorbed becomes a compile error. |

## Why the engine is separate from everything else

It is the product's only real IP and its only hard promise: given the same
inputs and the same rule, the same answer, forever. Isolating it from all I/O
is what makes that testable without a database, and `engine-purity.test.ts`
reads the sources to keep it true rather than trusting the convention.

## Aggregation

One grouped scan returns all three measurement bases split by marketplace
treatment (`design.md` §5.1); the engine chooses. Jurisdictions are grouped by
`(measurement period, timezone)` so forty-eight states collapse to a handful of
queries — **one query per distinct window, never one per jurisdiction**
(§5.2).

## Tenancy

Query-scoped, not RLS: Workers reach Postgres through Hyperdrive, which pools
connections, and a leaked `SET LOCAL app.current_org` is a silent cross-tenant
bug. `@saas/db/nexus` is the only SQL surface, the gate runs before every
repository call, and `tests/db/src/tenancy-scan.test.ts` fails any query that
escapes either rule.
