// Repository rows → wire shapes.
//
// This file is the seam design §3 asks for: `@saas/db` declares its column
// unions locally against the Postgres CHECK constraints, `@saas/contracts`
// declares the wire unions, and the two are mapped here rather than being the
// same type by accident. When a CHECK gains a value the wire shape has not,
// the divergence shows up as a compile error in this file — which is where a
// reader would look for it.

import type {
  PublicAlert,
  PublicDetermination,
  PublicRegistration,
  PublicRule,
  PublicRuleSet,
  PublicSaleEvent,
  DeterminationInputs,
  RegistrationDeadlineRule,
} from "@saas/contracts/nexus";
import type {
  AlertRow,
  DeterminationRow,
  RegistrationRow,
  RuleRow,
  RuleSetRow,
  SaleEvent,
} from "@saas/db/nexus";

import {
  alertPublicId,
  channelPublicId,
  determinationPublicId,
  orgPublicId,
  registrationPublicId,
  rulePublicId,
  ruleSetPublicId,
  saleEventPublicId,
} from "./ids.js";

export function toPublicSaleEvent(row: SaleEvent): PublicSaleEvent {
  return {
    id: saleEventPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    channelId: channelPublicId(row.channelId),
    source: row.source,
    providerEventId: row.providerEventId,
    kind: row.kind,
    reversesEventId: row.reversesEventId ? saleEventPublicId(row.reversesEventId) : null,
    occurredAt: row.occurredAt.toISOString(),
    jurisdiction: row.jurisdiction,
    jurisdictionSource: row.jurisdictionSource,
    shipToCountry: row.shipToCountry,
    shipToRegion: row.shipToRegion,
    grossCents: row.grossCents,
    retailCents: row.retailCents,
    taxableCents: row.taxableCents,
    transactionCount: row.transactionCount,
    marketplaceFacilitated: row.marketplaceFacilitated,
    currency: row.currency,
    ingestedAt: row.ingestedAt.toISOString(),
  };
}

export function toPublicRuleSet(row: RuleSetRow): PublicRuleSet {
  return {
    id: ruleSetPublicId(row.id),
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    verified: row.verified,
    sourceNote: row.sourceNote,
  };
}

export function toPublicRule(row: RuleRow): PublicRule {
  return {
    id: rulePublicId(row.id),
    ruleSetId: ruleSetPublicId(row.ruleSetId),
    ruleSetVersion: row.ruleSetVersion,
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
    registrationDeadlineRule: row.registrationDeadlineRule as unknown as RegistrationDeadlineRule,
    notes: row.notes,
  };
}

export function toPublicDetermination(row: DeterminationRow): PublicDetermination {
  return {
    id: determinationPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    jurisdiction: row.jurisdiction,
    evaluatedAt: row.evaluatedAt.toISOString(),
    ruleSetVersion: row.ruleSetVersion,
    ruleId: rulePublicId(row.ruleId),
    engineVersion: row.engineVersion,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    measuredSalesCents: row.measuredSalesCents,
    measuredTransactions: row.measuredTransactions,
    thresholdSalesCents: row.thresholdSalesCents,
    thresholdTransactions: row.thresholdTransactions,
    status: row.status,
    crossedOn: row.crossedOn,
    registrationDueOn: row.registrationDueOn,
    inputs: row.inputs as unknown as DeterminationInputs,
    internalOnly: row.internalOnly,
  };
}

export function toPublicRegistration(row: RegistrationRow): PublicRegistration {
  return {
    id: registrationPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    jurisdiction: row.jurisdiction,
    status: row.status,
    registeredOn: row.registeredOn,
    permitRef: row.permitRef,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPublicAlert(row: AlertRow): PublicAlert {
  return {
    id: alertPublicId(row.id),
    orgId: orgPublicId(row.orgId),
    jurisdiction: row.jurisdiction,
    determinationId: determinationPublicId(row.determinationId),
    kind: row.kind,
    sentAt: row.sentAt.toISOString(),
    notificationRef: row.notificationRef,
  };
}
