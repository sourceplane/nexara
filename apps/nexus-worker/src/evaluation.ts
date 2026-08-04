// Evaluating one tenant's position, once.
//
// This is the orchestration between the repository and the pure engine, and it
// is deliberately its own module rather than a handler: the `POST /evaluate`
// handler and NX5's hourly cron must run *identically*, and a cron that
// re-implements a handler is how the two drift until a support question can no
// longer be answered by pressing the button.
//
// It reads the clock nowhere. `asOf` is a parameter, exactly as in the engine,
// so a test can evaluate a fixed instant and a replay can evaluate a past one.
//
// The order of operations is design §8, steps 2–4:
//
//   1. resolve the rule set and the rules in force;
//   2. group jurisdictions by measurement window — ONE aggregate query per
//      distinct window, never one per jurisdiction (design §5.2);
//   3. run the pure engine per (jurisdiction, rule);
//   4. write a determination only when the status or the measured value
//      changed (design §8 step 4, R5).

import type {
  DeterminationInputs,
  JurisdictionAggregate,
  Rule,
} from "@saas/contracts/nexus";
import type {
  DeterminationRow,
  NexusRepository,
  RuleRow,
  RuleSetRow,
} from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";

import {
  ENGINE_VERSION,
  dateInZone,
  evaluate,
  evaluateSegmented,
  groupByWindow,
  windowFor,
} from "./engine/index.js";
import { emptyAggregate } from "./engine/measure.js";
import { isEvaluable } from "./jurisdictions.js";
import { rulePublicId } from "./ids.js";

export interface EvaluationOutcome {
  evaluatedAt: Date;
  ruleSet: RuleSetRow;
  /** Jurisdictions the engine ran on, including unchanged positions. */
  evaluated: number;
  /** Rows actually written — only changed positions produce one. */
  written: DeterminationRow[];
  /** Positions that transitioned, for NX5's alerting. */
  transitions: Transition[];
}

export interface Transition {
  jurisdiction: string;
  from: string | null;
  to: string;
  determination: DeterminationRow;
}

export interface EvaluateOrgOptions {
  /** Restrict to these jurisdictions; omit for every jurisdiction with a rule. */
  jurisdictions?: readonly string[];
  /** Fraction of the threshold at which `approaching` begins. */
  approachingFraction?: number;
}

export type EvaluationResult =
  | { ok: true; value: EvaluationOutcome }
  | { ok: false; reason: "no_rule_set" | "repository_error"; message: string };

