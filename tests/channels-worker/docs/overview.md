# channels-worker-tests

Verification suite for the **ingestion pipeline** (`apps/channels-worker`).

A verify-only component. Nothing deploys from here — a red lane blocks the
convergence, which is the point.

## Gates

- **The seam.** A backfill page overlapping a live delivery for the same charge
  produces one ledger row, not two — the design §6.3 acceptance criterion,
  driven through the real drain.
- **The gate on the only unauthenticated ingress.** An unsigned or
  wrongly-signed delivery is rejected and never reaches the inbox, and every
  rejection returns the same shape so the response is not an oracle.
- **The drain's failure semantics.** A provider outage retries and then
  terminates at `failed` without blocking other deliveries.
- **Q4's staleness baseline** and **Q6's retention sweep**, each as a pure
  function with its own table of cases — a judgement call with numbers in it
  belongs somewhere a reviewer can argue with it.
