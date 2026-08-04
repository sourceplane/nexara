// NX4 — the worker's HTTP surface.
//
// The acceptance criteria of the milestone, made executable:
//
//   * a `builder` can import a ledger and read the exposure board;
//   * a `viewer` reads but cannot import, and the denial is a **404**, not a
//     403 — deny-as-not-found, existence-hiding;
//   * an unknown jurisdiction code is a 404;
//   * a malformed import is a wholesale 422 with **no partial writes**.
//
// The gate is exercised through real `Fetcher` stubs for membership-worker and
// policy-worker rather than by stubbing the gate itself, because the thing
// most worth testing is that a handler cannot forget to run it.

import { route } from "@nexus-worker/router";
import type { Env } from "@nexus-worker/env";
import type {
  NexusRepository,
  NexusResult,
  RuleRow,
  RuleSetRow,
  SaleEvent,
} from "@saas/db/nexus";

const ORG_PUBLIC = "org_00000000000040008000000000000001";
const ORG_UUID = "00000000-0000-4000-8000-000000000001";
const CHANNEL_PUBLIC = "chn_00000000000040008000000000000b01";
const CHANNEL_UUID = "00000000-0000-4000-8000-000000000b01";

// ── Stubs ────────────────────────────────────────────────────

/** A membership-worker that answers for one org and nobody else. */
function membershipStub(role: string | null): Fetcher {
  return {
    async fetch(_input: RequestInfo, init?: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init?.body ?? "{}")) as { orgId?: string };
      if (role === null || body.orgId !== ORG_UUID) {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      return Response.json({
        data: {
          memberships: [
            { kind: "role_assignment", role, scope: { kind: "organization", orgId: ORG_UUID } },
          ],
        },
      });
    },
  } as unknown as Fetcher;
}

/** A policy-worker that answers from the real design §7.2 matrix. */
const MATRIX: Record<string, Set<string>> = {
  owner: new Set([
    "organization.nexus.read", "organization.nexus.evaluate",
    "organization.ledger.read", "organization.ledger.import",
    "organization.channel.read", "organization.channel.connect", "organization.channel.revoke",
    "organization.registration.read", "organization.registration.write",
  ]),
  builder: new Set([
    "organization.nexus.read", "organization.nexus.evaluate",
    "organization.ledger.read", "organization.ledger.import",
    "organization.channel.read",
    "organization.registration.read", "organization.registration.write",
  ]),
  viewer: new Set([
    "organization.nexus.read", "organization.ledger.read",
    "organization.channel.read", "organization.registration.read",
  ]),
};

function policyStub(): Fetcher {
  return {
    async fetch(_input: RequestInfo, init?: RequestInit): Promise<Response> {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string;
        context?: { memberships?: Array<{ role?: string }> };
      };
      const role = body.context?.memberships?.[0]?.role ?? "";
      const allow = MATRIX[role]?.has(body.action ?? "") ?? false;
      return Response.json({ data: { allow, reason: allow ? role : "no_matching_role" } });
    },
  } as unknown as Fetcher;
}

function envFor(role: string | null): Env {
  return {
    PLATFORM_DB: {} as Hyperdrive,
    MEMBERSHIP_WORKER: membershipStub(role),
    POLICY_WORKER: policyStub(),
    ENVIRONMENT: "test",
  };
}

// ── Repository double ────────────────────────────────────────

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
    salesThresholdCents: 50_000_000,
    transactionThreshold: null,
    thresholdLogic: "sales_only",
    marketplaceTreatment: "include",
    registrationDeadlineRule: { kind: "first_of_next_month" },
    notes: null,
    ...overrides,
  };
}

interface Spy {
  appended: unknown[][];
  determinationsWritten: number;
}

