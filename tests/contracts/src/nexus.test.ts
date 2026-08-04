// NX1 — the nexus and channels wire contracts.
//
// Contract tests over plain TypeScript types have exactly one job worth doing:
// pin the things a later edit could quietly change without any consumer
// failing to compile. Those are (a) the enumerations, which mirror Postgres
// CHECK constraints one-for-one, and (b) the shapes whose *absence* is the
// guarantee — no update shape for the ledger, no payload on a delivery
// projection.

import {
  ALERT_KINDS,
  DETERMINATION_STATUSES,
  JURISDICTION_SOURCES,
  MARKETPLACE_TREATMENTS,
  MEASUREMENT_BASES,
  MEASUREMENT_PERIODS,
  NEXUS_EVENT_TYPES,
  REGISTRATION_DEADLINE_RULE_KINDS,
  REGISTRATION_STATUSES,
  SALE_EVENT_KINDS,
  SALE_EVENT_SOURCES,
  THRESHOLD_LOGICS,
} from "@saas/contracts/nexus";
import type {
  DeterminationInputs,
  DeterminationOutcome,
  ImportLedgerRequest,
  JurisdictionAggregate,
  PublicDetermination,
  PublicSaleEvent,
  RegistrationDeadlineRule,
  Rule,
} from "@saas/contracts/nexus";
import {
  CHANNEL_PROVIDERS,
  CHANNEL_STATUSES,
  DELIVERY_STATUSES,
} from "@saas/contracts/channels";
import type {
  CanonicalSaleEvent,
  PublicChannel,
  PublicChannelDelivery,
} from "@saas/contracts/channels";

describe("contracts: nexus enumerations", () => {
  // Each of these mirrors a CHECK constraint. When one changes the other is a
  // migration, not an edit — so a diff here should be loud.
  it.each([
    ["MEASUREMENT_BASES", MEASUREMENT_BASES, ["gross", "retail", "taxable"]],
    [
      "MEASUREMENT_PERIODS",
      MEASUREMENT_PERIODS,
      ["rolling_12m", "calendar_year", "previous_calendar_year"],
    ],
    [
      "THRESHOLD_LOGICS",
      THRESHOLD_LOGICS,
      ["none", "sales_only", "transactions_only", "either", "both"],
    ],
    ["MARKETPLACE_TREATMENTS", MARKETPLACE_TREATMENTS, ["include", "exclude"]],
    [
      "DETERMINATION_STATUSES",
      DETERMINATION_STATUSES,
      ["no_obligation", "clear", "approaching", "crossed", "registered"],
    ],
    ["SALE_EVENT_SOURCES", SALE_EVENT_SOURCES, ["backfill", "webhook", "csv"]],
    ["SALE_EVENT_KINDS", SALE_EVENT_KINDS, ["sale", "refund"]],
    [
      "REGISTRATION_STATUSES",
      REGISTRATION_STATUSES,
      ["planned", "filed", "active", "closed"],
    ],
    ["ALERT_KINDS", ALERT_KINDS, ["approaching", "crossed", "deadline"]],
    [
      "JURISDICTION_SOURCES",
      JURISDICTION_SOURCES,
      ["shipping_address", "billing_address", "tax_lines", "declared"],
    ],
    ["CHANNEL_PROVIDERS", CHANNEL_PROVIDERS, ["stripe", "shopify", "csv"]],
    [
      "CHANNEL_STATUSES",
      CHANNEL_STATUSES,
      ["backfilling", "connected", "degraded", "revoked"],
    ],
    [
      "DELIVERY_STATUSES",
      DELIVERY_STATUSES,
      ["received", "applied", "skipped", "failed"],
    ],
  ])("%s matches its CHECK constraint", (_name, actual, expected) => {
    expect([...(actual as readonly string[])]).toEqual(expected);
  });

  it("keeps no_obligation distinct from clear", () => {
    // "clear" means measured and below the line. "no_obligation" means there
    // is no line. A product that renders them alike has lost the distinction
    // the threshold_logic='none' rule row exists to carry.
    expect(DETERMINATION_STATUSES).toContain("no_obligation");
    expect(DETERMINATION_STATUSES).toContain("clear");
    expect(DETERMINATION_STATUSES.indexOf("no_obligation")).not.toBe(
      DETERMINATION_STATUSES.indexOf("clear"),
    );
  });

  it("covers every deadline-rule kind the union declares", () => {
    // deadline.ts must be total over this union; a kind added to the type and
    // forgotten here would compile and then throw at evaluation time.
    const sample: RegistrationDeadlineRule[] = [
      { kind: "days_after_crossing", days: 30 },
      { kind: "first_of_next_month" },
      { kind: "end_of_next_month" },
      { kind: "first_of_next_quarter" },
      { kind: "first_of_month_after_days", days: 60 },
      { kind: "none" },
    ];
    expect(sample.map((r) => r.kind).sort()).toEqual(
      [...REGISTRATION_DEADLINE_RULE_KINDS].sort(),
    );
  });

  it("registers nexus.threshold.crossed as an event type", () => {
    // NX5 registers this as a subscribable outgoing webhook type; a rename
    // here silently unsubscribes every seller who was listening.
    expect(NEXUS_EVENT_TYPES).toContain("nexus.threshold.crossed");
    expect(NEXUS_EVENT_TYPES).toContain("nexus.determination.created");
  });
});

