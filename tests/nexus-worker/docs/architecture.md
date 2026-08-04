# nexus-worker-tests — architecture

A `turbo-package` component in `tests/nexus-worker`, built and executed by the
turbo pipeline. It imports the engine through the same path production code
uses (`@nexus-worker/engine/*`), so contract drift fails here first — before a
deploy lane ever runs.

The suite is table-driven. Each boundary case from `design.md` §5.3 is a named
row with its own expectation, so a failure names the boundary rather than a
line number.

Fixtures are plain objects: there is no database, no `Env`, and no network in
this suite, because there is none in the thing it tests.