function repoDouble(options: {
  rules?: RuleRow[];
  ruleSet?: RuleSetRow | null;
  channels?: string[];
  events?: SaleEvent[];
  spy?: Spy;
}): NexusRepository {
  const ok = <T>(value: T): NexusResult<T> => ({ ok: true, value });
  const rules = options.rules ?? [ruleRow(), ruleRow({ jurisdiction: "US-OR", thresholdLogic: "none", salesThresholdCents: null, transactionThreshold: null, measurementTimezone: "America/Los_Angeles" })];

  return {
    appendSaleEvents: async (_org, rows) => {
      options.spy?.appended.push(rows as unknown[]);
      return ok({ submitted: rows.length, applied: rows.length, duplicates: 0, divergent: [], events: [] });
    },
    listSaleEventsPaged: async () => ok({ items: options.events ?? [], nextCursor: null }),
    getSaleEventById: async () => ({ ok: false, error: { kind: "not_found" } }),
    aggregateByJurisdiction: async () => ok([]),
    listActiveJurisdictions: async () => ok([]),
    getCurrentRuleSet: async () =>
      options.ruleSet === null
        ? { ok: false, error: { kind: "not_found" } }
        : ok(options.ruleSet ?? RULE_SET),
    getRuleSetByVersion: async () => ok(RULE_SET),
    listRulesInForce: async () => ok(rules),
    listRulesOverlapping: async () => ok(rules.slice(0, 1)),
    getRuleById: async () => ok(rules[0]!),
    insertDetermination: async (_org, input) => {
      if (options.spy) options.spy.determinationsWritten += 1;
      return ok({
        ...input,
        orgId: ORG_UUID,
        ruleId: input.ruleId,
        inputs: input.inputs,
      } as never);
    },
    listCurrentDeterminations: async () => ok([]),
    listDeterminationsPaged: async () => ok({ items: [], nextCursor: null }),
    getDeterminationById: async () => ({ ok: false, error: { kind: "not_found" } }),
    upsertRegistration: async () => ({ ok: false, error: { kind: "internal", message: "n/a" } }),
    listRegistrations: async () => ok([]),
    insertAlertOnce: async () => ok(null),
    listAlerts: async () => ok([]),
    getWatermark: async () => ok(null),
    setWatermark: async () => ok(undefined),
    listOrgsWithActivity: async () => ok([]),
    getChannelIdsForOrg: async () => ok(options.channels ?? [CHANNEL_UUID]),
    touchChannelLastEvent: async () => ok(undefined),
  };
}

// Handlers resolve their repository through `deps`, which `route` does not
// thread. Rather than reach past the router, these tests call the handlers
// directly for repository behaviour and use `route` for routing/authz — the
// two things being tested are genuinely different layers.
import { handleListExposure } from "@nexus-worker/handlers/list-exposure";
import { handleImportLedger } from "@nexus-worker/handlers/import-ledger";
import { handleGetJurisdiction } from "@nexus-worker/handlers/get-jurisdiction";

const ACTOR = { subjectId: "usr_1", subjectType: "user" };
const ORG = ORG_UUID as never;

function importBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    events: [
      {
        channelId: CHANNEL_PUBLIC,
        providerEventId: "csv-0001",
        kind: "sale",
        occurredAt: "2026-03-04T15:00:00.000Z",
        jurisdiction: "US-TX",
        grossCents: 120_000,
        retailCents: 120_000,
        taxableCents: 120_000,
        currency: "USD",
        ...overrides,
      },
    ],
  });
}

describe("routing and method handling", () => {
  it("serves health without authentication", async () => {
    const res = await route(new Request("https://n/health"), envFor(null));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { service: string } };
    expect(body.data.service).toBe("nexus-worker");
  });

  it("401s an unauthenticated org request", async () => {
    const res = await route(
      new Request(`https://n/v1/organizations/${ORG_PUBLIC}/nexus/exposure`),
      envFor("owner"),
    );
    expect(res.status).toBe(401);
  });

  it("405s a wrong method rather than 404ing it", async () => {
    const res = await route(
      new Request(`https://n/v1/organizations/${ORG_PUBLIC}/nexus/exposure`, { method: "DELETE" }),
      envFor("owner"),
    );
    expect(res.status).toBe(405);
  });

  it("404s a malformed org public id without consulting membership", async () => {
    // Deny-as-not-found starts at the parse. A 400 saying "your org id is
    // well-formed but unknown" is a membership oracle.
    const res = await route(
      new Request("https://n/v1/organizations/not-an-org/nexus/exposure", {
        headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" },
      }),
      envFor("owner"),
    );
    expect(res.status).toBe(404);
  });

  it("404s an unknown jurisdiction code", async () => {
    const res = await route(
      new Request(`https://n/v1/organizations/${ORG_PUBLIC}/nexus/jurisdictions/US-ZZ`, {
        headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" },
      }),
      envFor("owner"),
    );
    expect(res.status).toBe(404);
  });

  it("404s an unrouted path", async () => {
    const res = await route(new Request("https://n/v1/nope"), envFor("owner"));
    expect(res.status).toBe(404);
  });
});

