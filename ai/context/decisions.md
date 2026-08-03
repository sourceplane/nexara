# Decisions

Architecture and process decisions for nexara. Add an entry per
decision (date, decision, rationale); prune superseded ones.

## Active Decisions

- The `dev` environment is verify-only by design: plan/verify lanes
  run, nothing deploys and no dev database exists.
- Provider credentials are brokered per-run from workspace
  integrations; no long-lived provider secrets at rest, and no
  tooling may print a secret value.
- Merges to `main` converge automatically; the convergence run is
  the deployment (see [operations.md](operations.md)).