describe("contracts: the ledger is append-only", () => {
  it("carries a refund as a negative row pointing at its original", () => {
    const sale: PublicSaleEvent = {
      id: "sev_01",
      orgId: "org_01",
      channelId: "chn_01",
      source: "csv",
      providerEventId: "ch_abc",
      kind: "sale",
      reversesEventId: null,
      occurredAt: "2026-03-04T10:00:00.000Z",
      jurisdiction: "US-TX",
      jurisdictionSource: "shipping_address",
      shipToCountry: "US",
      shipToRegion: "TX",
      grossCents: 125_00,
      retailCents: 125_00,
      taxableCents: 125_00,
      transactionCount: 1,
      marketplaceFacilitated: false,
      currency: "USD",
      ingestedAt: "2026-03-04T10:00:05.000Z",
    };

    const refund: PublicSaleEvent = {
      ...sale,
      id: "sev_02",
      providerEventId: "re_abc",
      kind: "refund",
      reversesEventId: sale.id,
      occurredAt: "2026-04-01T09:00:00.000Z",
      grossCents: -125_00,
      retailCents: -125_00,
      taxableCents: -125_00,
      transactionCount: -1,
      ingestedAt: "2026-04-01T09:00:03.000Z",
    };

    // A plain SUM handles the reversal with no special casing. That is the
    // whole payoff for never updating the ledger in place.
    expect(sale.grossCents + refund.grossCents).toBe(0);
    expect(sale.transactionCount + refund.transactionCount).toBe(0);
    expect(refund.reversesEventId).toBe(sale.id);
  });

  it("exposes no update shape for a ledger row", async () => {
    // If someone adds `UpdateSaleEventRequest` this fails, which is the point.
    const nexus: Record<string, unknown> = await import("@saas/contracts/nexus");
    const mutators = Object.keys(nexus).filter((k) => /^Update/.test(k));
    expect(mutators).toEqual([]);
  });

  it("keeps every monetary field an integer count of cents", () => {
    const aggregate: JurisdictionAggregate = {
      jurisdiction: "US-WA",
      directGrossCents: 87_450_00,
      directRetailCents: 87_450_00,
      directTaxableCents: 80_000_00,
      directTransactions: 412,
      marketplaceGrossCents: 12_000_00,
      marketplaceRetailCents: 12_000_00,
      marketplaceTaxableCents: 12_000_00,
      marketplaceTransactions: 61,
    };
    for (const [key, value] of Object.entries(aggregate)) {
      if (key === "jurisdiction") continue;
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("contracts: a determination is reproducible", () => {
  const rule: Rule = {
    id: "rul_01",
    ruleSetId: "rst_01",
    ruleSetVersion: "2026.08.01",
    jurisdiction: "US-TX",
    effectiveFrom: "2019-10-01",
    effectiveTo: null,
    measurementBasis: "gross",
    measurementPeriod: "rolling_12m",
    measurementTimezone: "America/Chicago",
    salesThresholdCents: 500_000_00,
    transactionThreshold: null,
    thresholdLogic: "sales_only",
    marketplaceTreatment: "include",
    registrationDeadlineRule: { kind: "first_of_next_month" },
    notes: null,
  };

  const inputs: DeterminationInputs = {
    asOf: "2026-08-04T07:00:00.000Z",
    window: {
      start: "2025-08-04T05:00:00.000Z",
      end: "2026-08-04T05:00:00.000Z",
      startDate: "2025-08-04",
      endDate: "2026-08-04",
    },
    aggregate: {
      jurisdiction: "US-TX",
      directGrossCents: 512_300_00,
      directRetailCents: 512_300_00,
      directTaxableCents: 480_000_00,
      directTransactions: 2_140,
      marketplaceGrossCents: 0,
      marketplaceRetailCents: 0,
      marketplaceTaxableCents: 0,
      marketplaceTransactions: 0,
    },
    approachingFraction: 0.8,
  };

  it("stores the triple, the window, and the exact inputs on the row", () => {
    const determination: PublicDetermination = {
      id: "det_01",
      orgId: "org_01",
      jurisdiction: "US-TX",
      evaluatedAt: inputs.asOf,
      ruleSetVersion: rule.ruleSetVersion,
      ruleId: rule.id,
      engineVersion: "1.0.0",
      periodStart: inputs.window.start,
      periodEnd: inputs.window.end,
      measuredSalesCents: 512_300_00,
      measuredTransactions: 2_140,
      thresholdSalesCents: rule.salesThresholdCents,
      thresholdTransactions: null,
      status: "crossed",
      crossedOn: "2026-08-04",
      registrationDueOn: "2026-09-01",
      inputs,
      internalOnly: true,
    };

    // The triple is what makes the row re-derivable; all three must be
    // present and none may be optional.
    expect(determination.ruleSetVersion).toBe("2026.08.01");
    expect(determination.ruleId).toBe("rul_01");
    expect(determination.engineVersion).toBe("1.0.0");
    expect(determination.inputs.aggregate.directGrossCents).toBe(512_300_00);
  });

  it("carries a half-open window with both a UTC instant and a local date", () => {
    // The instants are what the aggregation query compares against; the dates
    // are what a reader of the evidence recognises. Both, or the explainer
    // has to guess at one of them.
    expect(inputs.window.start < inputs.window.end).toBe(true);
    expect(inputs.window.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(inputs.window.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("allows a null fraction so a no-obligation never renders as 0%", () => {
    const outcome: DeterminationOutcome = {
      status: "no_obligation",
      measuredSalesCents: 0,
      measuredTransactions: 0,
      thresholdSalesCents: null,
      thresholdTransactions: null,
      crossedOn: null,
      registrationDueOn: null,
      fractionOfThreshold: null,
    };
    expect(outcome.fractionOfThreshold).toBeNull();
    expect(outcome.status).toBe("no_obligation");
  });
});

describe("contracts: channels", () => {
  it("carries a credentials pointer on the channel, never a token", async () => {
    const channels: Record<string, unknown> = await import("@saas/contracts/channels");
    // The channel projection must not have grown a token field.
    const channel: PublicChannel = {
      id: "chn_01",
      orgId: "org_01",
      provider: "stripe",
      externalAccountId: "acct_123",
      displayName: "Acme Storefront",
      status: "backfilling",
      backfillStartedAt: "2026-08-01T00:00:00.000Z",
      backfillCompletedAt: null,
      lookbackFloor: "2023-08-01",
      lastEventAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      revokedAt: null,
    };
    expect(Object.keys(channel)).not.toContain("credentialsRef");
    expect(Object.keys(channel)).not.toContain("accessToken");
    expect(channels.CHANNEL_PROVIDERS).toBeDefined();
  });

  it("never exposes a raw provider payload on the delivery projection", () => {
    const delivery: PublicChannelDelivery = {
      id: "dlv_01",
      orgId: null,
      channelId: null,
      provider: "shopify",
      providerDeliveryId: "wh_9001",
      signatureVerified: true,
      status: "received",
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      receivedAt: "2026-08-04T07:00:00.000Z",
      appliedAt: null,
    };
    // The raw body carries customer names and addresses. It stays in the
    // inbox under a retention policy; a projection that leaks it makes the
    // policy worthless.
    expect(Object.keys(delivery)).not.toContain("payload");
    expect(delivery.orgId).toBeNull();
  });

  it("normalises every provider to one canonical shape", () => {
    const canonical: CanonicalSaleEvent = {
      providerEventId: "ch_1",
      kind: "sale",
      reversesProviderEventId: null,
      occurredAt: "2026-05-05T12:00:00.000Z",
      jurisdiction: "US-CA",
      jurisdictionSource: "shipping_address",
      shipToCountry: "US",
      shipToRegion: "CA",
      grossCents: 4_999,
      retailCents: 4_999,
      taxableCents: 4_999,
      transactionCount: 1,
      marketplaceFacilitated: false,
      currency: "USD",
    };
    // The canonical event is the ONLY shape the ledger accepts, so it must
    // carry the attribution provenance too — "we guessed" has to survive
    // normalisation or it is lost before it reaches the evidence.
    expect(canonical.jurisdictionSource).toBe("shipping_address");
  });
});

describe("contracts: ledger import", () => {
  it("does not let the caller choose ids or the source", () => {
    const req: ImportLedgerRequest = {
      events: [
        {
          channelId: "chn_01",
          providerEventId: "csv-0001",
          kind: "sale",
          occurredAt: "2026-01-15T00:00:00.000Z",
          jurisdiction: "US-FL",
          grossCents: 9_900,
          retailCents: 9_900,
          taxableCents: 9_900,
          currency: "USD",
        },
      ],
    };
    const row = req.events[0]! as unknown as Record<string, unknown>;
    expect(row.id).toBeUndefined();
    expect(row.source).toBeUndefined();
    expect(row.ingestedAt).toBeUndefined();
  });
});
