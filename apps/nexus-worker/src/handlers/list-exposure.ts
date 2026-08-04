// GET /v1/organizations/:orgId/nexus/exposure — the board.
//
// One card per jurisdiction that has a rule, assembled from the newest
// determination plus the rule in force plus any registration. A jurisdiction
// with a rule but no determination yet is still a card: an absent card reads
// as "we are not watching", which is the opposite of the product.

import type { PublicJurisdictionExposure, ThresholdLogic } from "@saas/contracts/nexus";
import type { NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createTimings } from "@saas/contracts/timing";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse, withTimings } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { toPublicRuleSet } from "../mappers.js";
import { determinationPublicId } from "../ids.js";
import { isEvaluable, jurisdictionName } from "../jurisdictions.js";
import { evaluateThreshold } from "../engine/threshold.js";
import { checkBillingEntitlement } from "../billing-client.js";
import {
  JURISDICTIONS_LIMIT_KEY,
  monitoredLimitFrom,
  splitByLimit,
} from "../entitlements.js";
import { orgPublicId } from "../ids.js";

export interface HandleListExposureDeps {
  repo?: NexusRepository;
  /** Test seam. Defaults to the real billing service-binding call. */
  checkEntitlement?: typeof checkBillingEntitlement;
}

export async function handleListExposure(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListExposureDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.nexus.read");
  if (!gate.ok) return gate.response;

  const timings = createTimings();
  const endTotal = timings.start("total");
  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);

    const ruleSetResult = await timings.measure("ruleset", () => repo.getCurrentRuleSet());
    if (!ruleSetResult.ok) {
      endTotal();
      // No rule set published: report it as a precondition, not as an empty
      // board. An empty board says "you are clear", which is a claim we have
      // no basis to make.
      return withTimings(
        errorResponse(
          "precondition_failed",
          "No rule set is published for this environment",
          412,
          requestId,
          { reason: "no_rule_set" },
        ),
        requestId,
        "nexus.exposure",
        timings,
      );
    }
    const ruleSet = ruleSetResult.value;

    const onDate = new Date().toISOString().slice(0, 10);
    const [rulesResult, determinationsResult, registrationsResult, activeResult] =
      await Promise.all([
        timings.measure("rules", () => repo.listRulesInForce(asUuid(ruleSet.id), onDate)),
        timings.measure("determinations", () => repo.listCurrentDeterminations(orgId)),
        timings.measure("registrations", () => repo.listRegistrations(orgId)),
        // Seniority order — the repository returns these sorted, and the plan
        // split depends on that order being stable (see `entitlements.ts`).
        timings.measure("active", () => repo.listActiveJurisdictions(orgId)),
      ]);

    if (!rulesResult.ok || !determinationsResult.ok || !registrationsResult.ok) {
      endTotal();
      return withTimings(
        errorResponse("internal_error", "Service unavailable", 503, requestId),
        requestId,
        "nexus.exposure",
        timings,
      );
    }

    // The plan limit (design §9). A billing failure yields null — unlimited —
    // because a billing outage must not silently stop monitoring a seller's
    // tax exposure. Deliberately the opposite of how the authorization gate
    // fails; see `entitlements.ts` for why the two differ.
    const entitlement = env.BILLING_WORKER
      ? await timings.measure("entitlement", () =>
          (deps?.checkEntitlement ?? checkBillingEntitlement)(
            env.BILLING_WORKER!,
            orgPublicId(orgId),
            JURISDICTIONS_LIMIT_KEY,
            requestId,
          ),
        )
      : null;
    const monitoredLimit = monitoredLimitFrom(
      entitlement && entitlement.kind === "decision" ? entitlement.decision : null,
    );
    const split = splitByLimit(activeResult.ok ? activeResult.value : [], monitoredLimit);
    const lockedSet = new Set(split.locked);

    const determinations = new Map(determinationsResult.value.map((d) => [d.jurisdiction, d]));
    const registrations = new Map(
      registrationsResult.value
        .filter((r) => r.status !== "closed")
        .map((r) => [r.jurisdiction, r]),
    );

    const exposure: PublicJurisdictionExposure[] = rulesResult.value
      .filter((rule) => isEvaluable(rule.jurisdiction))
      .map((rule) => {
        const locked = lockedSet.has(rule.jurisdiction);
        // A locked card carries no measurement at all. Passing the stored
        // determination through and merely flagging it would leak the answer
        // the plan does not include, and would also go stale silently once
        // evaluation stops covering this jurisdiction.
        const determination = locked ? null : (determinations.get(rule.jurisdiction) ?? null);
        const registration = registrations.get(rule.jurisdiction) ?? null;

        // A registered seller's card says "registered" over whatever the
        // measurement says. That is a board projection, not an engine output —
        // the engine is pure and knows nothing about registrations (NX1.5
        // finding S-7).
        const status =
          registration?.status === "active"
            ? "registered"
            : (determination?.status ?? (rule.thresholdLogic === "none" ? "no_obligation" : "clear"));

        return {
          jurisdiction: rule.jurisdiction,
          jurisdictionName: jurisdictionName(rule.jurisdiction),
          status,
          measuredSalesCents: determination?.measuredSalesCents ?? 0,
          measuredTransactions: determination?.measuredTransactions ?? 0,
          thresholdSalesCents: rule.thresholdLogic === "none" ? null : rule.salesThresholdCents,
          thresholdTransactions: rule.thresholdLogic === "none" ? null : rule.transactionThreshold,
          fractionOfThreshold: fractionFor(determination, rule),
          periodStart: determination?.periodStart.toISOString() ?? "",
          periodEnd: determination?.periodEnd.toISOString() ?? "",
          measurementBasis: rule.measurementBasis,
          measurementPeriod: rule.measurementPeriod,
          marketplaceTreatment: rule.marketplaceTreatment,
          thresholdLogic: rule.thresholdLogic,
          crossedOn: determination?.crossedOn ?? null,
          registrationDueOn: determination?.registrationDueOn ?? null,
          registrationStatus: registration?.status ?? null,
          determinationId: determination ? determinationPublicId(determination.id) : null,
          evaluatedAt: determination?.evaluatedAt.toISOString() ?? null,
          ruleSetVersion: ruleSet.version,
          ruleSetVerified: ruleSet.verified,
          locked,
        };
      });

    endTotal();
    return withTimings(
      successResponse(
        { exposure, ruleSet: toPublicRuleSet(ruleSet), monitoredLimit },
        requestId,
      ),
      requestId,
      "nexus.exposure",
      timings,
    );
  } catch {
    endTotal();
    return withTimings(
      errorResponse("internal_error", "Service unavailable", 503, requestId),
      requestId,
      "nexus.exposure",
      timings,
    );
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * The meter's fill.
 *
 * Delegates to the engine rather than recomputing. The first draft of this
 * function reimplemented the max-under-`either`/min-under-`both` rule locally
 * with a comment promising the two copies would agree — which is a promise, and
 * this is a product that sells against promises. The engine is pure and
 * synchronous, so calling it costs nothing and there is exactly one definition
 * of what the meter means.
 *
 * Null when there is nothing to be a fraction of — `threshold_logic = 'none'`,
 * or no determination yet. A null renders as "out of scope" or "not yet
 * evaluated"; it must never render as 0%, which reads as "measured, and
 * nowhere near the line".
 */
function fractionFor(
  determination: { measuredSalesCents: number; measuredTransactions: number } | null,
  rule: {
    thresholdLogic: ThresholdLogic;
    salesThresholdCents: number | null;
    transactionThreshold: number | null;
  },
): number | null {
  if (rule.thresholdLogic === "none" || !determination) return null;
  try {
    return evaluateThreshold(
      {
        salesCents: determination.measuredSalesCents,
        transactions: determination.measuredTransactions,
      },
      rule,
    ).fractionOfThreshold;
  } catch {
    // A rule that names a test it carries no threshold for is unwritable
    // (`nexus_rules_threshold_logic_ck`), so this is unreachable — but a board
    // that 500s because one card cannot compute a meter is worse than a board
    // with one blank meter.
    return null;
  }
}
