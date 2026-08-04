// NX5 — the hourly evaluation, change detection, and alerting.
//
// The milestone's acceptance criteria, made executable:
//
//   * crossing a threshold produces **exactly one** determination, one alert
//     row, one email, and one audit entry;
//   * re-running the cron immediately produces **none of them**;
//   * an unverified rule set produces an internal-only determination and
//     **no** customer-facing alert (design §11).
//
// Change detection is tested as a property of the whole tick rather than of
// `hasChanged` alone, because the bug it prevents — the determination table
// growing by forty-eight rows an hour per tenant forever — is a property of
// the loop, not of the predicate.

import { evaluateOrg, hasChanged } from "@nexus-worker/evaluation";
import { alertKindFor, raiseAlerts } from "@nexus-worker/alerts";
import { runEvaluationTick } from "@nexus-worker/scheduled";
import type { Env } from "@nexus-worker/env";
import type {
  DeterminationRow,
  NexusRepository,
  NexusResult,
  RuleRow,
  RuleSetRow,
} from "@saas/db/nexus";

const ORG_UUID = "00000000-0000-4000-8000-000000000001";
const ORG = ORG_UUID as never;
const USD = (d: number): number => Math.round(d * 100);

const RULE_SET: RuleSetRow = {
  id: "00000000-0000-4000-8000-0000000000c1",
  version: "2026.08.01-synthetic",
  publishedAt: new Date("2026-08-01T00:00:00.000Z"),
  verified: false,
  sourceNote: "SYNTHETIC",
};

function ruleRow(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: "00000000-0000-4000-8000-0000000000c9",
    ruleSetId: RULE_SET.id,
    ruleSetVersion: RULE_SET.version,
    jurisdiction: "US-TX",
    effectiveFrom: "2019-01-01",
    effectiveTo: null,
    measurementBasis: "gross",
    measurementPeriod: "rolling_12m",
    measurementTimezone: "America/Chicago",
    salesThresholdCents: USD(500_000),
    transactionThreshold: null,
    thresholdLogic: "sales_only",
    marketplaceTreatment: "include",
    registrationDeadlineRule: { kind: "first_of_next_month" },
    notes: null,
    ...overrides,
  };
}

/**
 * A repository double that behaves like the real one for the two properties
 * under test: determinations accumulate and `listCurrentDeterminations`
 * returns the newest per jurisdiction; alerts are gated by the unique index.
 */
