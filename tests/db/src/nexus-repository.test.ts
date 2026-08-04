// NX3 — the nexus repository.
//
// Three layers of assertion, because each catches a different class of bug and
// none of them catches all three:
//
//   1. **Query shape.** The SQL text itself, asserted against a recording
//      executor. This is where `BETWEEN` instead of half-open, a missing
//      `FILTER`, or the wrong `ON CONFLICT` target gets caught — mistakes that
//      a value-level test would happily agree with, because the wrong query
//      returns a perfectly well-formed wrong answer.
//   2. **Mapping.** Driver rows in, repository values out, including `BIGINT`
//      arriving as a string and the safe-integer guard.
//   3. **Behaviour over a seeded ledger.** A deliberately narrow in-memory
//      stand-in for Postgres that implements exactly the two statements the
//      ledger uses. It proves the numbers for all three window types against
//      hand-computed fixtures, and it proves dedupe and refunds end to end.
//
// What layer 3 does NOT prove is that Postgres agrees with the stand-in; that
// is what layer 1 is for, and what the stage walkthrough at NX4 is for.

import { createNexusRepository } from "@saas/db/nexus";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import type { AppendSaleEventInput } from "@saas/db/nexus";

const ORG = asUuid("00000000-0000-4000-8000-0000000000a1");
const OTHER_ORG = asUuid("00000000-0000-4000-8000-0000000000a2");
const CHANNEL = asUuid("00000000-0000-4000-8000-0000000000b1");
const RULE_SET = asUuid("00000000-0000-4000-8000-0000000000c1");

interface Recorded {
  text: string;
  params: unknown[];
}

function recordingExecutor(rowsBySequence: Record<string, unknown>[][] = []): {
  executor: SqlExecutor;
  queries: Recorded[];
} {
  const queries: Recorded[] = [];
  let call = 0;
  return {
    queries,
    executor: {
      async execute<T extends SqlRow = SqlRow>(
        text: string,
        params?: unknown[],
      ): Promise<SqlExecutorResult<T>> {
        queries.push({ text, params: params ?? [] });
        const rows = (rowsBySequence[call++] ?? []) as unknown as T[];
        return { rows, rowCount: rows.length };
      },
    },
  };
}

const USD = (dollars: number): number => Math.round(dollars * 100);

// ── Layer 1: query shape ─────────────────────────────────────

