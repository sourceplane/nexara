# nexus-worker-tests

Verification suite for the **determination engine** (`apps/nexus-worker/src/engine`).

A verify-only component: its lane runs this suite on every plan that includes
it. Nothing deploys from here — a red lane blocks the convergence, which is
the point.

## What this suite is for

The engine is the product's only real IP and its only hard promise: given the
same inputs and the same rule, the same answer, forever. This suite is what
makes that a fact rather than a claim.

## Gates

- **Every boundary in design §5.3 has a named test.** Half-open windows, the
  previous-calendar-year discontinuity, a mid-window rule change, the UTC vs
  jurisdiction-date year boundary, a refund landing in a later period than its
  sale, `both` with only sales crossing, marketplace treatment flipping the
  outcome, and `none` returning a terminal no-obligation on a ledger with real
  sales in it.
- **`reproducibility.test.ts`** re-runs the pinned `ENGINE_VERSION` against a
  stored `inputs` payload and its rule, and asserts `status`, `crossedOn`, and
  `registrationDueOn` come back byte-identical. A change that breaks it is a
  breaking change and requires an `ENGINE_VERSION` bump, **not a patched
  expectation**.
- **`engine-purity.test.ts`** reads the engine sources and fails any import of
  `@saas/db`, any `fetch`, and any clock read. The purity claim is what makes
  replay possible; a test is the only thing that keeps it true.