describe("the authorization gate", () => {
  it("lets a builder import a ledger", async () => {
    const spy: Spy = { appended: [], determinationsWritten: 0 };
    const res = await handleImportLedger(
      new Request("https://n/import", { method: "POST", body: importBody() }),
      envFor("builder"),
      "req_1",
      ACTOR,
      ORG,
      { repo: repoDouble({ spy }) },
    );
    expect(res.status).toBe(201);
    expect(spy.appended).toHaveLength(1);
  });

  it("denies a viewer the import — as a 404, not a 403", async () => {
    // A 403 confirms the organization exists to someone who has no business
    // knowing that. The acceptance criterion says 404 and means it.
    const spy: Spy = { appended: [], determinationsWritten: 0 };
    const res = await handleImportLedger(
      new Request("https://n/import", { method: "POST", body: importBody() }),
      envFor("viewer"),
      "req_1",
      ACTOR,
      ORG,
      { repo: repoDouble({ spy }) },
    );
    expect(res.status).toBe(404);
    // And nothing was written on the way to being denied.
    expect(spy.appended).toEqual([]);
  });

  it("lets a viewer read the board", async () => {
    const res = await handleListExposure(envFor("viewer"), "req_1", ACTOR, ORG, {
      repo: repoDouble({}),
    });
    expect(res.status).toBe(200);
  });

  it("denies a non-member entirely", async () => {
    const res = await handleListExposure(envFor(null), "req_1", ACTOR, ORG, {
      repo: repoDouble({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("ledger import", () => {
  const spyEnv = (): { env: Env; spy: Spy } => {
    const spy: Spy = { appended: [], determinationsWritten: 0 };
    return { env: envFor("builder"), spy };
  };

  async function post(body: string, repo?: NexusRepository, spy?: Spy): Promise<Response> {
    return handleImportLedger(
      new Request("https://n/import", { method: "POST", body }),
      envFor("builder"),
      "req_1",
      ACTOR,
      ORG,
      { repo: repo ?? repoDouble(spy ? { spy } : {}) },
    );
  }

  it("rejects a malformed row wholesale, with NO partial write", async () => {
    // Half a ledger is worse than none: the totals look plausible and are
    // wrong, and an append-only ledger cannot take the half back.
    const { spy } = spyEnv();
    const body = JSON.stringify({
      events: [
        JSON.parse(importBody()).events[0],
        { channelId: CHANNEL_PUBLIC, providerEventId: "bad", kind: "sale" }, // missing everything else
      ],
    });
    const res = await post(body, repoDouble({ spy }), spy);
    expect(res.status).toBe(422);
    expect(spy.appended).toEqual([]);
  });

  it("names every failing row, not just the first", async () => {
    const res = await post(
      JSON.stringify({ events: [{}, {}] }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { fields: Record<string, string[]> } } };
    const keys = Object.keys(body.error.details.fields);
    expect(keys.some((k) => k.startsWith("events[0]"))).toBe(true);
    expect(keys.some((k) => k.startsWith("events[1]"))).toBe(true);
  });

  it("rejects a float amount", async () => {
    const res = await post(importBody({ grossCents: 1200.5 }));
    expect(res.status).toBe(422);
  });

  it("rejects a sale carrying negative cents", async () => {
    const res = await post(importBody({ grossCents: -100, retailCents: -100, taxableCents: -100 }));
    expect(res.status).toBe(422);
  });

  it("rejects a refund carrying positive cents", async () => {
    // The sign discipline the schema enforces, surfaced as a 422 naming the
    // row rather than a 503 from a constraint violation.
    const res = await post(
      importBody({
        kind: "refund",
        reversesEventId: "sev_00000000000040008000000000000001",
        grossCents: 100,
        retailCents: 100,
        taxableCents: 100,
      }),
    );
    expect(res.status).toBe(422);
  });

  it("requires reversesEventId on a refund", async () => {
    const res = await post(
      importBody({ kind: "refund", grossCents: -100, retailCents: -100, taxableCents: -100 }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a channel belonging to another tenant", async () => {
    const res = await post(importBody(), repoDouble({ channels: [] }));
    expect(res.status).toBe(422);
  });

  it("rejects two rows sharing a dedupe key within one request", async () => {
    // Otherwise `applied + duplicates === submitted` is false through no
    // fault of the database, and the caller cannot tell which one landed.
    const one = JSON.parse(importBody()).events[0];
    const res = await post(JSON.stringify({ events: [one, { ...one }] }));
    expect(res.status).toBe(422);
  });

  it("fixes `source` to csv rather than trusting the caller", async () => {
    // A client claiming its rows arrived by webhook would corrupt the
    // provenance the evidence rests on.
    const spy: Spy = { appended: [], determinationsWritten: 0 };
    await post(importBody({ source: "webhook" }), repoDouble({ spy }), spy);
    const rows = spy.appended[0] as Array<{ source: string }>;
    expect(rows[0]!.source).toBe("csv");
  });

  it("defaults a refund's transaction count to −1", async () => {
    const spy: Spy = { appended: [], determinationsWritten: 0 };
    await post(
      importBody({
        kind: "refund",
        reversesEventId: "sev_00000000000040008000000000000001",
        grossCents: -100,
        retailCents: -100,
        taxableCents: -100,
      }),
      repoDouble({ spy }),
      spy,
    );
    const rows = spy.appended[0] as Array<{ transactionCount: number }>;
    expect(rows[0]!.transactionCount).toBe(-1);
  });
});

describe("the exposure board", () => {
  it("returns 412 rather than an empty board when no rule set is published", async () => {
    // An empty board says "you are clear", which is a claim we have no basis
    // to make.
    const res = await handleListExposure(envFor("owner"), "req_1", ACTOR, ORG, {
      repo: repoDouble({ ruleSet: null }),
    });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe("no_rule_set");
  });

  it("renders a card for a jurisdiction that has never been evaluated", async () => {
    // Absent reads as "we are not watching", which is the opposite of the
    // product.
    const res = await handleListExposure(envFor("owner"), "req_1", ACTOR, ORG, {
      repo: repoDouble({}),
    });
    const body = (await res.json()) as {
      data: { exposure: Array<{ jurisdiction: string; status: string; fractionOfThreshold: number | null }> };
    };
    const tx = body.data.exposure.find((e) => e.jurisdiction === "US-TX")!;
    expect(tx.status).toBe("clear");
    expect(tx.fractionOfThreshold).toBeNull();
  });

  it("renders a no-threshold jurisdiction as no_obligation with a null meter", async () => {
    // Never `clear` at 0%, and never blank. The rule row is the answer.
    const res = await handleListExposure(envFor("owner"), "req_1", ACTOR, ORG, {
      repo: repoDouble({}),
    });
    const body = (await res.json()) as {
      data: { exposure: Array<{ jurisdiction: string; status: string; thresholdSalesCents: number | null; fractionOfThreshold: number | null }> };
    };
    const or = body.data.exposure.find((e) => e.jurisdiction === "US-OR")!;
    expect(or.status).toBe("no_obligation");
    expect(or.thresholdSalesCents).toBeNull();
    expect(or.fractionOfThreshold).toBeNull();
  });

  it("excludes display-only international rows from the board", async () => {
    // Design §3.3: international VAT/GST rows are stored and versioned but
    // never evaluated in v1. The filter lives in one place; this is it.
    const res = await handleListExposure(envFor("owner"), "req_1", ACTOR, ORG, {
      repo: repoDouble({
        rules: [ruleRow(), ruleRow({ id: "00000000-0000-4000-8000-0000000000ca", jurisdiction: "GB", measurementTimezone: "Europe/London" })],
      }),
    });
    const body = (await res.json()) as { data: { exposure: Array<{ jurisdiction: string }> } };
    expect(body.data.exposure.map((e) => e.jurisdiction)).toEqual(["US-TX"]);
  });

  it("carries the unverified flag so the console can render the §11 banner", async () => {
    const res = await handleListExposure(envFor("owner"), "req_1", ACTOR, ORG, {
      repo: repoDouble({}),
    });
    const body = (await res.json()) as {
      data: { ruleSet: { verified: boolean }; exposure: Array<{ ruleSetVerified: boolean }> };
    };
    expect(body.data.ruleSet.verified).toBe(false);
    expect(body.data.exposure.every((e) => !e.ruleSetVerified)).toBe(true);
  });
});

describe("jurisdiction detail", () => {
  it("404s a jurisdiction with no rule in the current set", async () => {
    const res = await handleGetJurisdiction(envFor("owner"), "req_1", ACTOR, ORG, "US-CA", {
      repo: repoDouble({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns the rule in force alongside the position", async () => {
    const res = await handleGetJurisdiction(envFor("owner"), "req_1", ACTOR, ORG, "US-TX", {
      repo: repoDouble({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { rule: { id: string; ruleSetVersion: string }; determinations: unknown[] };
    };
    // The rule id crosses the boundary as a public id: it is one third of the
    // reproducibility triple and gets quoted back to a customer.
    expect(body.data.rule.id).toMatch(/^rul_[0-9a-f]{32}$/);
    expect(body.data.rule.ruleSetVersion).toBe("2026.08.01-synthetic");
  });
});
