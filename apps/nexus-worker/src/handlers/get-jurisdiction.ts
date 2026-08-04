// GET /v1/organizations/:orgId/nexus/jurisdictions/:code
//
// The screen behind the board card, and the one that has to hold up when a
// seller asks "why does it say that". It returns the rule in force, the
// current position, the determination history, and any registration — the raw
// material for NX8's `determination-explainer`, which is the visual proof of
// invariant 3.

import type { GetJurisdictionResponse } from "@saas/contracts/nexus";
import type { NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import {
  toPublicDetermination,
  toPublicRegistration,
  toPublicRule,
} from "../mappers.js";
import { jurisdictionName } from "../jurisdictions.js";
import { evaluateThreshold } from "../engine/threshold.js";
import { determinationPublicId } from "../ids.js";

const HISTORY_LIMIT = 50;

export interface HandleGetJurisdictionDeps {
  repo?: NexusRepository;
}

export async function handleGetJurisdiction(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  code: string,
  deps?: HandleGetJurisdictionDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.nexus.read");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);

    const ruleSetResult = await repo.getCurrentRuleSet();
    if (!ruleSetResult.ok) {
      return errorResponse(
        "precondition_failed",
        "No rule set is published for this environment",
        412,
        requestId,
        { reason: "no_rule_set" },
      );
    }
    const ruleSet = ruleSetResult.value;

    const rulesResult = await repo.listRulesInForce(
      asUuid(ruleSet.id),
      new Date().toISOString().slice(0, 10),
    );
    if (!rulesResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const rule = rulesResult.value.find((r) => r.jurisdiction === code);
    if (!rule) {
      // An unknown jurisdiction is a 404, not an empty card. A blank card for
      // a code we have no rule for is indistinguishable from "clear", and
      // those are very different statements.
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const [historyResult, registrationsResult] = await Promise.all([
      repo.listDeterminationsPaged(orgId, code, { limit: HISTORY_LIMIT, cursor: null }),
      repo.listRegistrations(orgId),
    ]);
    if (!historyResult.ok || !registrationsResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const history = historyResult.value.items;
    const current = history[0] ?? null;
    const registration =
      registrationsResult.value.find((r) => r.jurisdiction === code && r.status !== "closed") ?? null;

    const status =
      registration?.status === "active"
        ? "registered"
        : (current?.status ?? (rule.thresholdLogic === "none" ? "no_obligation" : "clear"));

    let fractionOfThreshold: number | null = null;
    if (current && rule.thresholdLogic !== "none") {
      try {
        fractionOfThreshold = evaluateThreshold(
          { salesCents: current.measuredSalesCents, transactions: current.measuredTransactions },
          rule,
        ).fractionOfThreshold;
      } catch {
        fractionOfThreshold = null;
      }
    }

    const response: GetJurisdictionResponse = {
      exposure: {
        jurisdiction: code,
        jurisdictionName: jurisdictionName(code),
        status,
        measuredSalesCents: current?.measuredSalesCents ?? 0,
        measuredTransactions: current?.measuredTransactions ?? 0,
        thresholdSalesCents: rule.thresholdLogic === "none" ? null : rule.salesThresholdCents,
        thresholdTransactions: rule.thresholdLogic === "none" ? null : rule.transactionThreshold,
        fractionOfThreshold,
        periodStart: current?.periodStart.toISOString() ?? "",
        periodEnd: current?.periodEnd.toISOString() ?? "",
        measurementBasis: rule.measurementBasis,
        measurementPeriod: rule.measurementPeriod,
        marketplaceTreatment: rule.marketplaceTreatment,
        thresholdLogic: rule.thresholdLogic,
        crossedOn: current?.crossedOn ?? null,
        registrationDueOn: current?.registrationDueOn ?? null,
        registrationStatus: registration?.status ?? null,
        determinationId: current ? determinationPublicId(current.id) : null,
        evaluatedAt: current?.evaluatedAt.toISOString() ?? null,
        ruleSetVersion: ruleSet.version,
        ruleSetVerified: ruleSet.verified,
        // The detail view is reachable only for a jurisdiction with a rule,
        // and it renders the determination history it already has. The plan
        // limit is a *board* projection — a seller who deep-links to a locked
        // jurisdiction sees the same empty history the board's lock implies,
        // rather than a second, differently-worded denial.
        locked: false,
      },
      rule: toPublicRule(rule),
      determinations: history.map(toPublicDetermination),
      registration: registration ? toPublicRegistration(registration) : null,
    };

    return successResponse(response, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