export async function evaluateOrg(
  repo: NexusRepository,
  orgId: Uuid,
  asOf: Date,
  options: EvaluateOrgOptions = {},
): Promise<EvaluationResult> {
  const ruleSetResult = await repo.getCurrentRuleSet();
  if (!ruleSetResult.ok) {
    // No rule set is not an internal error — it is a correctly-reported
    // "nothing to measure against", and the console renders it as such rather
    // than as a board of zeroes. A board of zeroes would say "you are clear",
    // which is precisely the claim we have no basis to make.
    return { ok: false, reason: "no_rule_set", message: "No rule set is published" };
  }
  const ruleSet = ruleSetResult.value;

  // The rule set's own date, not the caller's timezone: which rules are in
  // force is a property of the calendar, and using a UTC date here is correct
  // because `effective_from` is itself a plain DATE.
  const onDate = asOf.toISOString().slice(0, 10);
  const rulesResult = await repo.listRulesInForce(asUuid(ruleSet.id), onDate);
  if (!rulesResult.ok) {
    return { ok: false, reason: "repository_error", message: "Failed to load rules" };
  }

  // International VAT/GST rows live in the same table and are display-only in
  // v1 (design §3.3). The filter is here, in one place, which is what makes
  // the scope boundary enforceable rather than aspirational.
  let rules = rulesResult.value.filter((r) => isEvaluable(r.jurisdiction));
  if (options.jurisdictions && options.jurisdictions.length > 0) {
    const wanted = new Set(options.jurisdictions);
    rules = rules.filter((r) => wanted.has(r.jurisdiction));
  }

  if (rules.length === 0) {
    return {
      ok: true,
      value: { evaluatedAt: asOf, ruleSet, evaluated: 0, written: [], transitions: [] },
    };
  }

  // Design §5.2 — one query per distinct window. Jurisdictions sharing a
  // measurement period AND a timezone share a window exactly, so forty-eight
  // states collapse to a handful of queries. A per-jurisdiction loop is the
  // obvious wrong answer and this is where it would have gone.
  const groups = groupByWindow(rules, asOf);
  const aggregates = new Map<string, JurisdictionAggregate>();
  const windows = new Map<string, { start: string; end: string; startDate: string; endDate: string }>();

  for (const group of groups) {
    const codes = group.rules.map((r) => r.jurisdiction);
    const aggResult = await repo.aggregateByJurisdiction(
      orgId,
      { start: new Date(group.window.start), end: new Date(group.window.end) },
      codes,
    );
    if (!aggResult.ok) {
      return { ok: false, reason: "repository_error", message: "Failed to aggregate ledger" };
    }
    for (const row of aggResult.value) {
      aggregates.set(`${row.jurisdiction}|${group.key}`, row);
    }
    for (const code of codes) {
      windows.set(code, group.window);
    }
  }

  const currentResult = await repo.listCurrentDeterminations(orgId);
  if (!currentResult.ok) {
    return { ok: false, reason: "repository_error", message: "Failed to read current positions" };
  }
  const current = new Map(currentResult.value.map((d) => [d.jurisdiction, d]));

  const written: DeterminationRow[] = [];
  const transitions: Transition[] = [];

  for (const group of groups) {
    for (const ruleRow of group.rules) {
      const window = group.window;
      const aggregate =
        aggregates.get(`${ruleRow.jurisdiction}|${group.key}`) ??
        // A jurisdiction with no rows in the window still gets a card. An
        // absent card reads as "we are not watching", which is the opposite
        // of the product.
        emptyAggregate(ruleRow.jurisdiction);

      const inputs: DeterminationInputs = {
        asOf: asOf.toISOString(),
        window,
        aggregate,
        approachingFraction: options.approachingFraction ?? 0.8,
      };

      const rule = toEngineRule(ruleRow, ruleSet.version);
      const outcome = evaluate(inputs, rule);

      const previous = current.get(ruleRow.jurisdiction) ?? null;
      if (!hasChanged(previous, outcome.status, outcome.measuredSalesCents, outcome.measuredTransactions)) {
        continue;
      }

      // §11: no CUSTOMER-FACING determination may be produced from an
      // unverified rule set. The determination is still written — it is
      // internal evidence, and suppressing it would leave a gap in the
      // history — but `internal_only` carries the gate, denormalised so it
      // reads correctly even after the rule set is later verified.
      const insert = await repo.insertDetermination(orgId, {
        id: crypto.randomUUID(),
        jurisdiction: ruleRow.jurisdiction,
        evaluatedAt: asOf,
        ruleSetVersion: ruleSet.version,
        ruleId: asUuid(ruleRow.id),
        engineVersion: ENGINE_VERSION,
        periodStart: new Date(window.start),
        periodEnd: new Date(window.end),
        measuredSalesCents: outcome.measuredSalesCents,
        measuredTransactions: outcome.measuredTransactions,
        thresholdSalesCents: outcome.thresholdSalesCents,
        thresholdTransactions: outcome.thresholdTransactions,
        status: outcome.status,
        crossedOn: outcome.crossedOn,
        registrationDueOn: outcome.registrationDueOn,
        inputs: inputs as unknown as Record<string, unknown>,
        internalOnly: !ruleSet.verified,
      });
      if (!insert.ok) {
        return { ok: false, reason: "repository_error", message: "Failed to write determination" };
      }

      written.push(insert.value);
      if (previous?.status !== outcome.status) {
        transitions.push({
          jurisdiction: ruleRow.jurisdiction,
          from: previous?.status ?? null,
          to: outcome.status,
          determination: insert.value,
        });
      }
    }
  }

  return {
    ok: true,
    value: {
      evaluatedAt: asOf,
      ruleSet,
      evaluated: rules.length,
      written,
      transitions,
    },
  };
}