describe("query shape", () => {
  it("aggregates with a HALF-OPEN window, never BETWEEN", async () => {
    // §5.3 case 1. `BETWEEN` includes the upper bound, so the boundary day is
    // counted by two consecutive evaluations — a silent double-count that
    // moves a seller across a line.
    const { executor, queries } = recordingExecutor();
    await createNexusRepository(executor).aggregateByJurisdiction(ORG, {
      start: new Date("2025-08-05T05:00:00.000Z"),
      end: new Date("2026-08-05T05:00:00.000Z"),
    });

    const sql = queries[0]!.text;
    expect(sql).not.toMatch(/BETWEEN/i);
    expect(sql).toMatch(/occurred_at >= \$2/);
    expect(sql).toMatch(/occurred_at\s*<\s*\$3/);
    expect(queries[0]!.params).toEqual([
      ORG,
      "2025-08-05T05:00:00.000Z",
      "2026-08-05T05:00:00.000Z",
    ]);
  });

  it("returns all three bases split by marketplace treatment in ONE scan", async () => {
    // Design §5.1. The naive shape runs a query per (basis × treatment ×
    // period); this returns every variant and lets the pure engine choose.
    const { executor, queries } = recordingExecutor();
    await createNexusRepository(executor).aggregateByJurisdiction(ORG, {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });

    const sql = queries[0]!.text;
    expect(queries).toHaveLength(1);
    for (const column of [
      "direct_gross_cents",
      "direct_retail_cents",
      "direct_taxable_cents",
      "direct_txns",
      "mkt_gross_cents",
      "mkt_retail_cents",
      "mkt_taxable_cents",
      "mkt_txns",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/FILTER \(WHERE NOT marketplace_facilitated\)/);
    expect(sql).toMatch(/FILTER \(WHERE marketplace_facilitated\)/);
    expect(sql).toMatch(/GROUP BY jurisdiction/);
  });

  it("scopes the aggregate by org_id", async () => {
    const { executor, queries } = recordingExecutor();
    await createNexusRepository(executor).aggregateByJurisdiction(ORG, {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(queries[0]!.text).toMatch(/WHERE org_id = \$1/);
  });

  it("appends with ON CONFLICT DO NOTHING on the dedupe key", async () => {
    // The conflict target must be the dedupe index exactly. Naming the primary
    // key instead would make every redelivery a fresh row.
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).appendSaleEvents(ORG, [sampleInput()]);
    expect(queries[0]!.text).toMatch(
      /ON CONFLICT \(org_id, channel_id, provider_event_id, kind\) DO NOTHING/,
    );
    expect(queries[0]!.text).toMatch(/RETURNING \*/);
  });

  it("never emits an UPDATE against the ledger", async () => {
    // Invariant 2, checked at the only place SQL is written.
    const { executor, queries } = recordingExecutor([[], []]);
    const repo = createNexusRepository(executor);
    await repo.appendSaleEvents(ORG, [sampleInput()]);
    for (const q of queries) {
      expect(q.text).not.toMatch(/UPDATE\s+nexus\.sale_events/i);
      expect(q.text).not.toMatch(/DELETE\s+FROM\s+nexus\.sale_events/i);
    }
  });

  it("reads current determinations with DISTINCT ON, not N queries", async () => {
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).listCurrentDeterminations(ORG);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toMatch(/DISTINCT ON \(jurisdiction\)/);
    expect(queries[0]!.text).toMatch(/ORDER BY jurisdiction, evaluated_at DESC, id DESC/);
  });

  it("gates the alert insert on the once-index", async () => {
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).insertAlertOnce(ORG, {
      id: "00000000-0000-4000-8000-0000000000d1",
      jurisdiction: "US-TX",
      determinationId: asUuid("00000000-0000-4000-8000-0000000000e1"),
      kind: "crossed",
      sentAt: new Date("2026-08-04T07:00:00.000Z"),
      notificationRef: null,
    });
    expect(queries[0]!.text).toMatch(
      /ON CONFLICT \(org_id, jurisdiction, determination_id, kind\) DO NOTHING/,
    );
  });

  it("scopes the alert contact to one org on every verb (R10)", async () => {
    const repo = createNexusRepository(recordingExecutor([[]]).executor);
    void repo;
    for (const [label, run] of [
      ["get", (r: ReturnType<typeof createNexusRepository>) => r.getAlertContact(ORG)],
      [
        "upsert",
        (r: ReturnType<typeof createNexusRepository>) =>
          r.upsertAlertContact(ORG, {
            email: "a@b.co",
            label: null,
            now: new Date("2026-08-04T00:00:00.000Z"),
          }),
      ],
      ["delete", (r: ReturnType<typeof createNexusRepository>) => r.deleteAlertContact(ORG)],
    ] as const) {
      const { executor, queries } = recordingExecutor([[]]);
      await run(createNexusRepository(executor));
      // The CI tenancy scan enforces this too; asserting it here names the
      // verb that broke it when one does.
      expect({ label, scoped: /org_id/.test(queries[0]!.text) }).toEqual({ label, scoped: true });
      expect(queries[0]!.params[0]).toBe(ORG);
    }
  });

  it("upserts the contact rather than conflicting — one row per org", async () => {
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).upsertAlertContact(ORG, {
      email: "a@b.co",
      label: "Bookkeeper",
      now: new Date("2026-08-04T00:00:00.000Z"),
    });
    expect(queries[0]!.text).toMatch(/ON CONFLICT \(org_id\) DO UPDATE/);
    // created_at is preserved by EXCLUDED not touching it; updated_at moves.
    expect(queries[0]!.text).toMatch(/updated_at = EXCLUDED\.updated_at/);
    expect(queries[0]!.text).not.toMatch(/created_at = EXCLUDED/);
  });

  it("reports whether a delete actually removed anything", async () => {
    // Idempotent at the handler, but the repository still reports the truth —
    // a caller that wanted to know can.
    const gone = await createNexusRepository(recordingExecutor([[]]).executor).deleteAlertContact(
      ORG,
    );
    expect(gone).toEqual({ ok: true, value: false });

    const existed = await createNexusRepository(
      recordingExecutor([[{ org_id: ORG }]]).executor,
    ).deleteAlertContact(ORG);
    expect(existed).toEqual({ ok: true, value: true });
  });

  it("moves the watermark forward only, using GREATEST", async () => {
    // Two evaluations racing must not move the watermark backwards: the loser
    // writing last would re-do work, or worse, skip it.
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).setWatermark(
      ORG,
      new Date("2026-08-04T07:00:00.000Z"),
      new Date("2026-08-04T07:00:01.000Z"),
    );
    expect(queries[0]!.text).toMatch(/GREATEST\(nexus\.evaluation_watermarks\.last_ingested_at/);
  });

  it("advances channel activity forward only, so a backfill cannot drag it back", async () => {
    // A backfill walks history BACKWARDS. Assigning last_event_at directly
    // would make a freshly-connected channel look stale — the R3 failure
    // manufactured by our own bookkeeping.
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).touchChannelLastEvent(
      ORG,
      CHANNEL,
      new Date("2024-01-01T00:00:00.000Z"),
    );
    expect(queries[0]!.text).toMatch(/GREATEST\(COALESCE\(last_event_at/);
    expect(queries[0]!.text).toMatch(/WHERE org_id = \$1 AND id = \$2/);
  });

  it("keeps the tenant predicate in the SQL literal on filtered reads", async () => {
    // Not a style point: a `WHERE ${clauses.join(...)}` whose first element
    // happens to be the scoping predicate is one refactor away from not
    // being, and neither a reader nor the tenancy scan can see it.
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).listSaleEventsPaged(
      ORG,
      { jurisdiction: "US-TX", kind: "refund" },
      { limit: 10, cursor: null },
    );
    expect(queries[0]!.text).toMatch(/WHERE org_id = \$1 AND/);
  });
});

