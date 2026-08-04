# Specs

Status: Normative index

The written half of nexara. Code is the source of truth for *what runs*; these
documents are the source of truth for *what we decided and why*. Where a spec
and the running system disagree, the system wins and the spec is the bug.

## Layout

| Path | What lives there |
|------|------------------|
| [`epics/`](./epics/) | Work programs. Each epic is a folder carrying a canonical doc set; epics are the cross-cutting programs that evolve the product. |

Additional trees (`components/`, `core/`) are added when they carry weight. The
platform's own golden-path rules — the intent / component / composition layer
contract that governs `intent.yaml`, every `component.yaml`, and CI — are
inherited from the baseline and are **not** re-litigated here.

## Status legend

`Draft → Ready → In progress → ✅ Shipped → ⛔ Blocked → Closed`

- **Draft** — written, not agreed. Open questions outstanding.
- **Ready** — agreed and implementable; no code yet.
- **In progress** — at least one milestone built.
- **✅ Shipped** — every milestone built *and* verified live. "Implemented
  locally" is not a completion state.
- **⛔ Blocked** — waiting on something outside the repo (a credential, an
  upstream release, a human decision). The blocker is named.
- **Closed** — abandoned or superseded, with the successor named.

## Conventions

- **As-built ≠ intent.** What actually shipped lives in each epic's
  `IMPLEMENTATION-STATUS.md`, kept distinct from the design and plan docs.
- **Milestone ✅, not archive.** A completed milestone inside an active epic is
  marked ✅ in `implementation-plan.md` and recorded in
  `IMPLEMENTATION-STATUS.md` — it is not deleted.
- **Decisions get locked in the README.** The `Decisions locked` row of an
  epic's status table is the short, quotable list. If a decision is not in that
  row, it is not locked, and a reviewer may reopen it without argument.
