# nexus — The support view, and why it is not in the browser yet

Status: **Capability shipped in NX8. Browser surface deferred, with the
blocker named.**

`implementation-plan.md` NX8 asks for

> A staff-only surface behind the existing `admin-worker` gate, **reusing the
> platform's admin route group** rather than adding a second privileged path.

The premise is wrong, and it is worth writing down rather than quietly working
around, because the correction is the interesting part.

---

## What is actually there

`apps/admin-worker` exists and is deployed. Its authorization seam
(`support-auth.ts`) is deny-by-default and correct. But:

- **It is not reachable from anywhere.** `ADMIN_WORKER` appears in no service
  binding in the repository. `api-edge` does not route to it, and its own
  router comments say so: *"admin-worker is NOT exposed via api-edge."*
- **There is no admin route group in the console.** `web-console-next` has
  `(app)`, `auth`, `login`, `onboarding`, `demo` — no privileged group.
- **There is no staff identity anywhere in the platform.** No `support_role`
  column, no staff flag on a user, nothing in `identity-worker`. The support
  role is a **header claim** (`x-support-role`) from a trusted internal caller,
  which `support-auth.ts` documents as deliberately narrow for V1.

So there is no "existing admin route group" to reuse. There is a worker with a
good gate and no door.

## Why the door was not cut in NX8

Routing `admin-worker` through `api-edge` so a browser could reach it means
answering: **where does the support-role claim come from?**

There are only two answers today and both are bad:

1. **Forward the header from the browser.** Then any authenticated user sets
   `x-support-role: support_admin` and reads every tenant's compliance history.
   This is a total tenancy break, dressed as a feature.
2. **Have the edge inject it.** The edge would have to know who is staff, and
   nothing in the platform knows that. Inventing it inside a feature milestone
   means a privileged surface shipping with no threat model, no revocation
   path, and no audit of who was granted the role — three things the rest of
   this epic spent its budget getting right.

A third answer exists and is correct, and it is a piece of platform work rather
than nexus work: **a real staff identity** — a subject attribute in
`identity-worker`, resolved by `resolveActor`, carried as a signed claim, with
its own grant/revoke audit trail. That is a design, not a paragraph, and
`support-auth.ts` already anticipates it ("can be tightened to a signed claim
later without changing this contract").

Shipping a browser surface before that exists would mean shipping option 1 or
option 2. Neither is a thing this epic should do on its way to a console.

## What NX8 did ship

`apps/admin-worker/src/handlers/nexus-support.ts` —
`GET /v1/internal/support/organizations/:orgId/nexus`, behind the same
`authorizeSupportAction` gate as every other support read, auditing its
denials the same way.

It returns, for one target tenant:

- channel and backfill state,
- determination history **with the stored `inputs` verbatim** — so support
  reads exactly what the merchant reads, not a prettified summary,
- registrations,
- the delivery inbox with **failed deliveries first**, because that is usually
  where the ticket comes from.

Three properties are enforced rather than asserted:

1. **Read-only, and provably so.** `tests/admin-worker/src/nexus-support.test.ts`
   reads the handler and router sources and fails the build if a writing
   repository method, an `INSERT`/`UPDATE`/`DELETE`, a second exported
   function, or a non-`GET` route ever appears on this path. The test also
   proves it would catch such a change rather than passing on anything.
2. **One org per query.** Support may read *any* tenant; it never reads
   *across* tenants. Every call is the same org-scoped repository method the
   merchant's own console uses, with the target org id. The CI tenancy scan
   therefore needs no new exemption for this surface — which is the outcome
   worth having, because a new exemption reason is a permanent widening.
3. **No payloads.** The delivery projection carries status, attempts and a
   short non-payload reason, plus `payloadPurged` so support can answer
   "can you see what the provider actually sent?" honestly. The raw body is
   PII under the Q6 retention policy; a support endpoint that returned it
   would make that policy decorative.

## What remains, and where it belongs

| Work | Owner |
|---|---|
| Staff identity: subject attribute, signed claim, grant/revoke audit | Platform, its own design |
| `api-edge` facade for `admin-worker`, stripping any client-supplied `x-support-role` | Platform, after the above |
| Console admin route group rendering this payload with the merchant's own explainer | nexus follow-on, one page |

The last row is genuinely small once the first two exist — the payload is
already shaped for it and `DeterminationExplainer` already takes a
determination and a rule and renders them. That is the point of having built
the capability first: the surface is a page, not a project.

**The honest summary:** support can answer "why does my board say this" today
via an audited internal call. They cannot yet do it from a browser, and the
reason is a missing platform primitive rather than missing nexus work.
