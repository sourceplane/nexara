// Threshold alerting.
//
// Design §8 step 5: on a `clear → approaching` or `* → crossed` transition,
// insert `nexus.alerts` — the unique index makes this exactly-once — and
// enqueue the notification.
//
// Three properties, each of which would be a bug if it were absent:
//
//   1. **Exactly once, even if the cron double-fires.** The guarantee is
//      `nexus_alerts_once_idx`, a database constraint. It is cheaper than a
//      distributed lock and, unlike a lock with a TTL, it is correct under
//      concurrency. A null return from the insert means "already sent", which
//      is the success path on a second firing.
//   2. **Nothing is sent from an unverified rule set.** Design §11's gate is
//      enforced here, in the engine's caller, and not in the UI. A merchant
//      receiving an email that says they crossed a threshold has been told a
//      compliance conclusion; from an unverified rule set we have no basis to
//      tell them that, and a banner in a console they may not open is not a
//      substitute for not sending it.
//   3. **The alert row is written BEFORE the notification is enqueued.** If
//      the notification fails, the row still exists and the alert is not
//      retried into a duplicate email. Losing an email is recoverable; sending
//      a seller five copies of "you have crossed a tax threshold" is not.

import {
  buildIdempotencyKey,
  enqueueNotification,
} from "@saas/notifications-client";
import type { DeterminationRow, NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";

import type { Env } from "./env.js";
import type { Transition } from "./evaluation.js";
import { emitNexusEvent } from "./events-client.js";
import { determinationPublicId, orgPublicId } from "./ids.js";
import { jurisdictionName } from "./jurisdictions.js";

export interface AlertSummary {
  /** Alert rows written. A second run over the same determinations writes 0. */
  alertsRaised: number;
  /** Notifications successfully enqueued. Never exceeds `alertsRaised`. */
  notificationsEnqueued: number;
  /** Transitions suppressed because the rule set is unverified (§11). */
  suppressedUnverified: number;
  /** Alerts raised with no configured recipient — recorded, not silent. */
  missingRecipient: number;
}

/** Which transitions are worth telling a seller about. */
export function alertKindFor(transition: Transition): "approaching" | "crossed" | null {
  if (transition.to === "crossed") return "crossed";
  // Only the FIRST approach. A position oscillating around 80% across hourly
  // evaluations would otherwise mail the seller every hour, and an alert that
  // arrives every hour stops being an alert.
  if (transition.to === "approaching" && transition.from !== "crossed") return "approaching";
  return null;
}

/**
 * The seller's named tax contact, or the environment default, or null.
 *
 * A repository failure is treated as "no contact" rather than propagated: an
 * alert with no email still writes its row, emits its event, and records
 * `no_recipient_configured`, which is a recoverable and *queryable* outcome.
 * Aborting the tick over a lookup would suppress the determination as well,
 * which is not.
 */
async function resolveRecipient(
  repo: NexusRepository,
  env: Env,
  orgId: Uuid,
): Promise<string | null> {
  const contact = await repo.getAlertContact(orgId);
  if (contact.ok && contact.value) return contact.value.email.trim().toLowerCase();
  const fallback = env.NEXUS_ALERT_EMAIL?.trim().toLowerCase();
  return fallback ? fallback : null;
}

export async function raiseAlerts(
  repo: NexusRepository,
  env: Env,
  orgId: Uuid,
  transitions: readonly Transition[],
  ruleSetVerified: boolean,
  requestId: string,
  now: Date,
): Promise<AlertSummary> {
  const summary: AlertSummary = {
    alertsRaised: 0,
    notificationsEnqueued: 0,
    suppressedUnverified: 0,
    missingRecipient: 0,
  };

  // Resolved ONCE per org rather than per transition: a seller crossing four
  // states in one tick should not cost four identical lookups, and the
  // recipient cannot meaningfully change mid-tick.
  //
  // The seller's own tax contact wins over the environment default (R10). The
  // default remains as a floor rather than being removed with this milestone:
  // an org that has not named a contact yet is exactly the org that has just
  // started trading, which is exactly the org about to cross its first
  // threshold. Silence there is the failure this whole path exists to avoid.
  const recipientEmail = await resolveRecipient(repo, env, orgId);

  for (const transition of transitions) {
    const kind = alertKindFor(transition);
    if (kind === null) continue;

    // The event goes out regardless of verification: the audit log records
    // what the system determined, and suppressing that would leave a hole in
    // the history exactly where a dispute would look.
    await emitDeterminationEvent(env, orgId, transition, requestId, now);

    if (!ruleSetVerified) {
      summary.suppressedUnverified += 1;
      continue;
    }

    // The alert row is written BEFORE the notification is enqueued. If the
    // notification fails, the row still exists and the alert is not retried
    // into a duplicate email: losing an email is recoverable, sending a seller
    // five copies of "you have crossed a tax threshold" is not.
    //
    // `notification_ref` records the outcome, including the absence of a
    // recipient — so "no email went out" is a queryable fact rather than
    // something you discover from a support ticket.
    const alert = await repo.insertAlertOnce(orgId, {
      id: crypto.randomUUID(),
      jurisdiction: transition.jurisdiction,
      determinationId: transition.determination.id as Uuid,
      kind,
      sentAt: now,
      notificationRef: recipientEmail ? null : "no_recipient_configured",
    });

    // `ok: true, value: null` is "already sent" — the unique index did its
    // job on a re-run — and is not an error.
    if (!alert.ok || alert.value === null) continue;
    summary.alertsRaised += 1;

    if (!recipientEmail) {
      summary.missingRecipient += 1;
      continue;
    }

    const enqueued = await enqueueNotification(
      env,
      {
        internalActor: "nexus-worker",
        actorSubjectType: "system",
        actorSubjectId: "nexus-worker",
        requestId,
      },
      {
        orgId: orgPublicId(orgId),
        // "product": a threshold alert is a statement about the seller's own
        // data, not a security or billing event. The contract's category list
        // is closed and this is the honest member of it.
        category: "product",
        templateKey: kind === "crossed" ? "nexus.threshold_crossed" : "nexus.threshold_approaching",
        // Scoped by the determination id, so two different crossings in the
        // same jurisdiction are two different messages and a re-evaluation of
        // the same one is not.
        idempotencyKey: buildIdempotencyKey(
          "nexus.alert",
          orgPublicId(orgId),
          transition.jurisdiction,
          determinationPublicId(transition.determination.id),
          kind,
        ),
        templateData: templateDataFor(kind, transition),
        recipient: { channel: "email", address: recipientEmail },
      },
    );
    if (enqueued.ok) summary.notificationsEnqueued += 1;
  }

  return summary;
}

/**
 * Redaction-safe template data.
 *
 * Integer cents and codes only — no customer names, no addresses, no ledger
 * rows. The email tells a seller *that* a line moved and where to look; the
 * numbers behind it live in the console, behind their session.
 */
function templateDataFor(
  kind: "approaching" | "crossed",
  transition: Transition,
): Record<string, string> {
  const d: DeterminationRow = transition.determination;
  return {
    jurisdiction: transition.jurisdiction,
    jurisdictionName: jurisdictionName(transition.jurisdiction),
    status: kind,
    measuredSalesCents: String(d.measuredSalesCents),
    measuredTransactions: String(d.measuredTransactions),
    thresholdSalesCents: d.thresholdSalesCents === null ? "" : String(d.thresholdSalesCents),
    thresholdTransactions: d.thresholdTransactions === null ? "" : String(d.thresholdTransactions),
    periodStart: d.periodStart.toISOString(),
    periodEnd: d.periodEnd.toISOString(),
    crossedOn: d.crossedOn ?? "",
    registrationDueOn: d.registrationDueOn ?? "",
    ruleSetVersion: d.ruleSetVersion,
    determinationId: determinationPublicId(d.id),
  };
}

async function emitDeterminationEvent(
  env: Env,
  orgId: Uuid,
  transition: Transition,
  requestId: string,
  now: Date,
): Promise<void> {
  const d = transition.determination;
  const payload = {
    jurisdiction: transition.jurisdiction,
    from: transition.from,
    to: transition.to,
    determinationId: determinationPublicId(d.id),
    measuredSalesCents: d.measuredSalesCents,
    measuredTransactions: d.measuredTransactions,
    thresholdSalesCents: d.thresholdSalesCents,
    thresholdTransactions: d.thresholdTransactions,
    periodStart: d.periodStart.toISOString(),
    periodEnd: d.periodEnd.toISOString(),
    crossedOn: d.crossedOn,
    registrationDueOn: d.registrationDueOn,
    // The reproducibility triple travels with the event, so a seller's own
    // system receiving the webhook can re-derive the answer without calling
    // us back.
    ruleSetVersion: d.ruleSetVersion,
    engineVersion: d.engineVersion,
    internalOnly: d.internalOnly,
  };

  await emitNexusEvent(env, {
    type: "nexus.determination.created",
    orgId: orgPublicId(orgId),
    subjectKind: "determination",
    subjectId: determinationPublicId(d.id),
    requestId,
    occurredAt: now,
    description: `${transition.jurisdiction} moved ${transition.from ?? "unknown"} → ${transition.to}`,
    payload,
  });

  if (transition.to === "crossed") {
    // The subscribable outgoing webhook type. Emitting it here IS the
    // registration — `webhooks-worker` fans out every event type on the log.
    await emitNexusEvent(env, {
      type: "nexus.threshold.crossed",
      orgId: orgPublicId(orgId),
      subjectKind: "determination",
      subjectId: determinationPublicId(d.id),
      requestId,
      occurredAt: now,
      description: `Economic-nexus threshold crossed in ${transition.jurisdiction}`,
      payload,
    });
  } else if (transition.to === "approaching") {
    await emitNexusEvent(env, {
      type: "nexus.threshold.approaching",
      orgId: orgPublicId(orgId),
      subjectKind: "determination",
      subjectId: determinationPublicId(d.id),
      requestId,
      occurredAt: now,
      description: `Approaching the economic-nexus threshold in ${transition.jurisdiction}`,
      payload,
    });
  }
}