/**
 * Design §8 step 4 — write only when the position moved.
 *
 * Without this, forty-eight jurisdictions × hourly evaluation × N tenants adds
 * forty-eight rows an hour per tenant forever and the history stops being
 * readable. That is a **correctness requirement for the history view**, not an
 * optimisation (R5), which is why it is a named function with a test rather
 * than an early `return` inside the loop.
 */
export function hasChanged(
  previous: Pick<
    DeterminationRow,
    "status" | "measuredSalesCents" | "measuredTransactions"
  > | null,
  status: string,
  measuredSalesCents: number,
  measuredTransactions: number,
): boolean {
  if (previous === null) return true;
  return (
    previous.status !== status ||
    previous.measuredSalesCents !== measuredSalesCents ||
    previous.measuredTransactions !== measuredTransactions
  );
}

/** A repository rule row → the engine's `Rule`. The public id is used because
 *  the engine's output is quoted back to a customer, and a raw UUID is not. */
export function toEngineRule(row: RuleRow, ruleSetVersion: string): Rule {
  return {
    id: rulePublicId(row.id),
    ruleSetId: row.ruleSetId,
    ruleSetVersion: row.ruleSetVersion || ruleSetVersion,
    jurisdiction: row.jurisdiction,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    measurementBasis: row.measurementBasis,
    measurementPeriod: row.measurementPeriod,
    measurementTimezone: row.measurementTimezone,
    salesThresholdCents: row.salesThresholdCents,
    transactionThreshold: row.transactionThreshold,
    thresholdLogic: row.thresholdLogic,
    marketplaceTreatment: row.marketplaceTreatment,
    registrationDeadlineRule: row.registrationDeadlineRule as unknown as Rule["registrationDeadlineRule"],
    notes: row.notes,
  };
}

/**
 * Evaluate one jurisdiction whose window contains a rule change (design §5.3
 * case 3).
 *
 * Exported and used by the jurisdiction-detail read rather than by the batch
 * evaluator: a rule change is rare enough that paying two extra queries for it
 * on a single-jurisdiction read is free, and paying them for all forty-eight
 * on every cron tick is not. When `listRulesOverlapping` returns one row this
 * degenerates to `evaluate`, so the caller does not branch.
 */
export async function evaluateJurisdictionSegmented(
  repo: NexusRepository,
  orgId: Uuid,
  jurisdiction: string,
  ruleSet: RuleSetRow,
  asOf: Date,
  approachingFraction = 0.8,
): Promise<
  | { ok: true; rules: RuleRow[]; inputs: DeterminationInputs; outcome: ReturnType<typeof evaluate> }
  | { ok: false; reason: "no_rule" | "repository_error" }
