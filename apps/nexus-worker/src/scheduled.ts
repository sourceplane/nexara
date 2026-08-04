// The hourly evaluation job (design §8).
//
// Runs at `7 * * * *` — offset from `metering-worker`'s `5 * * * *` so the two
// do not contend for the same Hyperdrive pool at the top of the hour.
//
// The whole job is:
//
//   1. list orgs with ledger activity since their watermark;
//   2. for each, run `evaluateOrg` — the SAME function the `POST /evaluate`
//      handler runs, so a support question is always answerable by pressing
//      the button;
//   3. raise alerts for the transitions it produced;
//   4. advance the watermark.
//
// It is deliberately boring. The interesting parts — grouping by window,
// change detection, the exactly-once alert — all live in modules that a test
// can drive without a scheduler.

import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db/ids";
import type { NexusRepository } from "@saas/db/nexus";

import type { Env } from "./env.js";
import { evaluateOrg } from "./evaluation.js";
import { raiseAlerts } from "./alerts.js";

/**
 * Orgs evaluated per tick.
 *
 * A ceiling rather than "all of them": a Worker invocation has a wall-clock
 * budget, and an unbounded loop would starve the tail forever once the tenant
 * count outgrew one tick. The watermark makes the bound safe — orgs are
 * ordered by oldest unseen work, so the ones skipped this hour are the ones
 * picked up first next hour.
 */
const MAX_ORGS_PER_TICK = 100;

export interface EvaluationTickSummary {
  orgsConsidered: number;
  orgsEvaluated: number;
  determinationsWritten: number;
  alertsRaised: number;
  notificationsEnqueued: number;
  alertsSuppressedUnverified: number;
  alertsWithoutRecipient: number;
  failures: number;
}

export async function runEvaluationTick(
  repo: NexusRepository,
  env: Env,
  now: Date,
  requestId: string,
): Promise<EvaluationTickSummary> {
  const summary: EvaluationTickSummary = {
    orgsConsidered: 0,
    orgsEvaluated: 0,
    determinationsWritten: 0,
    alertsRaised: 0,
    notificationsEnqueued: 0,
    alertsSuppressedUnverified: 0,
    alertsWithoutRecipient: 0,
    failures: 0,
  };

  const activity = await repo.listOrgsWithActivity(MAX_ORGS_PER_TICK);
  if (!activity.ok) {
    summary.failures += 1;
    return summary;
  }
  summary.orgsConsidered = activity.value.length;

  for (const { orgId, maxIngestedAt } of activity.value) {
    // One org's failure must not stop the others. A tenant with a corrupt row
    // should not silently freeze every other tenant's monitoring — which is
    // exactly the kind of shared-fate bug that goes unnoticed because the
    // symptom is *absence*.
    try {
      const result = await evaluateOrg(repo, asUuid(orgId), now);
      if (!result.ok) {
        // A missing rule set is not a failure of this org — it is an
        // environment that has published none, and every org will report it.
        if (result.reason !== "no_rule_set") summary.failures += 1;
        continue;
      }

      summary.orgsEvaluated += 1;
      summary.determinationsWritten += result.value.written.length;

      const alerts = await raiseAlerts(
        repo,
        env,
        asUuid(orgId),
        result.value.transitions,
        result.value.ruleSet.verified,
        requestId,
        now,
      );
      summary.alertsRaised += alerts.alertsRaised;
      summary.notificationsEnqueued += alerts.notificationsEnqueued;
      summary.alertsSuppressedUnverified += alerts.suppressedUnverified;
      summary.alertsWithoutRecipient += alerts.missingRecipient;

      // Advanced only after alerts, so a crash between the determination and
      // the alert re-runs both next hour. The alert's unique index makes that
      // re-run free, which is the whole reason the guarantee is a constraint
      // and not a lock.
      await repo.setWatermark(asUuid(orgId), maxIngestedAt, now);
    } catch {
      summary.failures += 1;
    }
  }

  return summary;
}

export async function handleScheduled(env: Env, now: Date): Promise<EvaluationTickSummary | null> {
  if (!env.PLATFORM_DB) return null;

  const requestId = `cron_${now.toISOString()}`;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const summary = await runEvaluationTick(createNexusRepository(executor), env, now, requestId);

    // Design §12: several of this product's failure modes are silent, so the
    // tick reports the counts that would otherwise only be visible by
    // querying. `alertsSuppressedUnverified` non-zero is EXPECTED while the
    // rule set is unverified; `alertsWithoutRecipient` non-zero means a
    // threshold moved and nobody was told. Ids and counts only — never a
    // payload.
    if (
      summary.determinationsWritten > 0 ||
      summary.failures > 0 ||
      summary.alertsWithoutRecipient > 0
    ) {
      console.warn(JSON.stringify({ level: "info", msg: "nexus.evaluation_tick", ...summary }));
    }
    return summary;
  } finally {
    await executor.dispose();
  }
}