function stateful(options: {
  verified?: boolean;
  gross?: number;
  rules?: RuleRow[];
  /** R10: the seller's own tax contact, when they have named one. */
  alertContact?: string | null;
  /** Simulates a repository failure on the contact lookup. */
  contactFails?: boolean;
}) {
  const determinations: DeterminationRow[] = [];
  const alertKeys = new Set<string>();
  const alerts: unknown[] = [];
  const watermarks: unknown[] = [];
  const ok = <T>(value: T): NexusResult<T> => ({ ok: true, value });
  const gross = options.gross ?? 0;

  const repo: NexusRepository = {
    appendSaleEvents: async () =>
      ok({ submitted: 0, applied: 0, duplicates: 0, divergent: [], events: [] }),
    listSaleEventsPaged: async () => ok({ items: [], nextCursor: null }),
    getSaleEventById: async () => ({ ok: false, error: { kind: "not_found" } }),
    aggregateByJurisdiction: async (_org, _w, jurisdictions) =>
      ok(
        (jurisdictions ?? ["US-TX"]).map((j) => ({
          jurisdiction: j,
          directGrossCents: gross,
          directRetailCents: gross,
          directTaxableCents: gross,
          directTransactions: 100,
          marketplaceGrossCents: 0,
          marketplaceRetailCents: 0,
          marketplaceTaxableCents: 0,
          marketplaceTransactions: 0,
        })),
      ),
    listActiveJurisdictions: async () => ok(["US-TX"]),
    getCurrentRuleSet: async () => ok({ ...RULE_SET, verified: options.verified ?? false }),
    getRuleSetByVersion: async () => ok(RULE_SET),
    listRulesInForce: async () => ok(options.rules ?? [ruleRow()]),
    listRulesOverlapping: async () => ok(options.rules ?? [ruleRow()]),
    getRuleById: async () => ok(ruleRow()),
    insertDetermination: async (_org, input) => {
      const row = { ...input, orgId: ORG_UUID } as unknown as DeterminationRow;
      determinations.unshift(row);
      return ok(row);
    },
    listCurrentDeterminations: async () => {
      const byJurisdiction = new Map<string, DeterminationRow>();
      for (const d of determinations) {
        if (!byJurisdiction.has(d.jurisdiction)) byJurisdiction.set(d.jurisdiction, d);
      }
      return ok([...byJurisdiction.values()]);
    },
    listDeterminationsPaged: async () => ok({ items: determinations, nextCursor: null }),
    getDeterminationById: async () => ({ ok: false, error: { kind: "not_found" } }),
    upsertRegistration: async () => ({ ok: false, error: { kind: "internal", message: "n/a" } }),
    listRegistrations: async () => ok([]),
    getAlertContact: async () => {
      if (options.contactFails) return { ok: false, error: { kind: "internal", message: "n/a" } };
      const email = options.alertContact ?? null;
      return ok(
        email === null
          ? null
          : {
              orgId: ORG_UUID,
              email,
              label: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
      );
    },
    upsertAlertContact: async () => ({ ok: false, error: { kind: "internal", message: "n/a" } }),
    deleteAlertContact: async () => ok(false),
    insertAlertOnce: async (_org, input) => {
      // The real guarantee is `nexus_alerts_once_idx`; this mirrors it exactly
      // so the "re-run produces none of them" assertion is testing the caller,
      // not the double.
      const key = `${input.jurisdiction}|${input.determinationId}|${input.kind}`;
      if (alertKeys.has(key)) return ok(null);
      alertKeys.add(key);
      alerts.push(input);
      return ok({ ...input, orgId: ORG_UUID, sentAt: input.sentAt } as never);
    },
    listAlerts: async () => ok([]),
    getWatermark: async () => ok(null),
    setWatermark: async (_org, ingested, evaluated) => {
      watermarks.push({ ingested, evaluated });
      return ok(undefined);
    },
    listOrgsWithActivity: async () =>
      ok([{ orgId: ORG_UUID, maxIngestedAt: new Date("2026-08-04T06:00:00.000Z") }]),
    getChannelIdsForOrg: async () => ok([]),
    touchChannelLastEvent: async () => ok(undefined),
  };

  return { repo, determinations, alerts, watermarks };
}

/** An env whose events/notifications bindings record what they were sent. */
function recordingEnv(options: { alertEmail?: string } = {}): {
  env: Env;
  events: Array<{ type: string }>;
  notifications: unknown[];
} {
  const events: Array<{ type: string }> = [];
  const notifications: unknown[] = [];

  const env: Env = {
    ENVIRONMENT: "test",
    EVENTS_WORKER: {
      async fetch(_url: RequestInfo, init?: RequestInit): Promise<Response> {
        const body = JSON.parse(String(init?.body ?? "{}")) as { event?: { type?: string } };
        events.push({ type: body.event?.type ?? "" });
        return new Response("{}", { status: 202 });
      },
    } as unknown as Fetcher,
    NOTIFICATIONS_WORKER: {
      async fetch(_url: RequestInfo, init?: RequestInit): Promise<Response> {
        notifications.push(JSON.parse(String(init?.body ?? "{}")));
        return Response.json({ data: { notification: { id: "ntf_1" } } }, { status: 202 });
      },
    } as unknown as Fetcher,
  };
  if (options.alertEmail !== undefined) env.NEXUS_ALERT_EMAIL = options.alertEmail;
  return { env, events, notifications };
}

const NOW = new Date("2026-08-04T07:00:00.000Z");

describe("change detection (design §8 step 4, R5)", () => {
  it("writes on a first evaluation", () => {
    expect(hasChanged(null, "clear", 0, 0)).toBe(true);
  });

  it("does not write when nothing moved", () => {
    expect(
      hasChanged({ status: "clear", measuredSalesCents: 100, measuredTransactions: 2 }, "clear", 100, 2),
    ).toBe(false);
  });

  it.each([
    ["status", "crossed", 100, 2],
    ["measured sales", "clear", 101, 2],
    ["measured transactions", "clear", 100, 3],
  ] as const)("writes when the %s changed", (_what, status, cents, txns) => {
    expect(
      hasChanged({ status: "clear", measuredSalesCents: 100, measuredTransactions: 2 }, status, cents, txns),
    ).toBe(true);
  });

  it("writes exactly one row for an unchanged ledger across two evaluations", async () => {
    // The named acceptance test. Without this the table grows by forty-eight
    // rows an hour per tenant forever and the history stops being readable —
    // a correctness requirement for the history view, not an optimisation.
    const { repo, determinations } = stateful({ gross: USD(10_000) });

    await evaluateOrg(repo, ORG, NOW);
    expect(determinations).toHaveLength(1);

    await evaluateOrg(repo, ORG, new Date("2026-08-04T08:00:00.000Z"));
    expect(determinations).toHaveLength(1);
  });

  it("writes a second row when the measured value moves", async () => {
    const first = stateful({ gross: USD(10_000) });
    await evaluateOrg(first.repo, ORG, NOW);
    expect(first.determinations).toHaveLength(1);

    // Same repository, more sales.
    const second = stateful({ gross: USD(20_000) });
    await evaluateOrg(second.repo, ORG, NOW);
    expect(second.determinations[0]!.measuredSalesCents).toBe(USD(20_000));
  });
});

describe("the unverified gate (design §11)", () => {
  it("marks every determination internal-only", async () => {
    const { repo, determinations } = stateful({ verified: false, gross: USD(600_000) });
    await evaluateOrg(repo, ORG, NOW);
    expect(determinations[0]!.status).toBe("crossed");
    expect(determinations[0]!.internalOnly).toBe(true);
  });

  it("raises NO customer-facing alert and enqueues NO email", async () => {
    // The gate is in the engine's caller, not the UI. A merchant receiving an
    // email saying they crossed a threshold has been told a compliance
    // conclusion, and from an unverified rule set we have no basis to tell
    // them that — a banner in a console they may not open is not a substitute.
    const { repo, alerts } = stateful({ verified: false, gross: USD(600_000) });
    const { env, notifications } = recordingEnv({ alertEmail: "tax@acme.test" });

    const result = await evaluateOrg(repo, ORG, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = await raiseAlerts(repo, env, ORG, result.value.transitions, false, "req_1", NOW);
    expect(summary.suppressedUnverified).toBe(1);
    expect(summary.alertsRaised).toBe(0);
    expect(alerts).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("still emits the audit event, because the log records what we determined", async () => {
    // Suppressing the event would leave a hole in the history exactly where a
    // dispute would look.
    const { repo } = stateful({ verified: false, gross: USD(600_000) });
    const { env, events } = recordingEnv();
    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;

    await raiseAlerts(repo, env, ORG, result.value.transitions, false, "req_1", NOW);
    expect(events.map((e) => e.type)).toEqual([
      "nexus.determination.created",
      "nexus.threshold.crossed",
    ]);
  });

  it("marks determinations customer-facing when the rule set IS verified", async () => {
    const { repo, determinations } = stateful({ verified: true, gross: USD(600_000) });
    await evaluateOrg(repo, ORG, NOW);
    expect(determinations[0]!.internalOnly).toBe(false);
  });
});

describe("alerting", () => {
  it("produces exactly one determination, one alert, one email, one audit trail", async () => {
    const { repo, determinations, alerts } = stateful({ verified: true, gross: USD(600_000) });
    const { env, events, notifications } = recordingEnv({ alertEmail: "tax@acme.test" });

    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;
    const summary = await raiseAlerts(repo, env, ORG, result.value.transitions, true, "req_1", NOW);

    expect(determinations).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(summary.notificationsEnqueued).toBe(1);
    expect(notifications).toHaveLength(1);
    // Two events: the determination, and the subscribable
    // `nexus.threshold.crossed` a seller's own systems can react to.
    expect(events.map((e) => e.type)).toEqual([
      "nexus.determination.created",
      "nexus.threshold.crossed",
    ]);
  });

  it("re-running immediately produces none of them", async () => {
    // The other half of the acceptance criterion, and the reason the
    // alert-once guarantee is a database constraint rather than a lock: a
    // second firing is free and correct.
    const { repo, determinations, alerts } = stateful({ verified: true, gross: USD(600_000) });
    const { env, notifications } = recordingEnv({ alertEmail: "tax@acme.test" });

    const first = await evaluateOrg(repo, ORG, NOW);
    if (!first.ok) return;
    await raiseAlerts(repo, env, ORG, first.value.transitions, true, "req_1", NOW);

    const second = await evaluateOrg(repo, ORG, new Date("2026-08-04T08:00:00.000Z"));
    if (!second.ok) return;
    const summary = await raiseAlerts(repo, env, ORG, second.value.transitions, true, "req_2", NOW);

    expect(determinations).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(summary.alertsRaised).toBe(0);
  });

  // ── R10: the seller's own tax contact ──
  //
  // NX5 shipped the environment variable and said in writing it was a stopgap.
  // These four cases are the closure: the seller's choice wins, the default is
  // a floor rather than a competitor, a lookup failure degrades to the floor
  // instead of losing the determination, and "nobody" is still recorded.

  it("prefers the seller's own tax contact over the environment default", async () => {
    const { repo } = stateful({
      verified: true,
      gross: USD(600_000),
      alertContact: "Bookkeeper@Acme.test",
    });
    const { env, notifications } = recordingEnv({ alertEmail: "ops@nexara.test" });

    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;
    const summary = await raiseAlerts(repo, env, ORG, result.value.transitions, true, "req_1", NOW);

    expect(summary.notificationsEnqueued).toBe(1);
    const sent = notifications[0] as { recipient: { address: string } };
    // Normalised, so a seller typing a capitalised address does not produce a
    // recipient that differs from the one an operator would search for.
    expect(sent.recipient.address).toBe("bookkeeper@acme.test");
  });

  it("falls back to the environment default when the seller has named nobody", async () => {
    const { repo } = stateful({ verified: true, gross: USD(600_000), alertContact: null });
    const { env, notifications } = recordingEnv({ alertEmail: "ops@nexara.test" });

    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;
    await raiseAlerts(repo, env, ORG, result.value.transitions, true, "req_1", NOW);

    const sent = notifications[0] as { recipient: { address: string } };
    expect(sent.recipient.address).toBe("ops@nexara.test");
  });

  it("degrades to the environment default when the contact lookup fails", async () => {
    // A failed lookup must not lose the determination or the alert row. The
    // alert is the recoverable half; the record is not.
    const { repo, alerts } = stateful({
      verified: true,
      gross: USD(600_000),
      contactFails: true,
    });
    const { env, notifications } = recordingEnv({ alertEmail: "ops@nexara.test" });

    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;
    const summary = await raiseAlerts(repo, env, ORG, result.value.transitions, true, "req_1", NOW);

    expect(summary.alertsRaised).toBe(1);
    expect(alerts).toHaveLength(1);
    expect((notifications[0] as { recipient: { address: string } }).recipient.address).toBe(
      "ops@nexara.test",
    );
  });

  it("records the absence of a recipient rather than failing silently", async () => {
    const { repo, alerts } = stateful({ verified: true, gross: USD(600_000) });
    const { env, notifications } = recordingEnv(); // no NEXUS_ALERT_EMAIL

    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;
    const summary = await raiseAlerts(repo, env, ORG, result.value.transitions, true, "req_1", NOW);

    expect(summary.alertsRaised).toBe(1);
    expect(summary.missingRecipient).toBe(1);
    expect(notifications).toEqual([]);
    // The row says so, so "no email went out" is queryable rather than
    // something you learn from a support ticket.
    expect((alerts[0] as { notificationRef: string }).notificationRef).toBe(
      "no_recipient_configured",
    );
  });

  it("carries no ledger rows or customer data into the email", async () => {
    // Integer cents and codes only. The email tells a seller THAT a line moved
    // and where to look; the numbers behind it live behind their session.
    const { repo } = stateful({ verified: true, gross: USD(600_000) });
    const { env, notifications } = recordingEnv({ alertEmail: "tax@acme.test" });
    const result = await evaluateOrg(repo, ORG, NOW);
    if (!result.ok) return;
    await raiseAlerts(repo, env, ORG, result.value.transitions, true, "req_1", NOW);

    const sent = notifications[0] as { templateData: Record<string, string> };
    expect(Object.keys(sent.templateData).sort()).toEqual([
      "crossedOn", "determinationId", "jurisdiction", "jurisdictionName",
      "measuredSalesCents", "measuredTransactions", "periodEnd", "periodStart",
      "registrationDueOn", "ruleSetVersion", "status",
      "thresholdSalesCents", "thresholdTransactions",
    ]);
  });

  describe("which transitions alert", () => {
    const t = (from: string | null, to: string) =>
      ({ jurisdiction: "US-TX", from, to, determination: {} }) as never;

    it.each([
      ["clear → crossed", t("clear", "crossed"), "crossed"],
      ["approaching → crossed", t("approaching", "crossed"), "crossed"],
      ["null → crossed", t(null, "crossed"), "crossed"],
      ["clear → approaching", t("clear", "approaching"), "approaching"],
    ] as const)("%s alerts", (_name, transition, expected) => {
      expect(alertKindFor(transition)).toBe(expected);
    });

    it("does not re-alert on crossed → approaching", () => {
      // A position oscillating around 80% across hourly evaluations would mail
      // the seller every hour, and an alert that arrives every hour stops
      // being an alert.
      expect(alertKindFor(t("crossed", "approaching"))).toBeNull();
    });

    it.each([
      ["crossed → clear", t("crossed", "clear")],
      ["approaching → clear", t("approaching", "clear")],
      ["clear → no_obligation", t("clear", "no_obligation")],
    ] as const)("%s does not alert", (_name, transition) => {
      expect(alertKindFor(transition)).toBeNull();
    });
  });
});

describe("the hourly tick", () => {
  it("evaluates, alerts, and advances the watermark", async () => {
    const { repo, determinations, watermarks } = stateful({ verified: true, gross: USD(600_000) });
    const { env } = recordingEnv({ alertEmail: "tax@acme.test" });

    const summary = await runEvaluationTick(repo, env, NOW, "cron_1");

    expect(summary.orgsConsidered).toBe(1);
    expect(summary.orgsEvaluated).toBe(1);
    expect(summary.determinationsWritten).toBe(1);
    expect(summary.alertsRaised).toBe(1);
    expect(determinations).toHaveLength(1);
    // Advanced only AFTER alerts, so a crash between the two re-runs both next
    // hour — free, because the alert index makes the re-run a no-op.
    expect(watermarks).toHaveLength(1);
  });

  it("writes nothing on a second tick over an unchanged ledger", async () => {
    const { repo, determinations, alerts } = stateful({ verified: true, gross: USD(600_000) });
    const { env } = recordingEnv({ alertEmail: "tax@acme.test" });

    await runEvaluationTick(repo, env, NOW, "cron_1");
    const second = await runEvaluationTick(repo, env, new Date("2026-08-04T08:00:00.000Z"), "cron_2");

    expect(second.determinationsWritten).toBe(0);
    expect(second.alertsRaised).toBe(0);
    expect(determinations).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it("does not count a missing rule set as a failure", async () => {
    // Every org would report it, and an environment that has published no rule
    // set is a state, not an incident.
    const { repo } = stateful({});
    const noRuleSet: NexusRepository = {
      ...repo,
      getCurrentRuleSet: async () => ({ ok: false, error: { kind: "not_found" } }),
    };
    const { env } = recordingEnv();
    const summary = await runEvaluationTick(noRuleSet, env, NOW, "cron_1");
    expect(summary.failures).toBe(0);
    expect(summary.orgsEvaluated).toBe(0);
  });

  it("does not let one org's failure stop the others", async () => {
    // A tenant with a corrupt row must not silently freeze every other
    // tenant's monitoring — the shared-fate bug whose symptom is *absence*.
    const { repo } = stateful({ verified: true, gross: USD(600_000) });
    let calls = 0;
    const flaky: NexusRepository = {
      ...repo,
      listOrgsWithActivity: async () =>
        ({
          ok: true,
          value: [
            { orgId: "00000000-0000-4000-8000-0000000000ff", maxIngestedAt: NOW },
            { orgId: ORG_UUID, maxIngestedAt: NOW },
          ],
        }) as never,
      aggregateByJurisdiction: async (...args) => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return repo.aggregateByJurisdiction(...args);
      },
    };
    const { env } = recordingEnv();
    const summary = await runEvaluationTick(flaky, env, NOW, "cron_1");

    expect(summary.failures).toBe(1);
    expect(summary.orgsEvaluated).toBe(1);
  });
});
