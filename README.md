# nexara

Reusable Cloudflare + Supabase multi-tenant SaaS starter, built as an
[Orun](https://opencode.ai/docs) component-native desired-state repo. Identity,
organizations, projects, RBAC, audit, metering, billing, webhooks, and
notifications ship as separate bounded-context Cloudflare Workers behind a single
public edge API, with a Next.js console on Workers + Static Assets.

## Live deployment

<!-- 08-docs:begin -->
_Not yet recorded — run [`flows/phases/08-docs`](flows/phases/08-docs/README.md)
after phase 06 to fill this section from verified live state
([manifest](ai/context/deployment.md) · [operating contract](ai/context/operations.md))._
<!-- 08-docs:end -->

## Status

- **Runtime is live, per environment, through Orun.** The edge API, the
  bounded-context Workers, and the console deploy to `stage` and `prod` via
  `orun run` (no direct Wrangler/Terraform/pnpm in CI).
- **Data plane is provisioned by Terraform:** Supabase `stage` and `prod`
  projects, Cloudflare Hyperdrive (pooled Postgres for Workers), and the
  `api-edge` idempotency KV namespace. Terraform state lives in the Orun
  Cloud HTTP state backend; provider credentials are BROKERED per-run from
  the workspace's integration connections (no AWS, no long-lived secrets
  at rest).
- **Database migrations** run through the `db-migrate` component (plan on PRs,
  apply on merge to `main`).
- **Billing** is live end-to-end via the Polar adapter (embedded checkout,
  plan changes, multi-org fan-out).
- **Known credential-blocked tails**: full
  production OAuth/magic-link auth and Stripe require human-supplied
  credentials. The notifications email provider is Cloudflare Email Service
  (`cloudflare-email`, no API key — the `send_email` binding is the
  credential); it needs one-time account setup: Workers Paid plan and the
  sending domain verified in Email Service (DKIM/SPF).
- The `dev` environment is verify-only (no provisioned Supabase project by
  design).


## Prerequisites

- Node.js >= 20 (CI and components run on Node 22)
- pnpm >= 10 (`npm install -g pnpm`)
- (Optional, for local Orun validation) the `kiox` CLI on your `PATH`. `kiox`
  pins the Orun provider declared in `kiox.yaml`; invoke Orun as
  `kiox -- orun ...`.

## Getting Started

```bash
# Install all workspace dependencies
pnpm install

# Type-check / lint / test / build across the workspace (Turborepo)
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Workspace Layout

```
apps/api-edge             Public HTTP entry point (Cloudflare Worker)
apps/identity-worker      Users, sessions, API keys, OAuth
apps/membership-worker    Organizations, members, invitations, role assignments
apps/projects-worker      Projects and environments
apps/policy-worker        Deny-by-default RBAC evaluation
apps/events-worker        Domain events, audit log, observability
apps/config-worker        Settings, feature flags, secret metadata
apps/metering-worker      Usage ingestion, quotas, rollups
apps/billing-worker       Plans, subscriptions, invoices (Polar adapter)
apps/notifications-worker Email delivery and preferences
apps/webhooks-worker      Outgoing webhooks: signing, delivery, replay
apps/admin-worker         Audited admin/support workflows
apps/web-console-next     Next.js console (Cloudflare Workers + Static Assets)

packages/contracts        Shared API, tenancy, event, and error types + validators
packages/policy-engine    RBAC evaluation logic
packages/db               Migration harness, manifest, and runner
packages/sdk              TypeScript SDK (contract-driven)
packages/cli              `nexara` CLI
packages/notifications-client  Notifications client
packages/shared           Generic helpers (IDs, errors) — no domain logic
packages/testing          Test fixtures and utilities

infra/terraform/bootstrap          Verifies AWS state backend + Secrets access
infra/terraform/supabase           Supabase project provisioning (stage/prod)
infra/terraform/cloudflare-hyperdrive  Hyperdrive config fronting Supabase
infra/terraform/cloudflare-kv      api-edge idempotency KV namespace
infra/terraform/cloudflare-domain  Zone adoption + console custom domain
infra/db-migrate                   Database migration runner component

tooling/tsconfig          Shared TypeScript configurations
tooling/eslint            Shared ESLint configuration
tests/*                   Per-component contract and verifier test suites
```

Execution contracts (the composition stack) are not vendored here. They are
consumed from the published catalog at
`oci://ghcr.io/sourceplane/stack-tectonic`, pinned to an explicit version in
`intent.yaml`. Composition changes are made in
[sourceplane/stack-tectonic](https://github.com/sourceplane/stack-tectonic),
released there, and adopted here by bumping the pinned tag.

## CI

CI is powered by [Orun](https://opencode.ai/docs) with the local Stack Tectonic
composition stack. `.github/workflows/ci.yml` calls only `orun plan` and
`orun run` — no direct `pnpm`, `turbo`, Wrangler, or Terraform commands run in
GitHub Actions. The Orun runtime is pinned in `kiox.yaml` (resolved digest in
`kiox.lock`); the workflow's `orun-action` `version:` matches that pin.

### Local Orun Verification

```bash
kiox -- orun compositions lock --intent intent.yaml
kiox -- orun validate --intent intent.yaml
kiox -- orun plan --changed --intent intent.yaml --output plan.json
kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

Use `--changed` for PR-scoped checks; use a full plan when validating
environment promotion or cross-component dependencies (`--view dag`).

## Infrastructure

Terraform provisions Supabase projects, Cloudflare Hyperdrive, and the
`api-edge` KV namespace for `stage` and `prod`. Credentials are generated by
Terraform and stored in AWS Secrets Manager under
`<org>/nexara/<component>/<env>`. Terraform state uses the shared S3
buckets `sourceplane-<env>` (IAM roles and buckets are owned by the `aws-admin`
repo). See `specs/core/access-and-infra.md` for the access model and the
manual prerequisites.

## Adding a New Component

1. Create the directory under `apps/`, `packages/`, `tests/`, or `infra/`.
2. Add a `component.yaml` with the appropriate `spec.type` — one of
   `cloudflare-worker-turbo`, `cloudflare-workers-assets-turbo`, `terraform`,
   `db-migrate`, or `turbo-package` — plus `subscribe.environments` and the
   typed `parameters` the composition schema requires.
3. Orun discovers it automatically on the next plan (`discovery.roots` covers
   `apps/`, `infra/`, `packages/`, `tests/`). Validate with
   `kiox -- orun validate --intent intent.yaml`.

See `specs/core/orun-golden-path.md` for the intent/component/composition layer
rules before changing CI, infra, or `intent.yaml`.
