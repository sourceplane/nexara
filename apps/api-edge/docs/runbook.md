# api-edge — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components
(`orun plan --changed`) and runs this component's lane via
`orun run --remote-state` with credential-free OIDC auth. The convergence
run is the deployment; the DAG orders this component after everything it
depends on. Failed lanes resume with `gh run rerun --failed`.

## Rollback

Revert the offending commit on `main`; the next convergence applies the
previous desired state. There is no out-of-band mutation to undo — the
repo is the source of truth.

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://nexara-api-edge-stage.nexara.workers.dev/health
curl -s -o /dev/null -w '%{http_code}\n' https://nexara-api-edge-prod.nexara.workers.dev/health
```

2xx–4xx = alive (401/403 is "deployed, unauthorized"); 5xx/timeout = not
deployed. The deploy lane's smoke already retries ~75s, so a persistent
failure is real.

## Common failures

- **Missing `WIRING_*` / `SUPABASE_*` secret at deploy**: the
  infrastructure terraform upstream has not applied — check that lane
  first; within one convergence run the DAG guarantees order.
- **Service-binding target missing (Cloudflare 10143)**: the target
  Worker does not exist yet on this account — converge the fleet before
  this lane (the bootstrap's two-pass landing handles first boot).
- **Smoke fails right after a first deploy**: a brand-new workers.dev
  route can 4xx for a few seconds; the lane already retries — persistent
  failure means a real regression.
