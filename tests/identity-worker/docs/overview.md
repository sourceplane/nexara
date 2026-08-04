# identity-worker-tests

Verification suite for `None`.

A verify-only component: its lane runs this suite against
its target component on every plan that
includes it. Nothing deploys from here — a red lane blocks the
convergence, which is the point.

## Gates

- (none)