> {
  const rulesResult = await repo.listRulesInForce(
    asUuid(ruleSet.id),
    asOf.toISOString().slice(0, 10),
  );
  if (!rulesResult.ok) return { ok: false, reason: "repository_error" };
  const inForce = rulesResult.value.find((r) => r.jurisdiction === jurisdiction);
  if (!inForce) return { ok: false, reason: "no_rule" };

  const window = windowFor(inForce.measurementPeriod, asOf, inForce.measurementTimezone);

  const overlappingResult = await repo.listRulesOverlapping(
    asUuid(ruleSet.id),
    jurisdiction,
    window.startDate,
    window.endDate,
  );
  const overlapping = overlappingResult.ok ? overlappingResult.value : [inForce];

  if (overlapping.length <= 1) {
    const aggResult = await repo.aggregateByJurisdiction(
      orgId,
      { start: new Date(window.start), end: new Date(window.end) },
      [jurisdiction],
    );
    if (!aggResult.ok) return { ok: false, reason: "repository_error" };
    const inputs: DeterminationInputs = {
      asOf: asOf.toISOString(),
      window,
      aggregate: aggResult.value[0] ?? emptyAggregate(jurisdiction),
      approachingFraction,
    };
    return {
      ok: true,
      rules: [inForce],
      inputs,
      outcome: evaluate(inputs, toEngineRule(inForce, ruleSet.version)),
    };
  }

  // The window is split at each rule boundary and each segment is measured
  // under its own rule. Segment bounds are clamped to the window, so the first
  // segment starts at the window start rather than at a rule's effective date
  // that predates it.
  const zone = inForce.measurementTimezone;
  const segments: Array<{ rule: Rule; inputs: DeterminationInputs }> = [];
  for (let i = 0; i < overlapping.length; i++) {
    const rule = overlapping[i]!;
    const next = overlapping[i + 1];
    const segStartDate = maxDate(rule.effectiveFrom, window.startDate);
    const segEndDate = minDate(next?.effectiveFrom ?? window.endDate, window.endDate);
    if (segStartDate >= segEndDate) continue;

    const segStart = new Date(startOfDayUtcish(segStartDate, zone, window));
    const segEnd = new Date(startOfDayUtcish(segEndDate, zone, window));
    const aggResult = await repo.aggregateByJurisdiction(
      orgId,
      { start: segStart, end: segEnd },
      [jurisdiction],
    );
    if (!aggResult.ok) return { ok: false, reason: "repository_error" };

    segments.push({
      rule: toEngineRule(rule, ruleSet.version),
      inputs: {
        asOf: asOf.toISOString(),
        window: {
          start: segStart.toISOString(),
          end: segEnd.toISOString(),
          startDate: segStartDate,
          endDate: segEndDate,
        },
        aggregate: aggResult.value[0] ?? emptyAggregate(jurisdiction),
        approachingFraction,
      },
    });
  }

  if (segments.length === 0) return { ok: false, reason: "no_rule" };

  const combined = evaluateSegmented(segments);
  const last = segments[segments.length - 1]!;
  return {
    ok: true,
    rules: overlapping,
    // The reported window is the whole span, not the last segment's: the
    // determination measured all of it, and a stored window naming only the
    // tail would not reproduce the stored total.
    inputs: {
      ...last.inputs,
      window,
      aggregate: sumAggregates(segments.map((s) => s.inputs.aggregate), jurisdiction),
    },
    outcome: combined,
  };
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * A segment boundary as an instant.
 *
 * Reuses the window's own boundaries when the date matches one of them, so a
 * segment that starts at the window start is byte-identical to the window
 * start rather than a recomputation that could differ by a DST hour. Otherwise
 * the engine's zone conversion is used.
 */
function startOfDayUtcish(
  date: string,
  timeZone: string,
  window: { start: string; end: string; startDate: string; endDate: string },
): string {
  if (date === window.startDate) return window.start;
  if (date === window.endDate) return window.end;
  // `dateInZone` round-trips through the same conversion the window used.
  const offsetProbe = new Date(`${date}T12:00:00.000Z`);
  const localDate = dateInZone(offsetProbe, timeZone);
  const shiftDays = localDate === date ? 0 : localDate < date ? 1 : -1;
  const probe = new Date(offsetProbe.getTime() + shiftDays * 86_400_000);
  const midnight = new Date(probe);
  midnight.setUTCHours(0, 0, 0, 0);
  // Walk forward hour by hour until the local date flips — bounded, exact, and
  // correct across any offset including the half-hour zones.
  for (let h = -14; h <= 14; h++) {
    const candidate = new Date(midnight.getTime() + h * 3_600_000);
    const before = new Date(candidate.getTime() - 1);
    if (dateInZone(candidate, timeZone) === date && dateInZone(before, timeZone) !== date) {
      return candidate.toISOString();
    }
  }
  return `${date}T00:00:00.000Z`;
}

function sumAggregates(
  parts: readonly JurisdictionAggregate[],
  jurisdiction: string,
): JurisdictionAggregate {
  return parts.reduce<JurisdictionAggregate>(
    (acc, p) => ({
      jurisdiction,
      directGrossCents: acc.directGrossCents + p.directGrossCents,
      directRetailCents: acc.directRetailCents + p.directRetailCents,
      directTaxableCents: acc.directTaxableCents + p.directTaxableCents,
      directTransactions: acc.directTransactions + p.directTransactions,
      marketplaceGrossCents: acc.marketplaceGrossCents + p.marketplaceGrossCents,
      marketplaceRetailCents: acc.marketplaceRetailCents + p.marketplaceRetailCents,
      marketplaceTaxableCents: acc.marketplaceTaxableCents + p.marketplaceTaxableCents,
      marketplaceTransactions: acc.marketplaceTransactions + p.marketplaceTransactions,
    }),
    emptyAggregate(jurisdiction),
  );
}