// ── Layer 2: mapping ─────────────────────────────────────────

describe("mapping", () => {
  it("reads BIGINT cents arriving as a string", async () => {
    // `postgres` hands BIGINT back as a string. A plain Number() would be
    // right until it silently was not.
    const { executor } = recordingExecutor([
      [
        {
          jurisdiction: "US-TX",
          direct_gross_cents: "4893001200",
          direct_retail_cents: "4893001200",
          direct_taxable_cents: "4410000000",
          direct_txns: "2140",
          mkt_gross_cents: "340050000",
          mkt_retail_cents: "340050000",
          mkt_taxable_cents: "340050000",
          mkt_txns: "190",
        },
      ],
    ]);
    const result = await createNexusRepository(executor).aggregateByJurisdiction(ORG, {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toEqual({
      jurisdiction: "US-TX",
      directGrossCents: 4_893_001_200,
      directRetailCents: 4_893_001_200,
      directTaxableCents: 4_410_000_000,
      directTransactions: 2_140,
      marketplaceGrossCents: 340_050_000,
      marketplaceRetailCents: 340_050_000,
      marketplaceTaxableCents: 340_050_000,
      marketplaceTransactions: 190,
    });
    for (const v of Object.values(result.value[0]!)) {
      if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("refuses a monetary value past the safe-integer range rather than rounding it", async () => {
    // Should never happen — 2^53 cents is ~$90 trillion — which is exactly
    // why it must be an error and not a silent float.
    const { executor } = recordingExecutor([
      [{ jurisdiction: "US-TX", direct_gross_cents: "99999999999999999999" }],
    ]);
    const result = await createNexusRepository(executor).aggregateByJurisdiction(ORG, {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid");
  });

  it("maps a DATE column to a civil date without a timezone shift", async () => {
    // `new Date('2026-09-01').toISOString()` is fine; formatting a Date the
    // driver built at LOCAL midnight is not, and shifts the deadline by a day.
    const { executor } = recordingExecutor([
      [determinationRow({ crossed_on: new Date(Date.UTC(2026, 7, 4)), registration_due_on: "2026-09-01" })],
    ]);
    const result = await createNexusRepository(executor).getDeterminationById(
      ORG,
      asUuid("00000000-0000-4000-8000-0000000000e1"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.crossedOn).toBe("2026-08-04");
    expect(result.value.registrationDueOn).toBe("2026-09-01");
  });

  it("parses the inputs JSONB whether the driver hands back a string or an object", async () => {
    const asString = recordingExecutor([
      [determinationRow({ inputs: JSON.stringify({ asOf: "2026-08-04T07:00:00.000Z" }) })],
    ]);
    const asObject = recordingExecutor([
      [determinationRow({ inputs: { asOf: "2026-08-04T07:00:00.000Z" } })],
    ]);
    const id = asUuid("00000000-0000-4000-8000-0000000000e1");
    const a = await createNexusRepository(asString.executor).getDeterminationById(ORG, id);
    const b = await createNexusRepository(asObject.executor).getDeterminationById(ORG, id);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.inputs).toEqual(b.value.inputs);
  });

  it("reports a missing row as not_found rather than throwing", async () => {
    const { executor } = recordingExecutor([[]]);
    const result = await createNexusRepository(executor).getSaleEventById(
      ORG,
      asUuid("00000000-0000-4000-8000-0000000000f1"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_found");
  });

  it("reports 'already sent' as a null alert, not an error", async () => {
    const { executor } = recordingExecutor([[]]);
    const result = await createNexusRepository(executor).insertAlertOnce(ORG, {
      id: "00000000-0000-4000-8000-0000000000d1",
      jurisdiction: "US-TX",
      determinationId: asUuid("00000000-0000-4000-8000-0000000000e1"),
      kind: "crossed",
      sentAt: new Date("2026-08-04T07:00:00.000Z"),
      notificationRef: null,
    });
    expect(result).toEqual({ ok: true, value: null });
  });
});

// ── Layer 3: behaviour over a seeded ledger ──────────────────

/**
 * A deliberately narrow stand-in for Postgres.
 *
 * It implements exactly two statements — the ledger's multi-row
 * `INSERT … ON CONFLICT DO NOTHING RETURNING *`, and the §5.1 aggregate — over
 * an in-memory row array, with the same unique key and the same half-open
 * bounds the real schema enforces.
 *
 * It exists so that dedupe, refunds, and window arithmetic can be asserted
 * *through the real repository code* against hand-computed fixtures. It is not
 * a claim that Postgres agrees; the query-shape assertions above are what
 * guard that, and the stage walkthrough is what confirms it.
 */
function seededExecutor(): { executor: SqlExecutor; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const key = (r: Record<string, unknown>): string =>
    `${r.org_id as string}|${r.channel_id as string}|${r.provider_event_id as string}|${r.kind as string}`;

  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<SqlExecutorResult<T>> {
      if (/^\s*INSERT INTO nexus\.sale_events/.test(text)) {
        const COLS = [
          "id", "org_id", "channel_id", "source", "provider_event_id", "kind",
          "reverses_event_id", "occurred_at", "jurisdiction", "jurisdiction_source",
          "ship_to_country", "ship_to_region", "gross_cents", "retail_cents",
          "taxable_cents", "transaction_count", "marketplace_facilitated", "currency",
        ];
        const inserted: Record<string, unknown>[] = [];
        for (let i = 0; i < params.length; i += COLS.length) {
          const row: Record<string, unknown> = { ingested_at: "2026-08-04T07:00:00.000Z" };
          COLS.forEach((c, j) => (row[c] = params[i + j]));
          if (rows.some((existing) => key(existing) === key(row))) continue; // ON CONFLICT DO NOTHING
          rows.push(row);
          inserted.push(row);
        }
        return { rows: inserted as unknown as T[], rowCount: inserted.length };
      }

      if (/SELECT id, channel_id, provider_event_id, kind/.test(text)) {
        const [orgId, channelIds, providerIds] = params as [string, string[], string[]];
        const matched = rows.filter(
          (r) =>
            r.org_id === orgId &&
            channelIds.includes(r.channel_id as string) &&
            providerIds.includes(r.provider_event_id as string),
        );
        return { rows: matched as unknown as T[], rowCount: matched.length };
      }

      if (/GROUP BY jurisdiction/.test(text)) {
        const [orgId, start, end] = params as [string, string, string];
        const inWindow = rows.filter(
          (r) =>
            r.org_id === orgId &&
            // Half-open, exactly as the SQL says.
            (r.occurred_at as string) >= start &&
            (r.occurred_at as string) < end,
        );
        const byJurisdiction = new Map<string, Record<string, number>>();
        for (const r of inWindow) {
          const j = r.jurisdiction as string;
          const acc = byJurisdiction.get(j) ?? {
            direct_gross_cents: 0, direct_retail_cents: 0, direct_taxable_cents: 0, direct_txns: 0,
            mkt_gross_cents: 0, mkt_retail_cents: 0, mkt_taxable_cents: 0, mkt_txns: 0,
          };
          const p = r.marketplace_facilitated ? "mkt" : "direct";
          acc[`${p}_gross_cents`]! += r.gross_cents as number;
          acc[`${p}_retail_cents`]! += r.retail_cents as number;
          acc[`${p}_taxable_cents`]! += r.taxable_cents as number;
          acc[`${p}_txns`]! += r.transaction_count as number;
          byJurisdiction.set(j, acc);
        }
        const out = [...byJurisdiction.entries()]
          .map(([jurisdiction, acc]) => ({ jurisdiction, ...acc }))
          .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));
        return { rows: out as unknown as T[], rowCount: out.length };
      }

      return { rows: [] as unknown as T[], rowCount: 0 };
    },
  };
  return { executor, rows };
}

describe("behaviour over a seeded ledger", () => {
  /**
   * The fixture, hand-computed:
   *
   *   TX  2026-03-04  sale    $1,200  direct
   *   TX  2026-06-15  sale    $2,300  direct
   *   TX  2026-07-02  sale    $500    MARKETPLACE
   *   TX  2026-08-01  refund  −$1,200 direct   (reverses the March sale)
   *   CA  2025-11-20  sale    $9,000  direct   (previous calendar year)
   *
   * Calendar year 2026, direct only  = 1200 + 2300 − 1200 = $2,300, 1 txn
   * Calendar year 2026, incl. mkt    = $2,800, 2 txns
   * Previous calendar year (2025)    = CA $9,000 only; TX has nothing
   */
  const SEED: AppendSaleEventInput[] = [
    input({ id: "1", providerEventId: "ch_mar", occurredAt: "2026-03-04T15:00:00.000Z", cents: USD(1_200) }),
    input({ id: "2", providerEventId: "ch_jun", occurredAt: "2026-06-15T15:00:00.000Z", cents: USD(2_300) }),
    input({
      id: "3",
      providerEventId: "ch_jul",
      occurredAt: "2026-07-02T15:00:00.000Z",
      cents: USD(500),
      marketplaceFacilitated: true,
    }),
    input({
      id: "4",
      providerEventId: "re_mar",
      occurredAt: "2026-08-01T15:00:00.000Z",
      cents: -USD(1_200),
      kind: "refund",
      reversesEventId: asUuid("00000000-0000-4000-8000-000000000001"),
      transactionCount: -1,
    }),
    input({
      id: "5",
      providerEventId: "ch_nov",
      occurredAt: "2025-11-20T15:00:00.000Z",
      cents: USD(9_000),
      jurisdiction: "US-CA",
    }),
  ];

  async function seeded() {
    const { executor, rows } = seededExecutor();
    const repo = createNexusRepository(executor);
    const appended = await repo.appendSaleEvents(ORG, SEED);
    return { repo, rows, appended };
  }

  it("applies every distinct row once", async () => {
    const { appended } = await seeded();
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.value).toMatchObject({ submitted: 5, applied: 5, duplicates: 0 });
    expect(appended.value.divergent).toEqual([]);
  });

  it("treats a replayed batch as a no-op — the backfill/live-sync overlap", async () => {
    // Design §6.3: the seam is covered from both sides deliberately, and the
    // overlap is free because deduplication is a database constraint rather
    // than application logic.
    const { repo } = await seeded();
    const replay = await repo.appendSaleEvents(ORG, SEED);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value).toMatchObject({ submitted: 5, applied: 0, duplicates: 5 });
    expect(replay.value.divergent).toEqual([]);
  });

  it("flags an amended re-delivery as divergent, not as an ordinary duplicate", async () => {
    // NX1.5 finding S-8 / R9. The same charge id with a different amount is
    // dropped by ON CONFLICT and the first amount stands forever. That is the
    // one case where a silent no-op is wrong.
    const { repo } = await seeded();
    const amended = await repo.appendSaleEvents(ORG, [
      input({ id: "1", providerEventId: "ch_mar", occurredAt: "2026-03-04T15:00:00.000Z", cents: USD(1_450) }),
    ]);
    expect(amended.ok).toBe(true);
    if (!amended.ok) return;
    expect(amended.value.applied).toBe(0);
    expect(amended.value.duplicates).toBe(1);
    expect(amended.value.divergent).toEqual([
      {
        providerEventId: "ch_mar",
        kind: "sale",
        storedId: "1",
        storedGrossCents: USD(1_200),
        submittedGrossCents: USD(1_450),
        storedTransactionCount: 1,
        submittedTransactionCount: 1,
      },
    ]);
  });

  it("does not flag an identical re-delivery as divergent", async () => {
    const { repo } = await seeded();
    const identical = await repo.appendSaleEvents(ORG, [SEED[0]!]);
    expect(identical.ok).toBe(true);
    if (!identical.ok) return;
    expect(identical.value.duplicates).toBe(1);
    expect(identical.value.divergent).toEqual([]);
  });

  it("keeps two tenants' identical provider ids apart", async () => {
    // The dedupe key leads with org_id. Two sellers processing through the
    // same Stripe platform can legitimately see the same charge id.
    const { repo, rows } = await seeded();
    const other = await repo.appendSaleEvents(OTHER_ORG, [SEED[0]!]);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.value.applied).toBe(1);
    expect(rows).toHaveLength(6);
  });

  it("matches the hand-computed calendar-year fixture, with the refund netted", async () => {
    const { repo } = await seeded();
    const agg = await repo.aggregateByJurisdiction(ORG, {
      start: new Date("2026-01-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;

    const tx = agg.value.find((a) => a.jurisdiction === "US-TX")!;
    // 1200 + 2300 − 1200 = 2300 direct; the marketplace 500 stays separate so
    // the engine can include or exclude it per the rule.
    expect(tx.directGrossCents).toBe(USD(2_300));
    expect(tx.directTransactions).toBe(1); // 1 + 1 − 1
    expect(tx.marketplaceGrossCents).toBe(USD(500));
    expect(tx.marketplaceTransactions).toBe(1);
    // 2025's CA sale is outside this window entirely.
    expect(agg.value.find((a) => a.jurisdiction === "US-CA")).toBeUndefined();
  });

  it("matches the hand-computed previous-calendar-year fixture", async () => {
    const { repo } = await seeded();
    const agg = await repo.aggregateByJurisdiction(ORG, {
      start: new Date("2025-01-01T00:00:00.000Z"),
      end: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;
    expect(agg.value.map((a) => a.jurisdiction)).toEqual(["US-CA"]);
    expect(agg.value[0]!.directGrossCents).toBe(USD(9_000));
  });

  it("matches the hand-computed rolling-12-month fixture", async () => {
    // 2025-08-05 → 2026-08-05: everything except the November 2025 CA sale…
    // no — November 2025 IS inside a window starting August 2025. Both
    // jurisdictions appear, which is the point of checking a third window
    // shape rather than assuming two are enough.
    const { repo } = await seeded();
    const agg = await repo.aggregateByJurisdiction(ORG, {
      start: new Date("2025-08-05T05:00:00.000Z"),
      end: new Date("2026-08-05T05:00:00.000Z"),
    });
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;
    expect(agg.value.map((a) => a.jurisdiction)).toEqual(["US-CA", "US-TX"]);
    expect(agg.value.find((a) => a.jurisdiction === "US-CA")!.directGrossCents).toBe(USD(9_000));
    expect(agg.value.find((a) => a.jurisdiction === "US-TX")!.directGrossCents).toBe(USD(2_300));
  });

  it("excludes a row landing exactly on the window's upper bound", async () => {
    // The half-open boundary, proven at the value level rather than only in
    // the SQL text. A window ending 2026-07-02T15:00 must NOT contain the sale
    // stamped at exactly that instant.
    const { repo } = await seeded();
    const agg = await repo.aggregateByJurisdiction(ORG, {
      start: new Date("2026-06-15T15:00:00.000Z"),
      end: new Date("2026-07-02T15:00:00.000Z"),
    });
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;
    const tx = agg.value.find((a) => a.jurisdiction === "US-TX")!;
    // Includes the 15 June sale (>= start), excludes the 2 July one (< end).
    expect(tx.directGrossCents).toBe(USD(2_300));
    expect(tx.marketplaceGrossCents).toBe(0);
  });

  it("rejects an oversized batch rather than issuing it", async () => {
    const { executor } = seededExecutor();
    const huge = Array.from({ length: 1_001 }, (_, i) =>
      input({ id: `x${i}`, providerEventId: `ch_${i}`, occurredAt: "2026-01-01T00:00:00.000Z", cents: 1 }),
    );
    const result = await createNexusRepository(executor).appendSaleEvents(ORG, huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid");
  });

  it("treats an empty batch as a successful no-op", async () => {
    const { executor } = seededExecutor();
    const result = await createNexusRepository(executor).appendSaleEvents(ORG, []);
    expect(result).toEqual({
      ok: true,
      value: { submitted: 0, applied: 0, duplicates: 0, divergent: [], events: [] },
    });
  });
});

// ── Rules: the global-reference-data exemption ───────────────

describe("rule reads", () => {
  it("looks up the rule in force with a half-open effective range", async () => {
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).listRulesInForce(RULE_SET, "2026-08-04");
    const sql = queries[0]!.text;
    expect(sql).toMatch(/effective_from <= \$2/);
    expect(sql).toMatch(/effective_to IS NULL OR r\.effective_to > \$2/);
    expect(sql).not.toMatch(/org_id/);
  });

  it("finds every rule overlapping a window, for the mid-window split", async () => {
    // §5.3 case 3's input: more than one row back means the window has a rule
    // change in it and must be split.
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).listRulesOverlapping(
      RULE_SET,
      "US-TX",
      "2026-01-01",
      "2027-01-01",
    );
    const sql = queries[0]!.text;
    expect(sql).toMatch(/effective_from < \$4/);
    expect(sql).toMatch(/effective_to IS NULL OR r\.effective_to > \$3/);
    expect(sql).toMatch(/ORDER BY r\.effective_from/);
  });

  it("carries the rule-set version alongside the rule, for the reproducibility triple", async () => {
    const { executor, queries } = recordingExecutor([[]]);
    await createNexusRepository(executor).getRuleById(
      asUuid("00000000-0000-4000-8000-0000000000c9"),
    );
    expect(queries[0]!.text).toMatch(/s\.version AS rule_set_version/);
  });
});

// ── Fixtures ─────────────────────────────────────────────────

function input(o: {
  id: string;
  providerEventId: string;
  occurredAt: string;
  cents: number;
  kind?: "sale" | "refund";
  reversesEventId?: ReturnType<typeof asUuid> | null;
  transactionCount?: number;
  marketplaceFacilitated?: boolean;
  jurisdiction?: string;
}): AppendSaleEventInput {
  return {
    id: o.id,
    channelId: CHANNEL,
    source: "csv",
    providerEventId: o.providerEventId,
    kind: o.kind ?? "sale",
    reversesEventId: o.reversesEventId ?? null,
    occurredAt: new Date(o.occurredAt),
    jurisdiction: o.jurisdiction ?? "US-TX",
    jurisdictionSource: "declared",
    shipToCountry: "US",
    shipToRegion: (o.jurisdiction ?? "US-TX").slice(3),
    grossCents: o.cents,
    retailCents: o.cents,
    taxableCents: o.cents,
    transactionCount: o.transactionCount ?? 1,
    marketplaceFacilitated: o.marketplaceFacilitated ?? false,
    currency: "USD",
  };
}

function sampleInput(): AppendSaleEventInput {
  return input({
    id: "00000000-0000-4000-8000-000000000001",
    providerEventId: "ch_sample",
    occurredAt: "2026-03-04T15:00:00.000Z",
    cents: USD(100),
  });
}

function determinationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-0000000000e1",
    org_id: ORG,
    jurisdiction: "US-TX",
    evaluated_at: "2026-08-04T07:00:00.000Z",
    rule_set_version: "2026.08.01",
    rule_id: "00000000-0000-4000-8000-0000000000c9",
    engine_version: "1.0.0",
    period_start: "2025-08-05T05:00:00.000Z",
    period_end: "2026-08-05T05:00:00.000Z",
    measured_sales_cents: "5233051200",
    measured_transactions: 2330,
    threshold_sales_cents: "50000000",
    threshold_transactions: null,
    status: "crossed",
    crossed_on: "2026-08-04",
    registration_due_on: "2026-09-01",
    inputs: {},
    internal_only: true,
    ...overrides,
  };
}
