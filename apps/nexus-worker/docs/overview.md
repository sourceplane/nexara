# nexus-worker

The **nexus** bounded context: the append-only sale-event ledger,
per-jurisdiction aggregation, versioned rule data, the determination engine,
determinations, registrations, and alerts.

## What it owns

| Surface | Route |
|---|---|
| Exposure board | `GET /v1/organizations/:orgId/nexus/exposure` |
| Jurisdiction detail | `GET /v1/organizations/:orgId/nexus/jurisdictions/:code` |
| Evaluate now | `POST /v1/organizations/:orgId/nexus/evaluate` |
| Ledger import | `POST /v1/organizations/:orgId/ledger/import` |
| Ledger | `GET /v1/organizations/:orgId/ledger` |
| Registrations | `GET`/`PUT /v1/organizations/:orgId/registrations` |

Everything is org-scoped and everything runs the platform's three-step gate —
membership context, policy decision, deny-as-404 — before touching a
repository.

## The one thing to read first

`src/engine/` is a pure, dependency-free module: no database, no `Env`, no
`fetch`, and no clock. `asOf` is always a parameter, because a function that
reads the clock cannot be replayed, and replay is what makes a determination
evidence rather than an opinion.

`ENGINE_VERSION` is semver and it is a contract. Any change to how a status is
derived is a **major** bump; stored determinations continue to name the version
that produced them.

## The gate that is not RBAC

`rule_sets.verified` is a gate, not a label:

> No customer-facing determination may be produced from a rule set with
> `verified = false`.

Enforcement is in the engine's *caller* — `src/evaluation.ts` writes
`internal_only` onto every determination produced from an unverified set — and
never in the UI. A UI-only gate is not a gate.
