# nexus-worker-tests — runbook

## How it runs

Planned whenever the engine (or this suite) changes; the lane runs the suite
and reports pass/fail. There is nothing to deploy or roll back.

## When it fails

Read the failing assertion in the lane log. Fix the engine or update the suite
WITH the behavior change in the same PR — never merge around a red verify
lane; it is the convergence gate.

## When `reproducibility.test.ts` fails

Treat this one differently. It failing means a stored determination would no
longer re-derive to the answer it recorded, which is the product's core
promise. The fix is **never** to update the expectation. Either the change was
unintended and should be reverted, or it is a deliberate change to how a status
is derived — in which case bump `ENGINE_VERSION`'s major, add the new expected
vector alongside the old one, and leave the old vector asserting against the
old version.
