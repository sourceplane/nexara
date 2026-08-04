// The nexus repository — the only place SQL is written against the `nexus`
// schema.
//
// Two conventions are load-bearing and are verified by
// `tests/db/src/tenancy-scan.test.ts` rather than trusted:
//
//   1. **Every tenant query carries `org_id = $`.** Design §7.3 chooses query
//      scoping over Postgres RLS because `SET LOCAL app.current_org` on a
//      Hyperdrive-pooled connection leaks a tenant context onto whichever
//      request borrows the socket next. Query scoping cannot fail that way and
//      has no defence-in-depth either, so it has to be enforced structurally.
//   2. **A query that genuinely cannot be scoped carries a
//      `tenancy-exempt:` marker at its call site**, naming which of the three
//      allowed reasons applies. NX1.5 finding S-9 narrowed the exemption list
//      from "two tables" to "these specific call sites", because exempting by
//      table name would disarm the scan for every future read of those tables.
//
// Money crosses the driver boundary as a string (`BIGINT` does not fit a JS
// number in the general case). `toCents` converts and *validates*; a silent
// `Number()` would turn an out-of-range value into a float and a rounding
// error into a threshold answer.

import type { SqlExecutor } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  AlertRow,
  AppendResult,
  AppendSaleEventInput,
  CursorPosition,
  DeterminationRow,
  DivergentEvent,
  InsertAlertInput,
  InsertDeterminationInput,
  JurisdictionAggregateRow,
  LedgerFilters,
  NexusRepository,
  NexusResult,
  PageQueryParams,
  PagedResult,
  AlertContactRow,
  RegistrationRow,
  RuleRow,
  RuleSetRow,
  SaleEvent,
  UpsertRegistrationInput,
  WatermarkRow,
  WindowBounds,
  UpsertAlertContactInput,
} from "./types.js";

// ── Value coercion ───────────────────────────────────────────

/**
 * A `BIGINT` cents column → a safe JS integer.
 *
 * `postgres` returns `BIGINT` as a string. `Number(str)` on a value past
 * 2^53 silently loses precision, and losing precision on a monetary total is
 * how a seller ends up on the wrong side of a line with no error anywhere.
 * 2^53 cents is ~$90 trillion, so the guard should never fire — which is
 * exactly why it must throw rather than round when it does.
 */
function toCents(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Monetary value is not a safe integer: ${String(raw)}`);
  }
  return n;
}

function toCentsOrNull(raw: unknown): number | null {
  return raw === null || raw === undefined ? null : toCents(raw);
}

function toCount(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Count is not a safe integer: ${String(raw)}`);
  }
  return n;
}

/** A `DATE` column → `YYYY-MM-DD`. The driver may hand back a `Date` pinned to
 *  UTC midnight or the string itself; both must render as the same civil date,
 *  and `new Date(...).toISOString()` on a local-midnight `Date` would shift it
 *  by a day. */
function toCivilDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    return `${raw.getUTCFullYear().toString().padStart(4, "0")}-${(raw.getUTCMonth() + 1)
      .toString()
      .padStart(2, "0")}-${raw.getUTCDate().toString().padStart(2, "0")}`;
  }
  return String(raw).slice(0, 10);
}

function safeError(message: string): NexusResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

const MAX_APPEND_BATCH = 1_000;

// ── Row mappers ──────────────────────────────────────────────

function mapSaleEvent(row: Record<string, unknown>): SaleEvent {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    channelId: row.channel_id as string,
    source: row.source as SaleEvent["source"],
    providerEventId: row.provider_event_id as string,
    kind: row.kind as SaleEvent["kind"],
    reversesEventId: (row.reverses_event_id as string | null) ?? null,
    occurredAt: new Date(row.occurred_at as string),
    jurisdiction: row.jurisdiction as string,
    jurisdictionSource: row.jurisdiction_source as SaleEvent["jurisdictionSource"],
    shipToCountry: (row.ship_to_country as string | null) ?? null,
    shipToRegion: (row.ship_to_region as string | null) ?? null,
    grossCents: toCents(row.gross_cents),
    retailCents: toCents(row.retail_cents),
    taxableCents: toCents(row.taxable_cents),
    transactionCount: toCount(row.transaction_count),
    marketplaceFacilitated: Boolean(row.marketplace_facilitated),
    currency: row.currency as string,
    ingestedAt: new Date(row.ingested_at as string),
  };
}

function mapAggregate(row: Record<string, unknown>): JurisdictionAggregateRow {
  return {
    jurisdiction: row.jurisdiction as string,
    directGrossCents: toCents(row.direct_gross_cents),
    directRetailCents: toCents(row.direct_retail_cents),
    directTaxableCents: toCents(row.direct_taxable_cents),
    directTransactions: toCount(row.direct_txns),
    marketplaceGrossCents: toCents(row.mkt_gross_cents),
    marketplaceRetailCents: toCents(row.mkt_retail_cents),
    marketplaceTaxableCents: toCents(row.mkt_taxable_cents),
    marketplaceTransactions: toCount(row.mkt_txns),
  };
}

function mapRuleSet(row: Record<string, unknown>): RuleSetRow {
  return {
    id: row.id as string,
    version: row.version as string,
    publishedAt: new Date(row.published_at as string),
    verified: Boolean(row.verified),
    sourceNote: (row.source_note as string | null) ?? null,
  };
}

function mapRule(row: Record<string, unknown>): RuleRow {
  return {
    id: row.id as string,
    ruleSetId: row.rule_set_id as string,
    ruleSetVersion: (row.rule_set_version as string | undefined) ?? "",
    jurisdiction: row.jurisdiction as string,
    effectiveFrom: toCivilDate(row.effective_from)!,
    effectiveTo: toCivilDate(row.effective_to),
    measurementBasis: row.measurement_basis as RuleRow["measurementBasis"],
    measurementPeriod: row.measurement_period as RuleRow["measurementPeriod"],
    measurementTimezone: row.measurement_timezone as string,
    salesThresholdCents: toCentsOrNull(row.sales_threshold_cents),
    transactionThreshold:
      row.transaction_threshold === null || row.transaction_threshold === undefined
        ? null
        : toCount(row.transaction_threshold),
    thresholdLogic: row.threshold_logic as RuleRow["thresholdLogic"],
    marketplaceTreatment: row.marketplace_treatment as RuleRow["marketplaceTreatment"],
    registrationDeadlineRule: parseJson(row.registration_deadline_rule) as RuleRow["registrationDeadlineRule"],
    notes: (row.notes as string | null) ?? null,
  };
}

function mapDetermination(row: Record<string, unknown>): DeterminationRow {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    jurisdiction: row.jurisdiction as string,
    evaluatedAt: new Date(row.evaluated_at as string),
    ruleSetVersion: row.rule_set_version as string,
    ruleId: row.rule_id as string,
    engineVersion: row.engine_version as string,
    periodStart: new Date(row.period_start as string),
    periodEnd: new Date(row.period_end as string),
    measuredSalesCents: toCents(row.measured_sales_cents),
    measuredTransactions: toCount(row.measured_transactions),
    thresholdSalesCents: toCentsOrNull(row.threshold_sales_cents),
    thresholdTransactions:
      row.threshold_transactions === null || row.threshold_transactions === undefined
        ? null
        : toCount(row.threshold_transactions),
    status: row.status as DeterminationRow["status"],
    crossedOn: toCivilDate(row.crossed_on),
    registrationDueOn: toCivilDate(row.registration_due_on),
    inputs: parseJson(row.inputs) as DeterminationRow["inputs"],
    internalOnly: Boolean(row.internal_only),
  };
}

function mapAlertContact(row: Record<string, unknown>): AlertContactRow {
  return {
    orgId: row.org_id as string,
    email: row.email as string,
    label: (row.label as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapRegistration(row: Record<string, unknown>): RegistrationRow {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    jurisdiction: row.jurisdiction as string,
    status: row.status as RegistrationRow["status"],
    registeredOn: toCivilDate(row.registered_on),
    permitRef: (row.permit_ref as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapAlert(row: Record<string, unknown>): AlertRow {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    jurisdiction: row.jurisdiction as string,
    determinationId: row.determination_id as string,
    kind: row.kind as AlertRow["kind"],
    sentAt: new Date(row.sent_at as string),
    notificationRef: (row.notification_ref as string | null) ?? null,
  };
}

function parseJson(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

// ── The repository ───────────────────────────────────────────

export function createNexusRepository(executor: SqlExecutor): NexusRepository {
  return {
    async appendSaleEvents(orgId: Uuid, rows: AppendSaleEventInput[]): Promise<NexusResult<AppendResult>> {
      if (rows.length === 0) {
        return { ok: true, value: { submitted: 0, applied: 0, duplicates: 0, divergent: [], events: [] } };
      }
      if (rows.length > MAX_APPEND_BATCH) {
        return {
          ok: false,
          error: { kind: "invalid", message: `Batch of ${rows.length} exceeds ${MAX_APPEND_BATCH}` },
        };
      }

      try {
        // One multi-row INSERT rather than N round trips: a backfill page is
        // up to 100 events and a per-row insert would make the page latency
        // the page size times the RTT.
        const columns = 18;
        const values: unknown[] = [];
        const tuples: string[] = [];
        rows.forEach((row, i) => {
          const b = i * columns;
          tuples.push(
            `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, ` +
              `$${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13}, $${b + 14}, $${b + 15}, ` +
              `$${b + 16}, $${b + 17}, $${b + 18})`,
          );
          values.push(
            row.id,
            orgId,
            row.channelId,
            row.source,
            row.providerEventId,
            row.kind,
            row.reversesEventId,
            row.occurredAt.toISOString(),
            row.jurisdiction,
            row.jurisdictionSource,
            row.shipToCountry,
            row.shipToRegion,
            row.grossCents,
            row.retailCents,
            row.taxableCents,
            row.transactionCount,
            row.marketplaceFacilitated,
            row.currency,
          );
        });

        // THE idempotency guarantee (design §6.4). A duplicate webhook
        // delivery, or a backfill page overlapping live sync, is a no-op at
        // the database level. An empty return for a row means "already
        // applied", which is success, not error.
        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.sale_events (
             id, org_id, channel_id, source, provider_event_id, kind, reverses_event_id,
             occurred_at, jurisdiction, jurisdiction_source, ship_to_country, ship_to_region,
             gross_cents, retail_cents, taxable_cents, transaction_count,
             marketplace_facilitated, currency)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (org_id, channel_id, provider_event_id, kind) DO NOTHING
           RETURNING *`,
          values,
        );

        const events = inserted.rows.map(mapSaleEvent);
        const appliedKeys = new Set(events.map((e) => `${e.channelId}|${e.providerEventId}|${e.kind}`));
        const conflicted = rows.filter(
          (r) => !appliedKeys.has(`${r.channelId}|${r.providerEventId}|${r.kind}`),
        );

        // NX1.5 finding S-8 / R9. `ON CONFLICT DO NOTHING` cannot tell an
        // identical redelivery from an amended one, and an append-only ledger
        // has no correction path — so the first amount would stand forever
        // with nothing anywhere saying so. Read the stored rows back and
        // compare. This costs one extra query *only when something
        // conflicted*, which on the steady-state path is never.
        const divergent =
          conflicted.length > 0 ? await findDivergent(executor, orgId, conflicted) : [];

        return {
          ok: true,
          value: {
            submitted: rows.length,
            applied: events.length,
            duplicates: conflicted.length,
            divergent,
            events,
          },
        };
      } catch (err) {
        if (isUniqueViolation(err)) {
          // The dedupe index is handled by ON CONFLICT; a unique violation
          // here is the primary key, i.e. a caller reusing an id.
          return { ok: false, error: { kind: "conflict", entity: "sale_event" } };
        }
        if (err instanceof RangeError) {
          return { ok: false, error: { kind: "invalid", message: err.message } };
        }
        return safeError("Failed to append sale events");
      }
    },

    async listSaleEventsPaged(
      orgId: Uuid,
      filters: LedgerFilters,
      params: PageQueryParams,
    ): Promise<NexusResult<PagedResult<SaleEvent>>> {
      try {
        const values: unknown[] = [orgId];
        // The tenant predicate is written into the SQL literal below, NOT
        // pushed onto this list. The tenancy scan flagged the assembled form
        // on its first run and it was right to: a `WHERE ${clauses.join(...)}`
        // whose first element happens to be the scoping predicate is one
        // refactor away from not being, and neither the reader nor the scan
        // can see it. `clauses` holds only optional filters.
        const clauses: string[] = [];

        if (filters.jurisdiction) {
          values.push(filters.jurisdiction);
          clauses.push(`jurisdiction = $${values.length}`);
        }
        if (filters.channelId) {
          values.push(filters.channelId);
          clauses.push(`channel_id = $${values.length}`);
        }
        if (filters.kind) {
          values.push(filters.kind);
          clauses.push(`kind = $${values.length}`);
        }
        if (filters.since) {
          values.push(filters.since.toISOString());
          clauses.push(`occurred_at >= $${values.length}`);
        }
        if (filters.until) {
          // Half-open, matching every other range in this context.
          values.push(filters.until.toISOString());
          clauses.push(`occurred_at < $${values.length}`);
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          clauses.push(`(occurred_at, id) < ($${values.length - 1}, $${values.length})`);
        }

        values.push(params.limit + 1);
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.sale_events
           WHERE org_id = $1${andAll(clauses)}
           ORDER BY occurred_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );

        return { ok: true, value: page(result.rows.map(mapSaleEvent), params.limit, (e) => ({
          createdAt: e.occurredAt.toISOString(),
          id: e.id,
        })) };
      } catch {
        return safeError("Failed to list sale events");
      }
    },

    async getSaleEventById(orgId: Uuid, id: Uuid): Promise<NexusResult<SaleEvent>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.sale_events WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapSaleEvent(result.rows[0]!) };
      } catch {
        return safeError("Failed to get sale event");
      }
    },

    async aggregateByJurisdiction(
      orgId: Uuid,
      window: WindowBounds,
      jurisdictions?: readonly string[],
    ): Promise<NexusResult<JurisdictionAggregateRow[]>> {
      try {
        const values: unknown[] = [orgId, window.start.toISOString(), window.end.toISOString()];
        let jurisdictionClause = "";
        if (jurisdictions && jurisdictions.length > 0) {
          values.push(jurisdictions);
          jurisdictionClause = ` AND jurisdiction = ANY($${values.length})`;
        }

        // Design §5.1 — all three bases split by marketplace treatment in ONE
        // grouped scan, served by nexus_sale_events_agg_idx. The naive shape
        // runs a query per (basis × treatment × period); this returns every
        // variant and lets the pure engine choose.
        //
        // Refunds are already negative rows, so SUM handles reversals with no
        // special casing — the payoff for the ledger being append-only.
        //
        // The window is half-open: >= start AND < end, never BETWEEN.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT jurisdiction,
                  COALESCE(SUM(gross_cents)       FILTER (WHERE NOT marketplace_facilitated), 0) AS direct_gross_cents,
                  COALESCE(SUM(retail_cents)      FILTER (WHERE NOT marketplace_facilitated), 0) AS direct_retail_cents,
                  COALESCE(SUM(taxable_cents)     FILTER (WHERE NOT marketplace_facilitated), 0) AS direct_taxable_cents,
                  COALESCE(SUM(transaction_count) FILTER (WHERE NOT marketplace_facilitated), 0) AS direct_txns,
                  COALESCE(SUM(gross_cents)       FILTER (WHERE marketplace_facilitated), 0)     AS mkt_gross_cents,
                  COALESCE(SUM(retail_cents)      FILTER (WHERE marketplace_facilitated), 0)     AS mkt_retail_cents,
                  COALESCE(SUM(taxable_cents)     FILTER (WHERE marketplace_facilitated), 0)     AS mkt_taxable_cents,
                  COALESCE(SUM(transaction_count) FILTER (WHERE marketplace_facilitated), 0)     AS mkt_txns
           FROM nexus.sale_events
           WHERE org_id = $1
             AND occurred_at >= $2
             AND occurred_at <  $3${jurisdictionClause}
           GROUP BY jurisdiction
           ORDER BY jurisdiction`,
          values,
        );
        return { ok: true, value: result.rows.map(mapAggregate) };
      } catch (err) {
        if (err instanceof RangeError) {
          return { ok: false, error: { kind: "invalid", message: err.message } };
        }
        return safeError("Failed to aggregate sale events");
      }
    },

    async listActiveJurisdictions(orgId: Uuid): Promise<NexusResult<string[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT jurisdiction FROM nexus.sale_events
           WHERE org_id = $1 ORDER BY jurisdiction`,
          [orgId],
        );
        return { ok: true, value: result.rows.map((r) => r.jurisdiction as string) };
      } catch {
        return safeError("Failed to list jurisdictions");
      }
    },

    async getCurrentRuleSet(): Promise<NexusResult<RuleSetRow>> {
      try {
        // tenancy-exempt: global-reference-data — nexus.rule_sets is shared
        // across tenants by design §3.3 and carries no org_id column.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.rule_sets ORDER BY published_at DESC, id DESC LIMIT 1`,
          [],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRuleSet(result.rows[0]!) };
      } catch {
        return safeError("Failed to get current rule set");
      }
    },

    async getRuleSetByVersion(version: string): Promise<NexusResult<RuleSetRow>> {
      try {
        // tenancy-exempt: global-reference-data
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.rule_sets WHERE version = $1`,
          [version],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRuleSet(result.rows[0]!) };
      } catch {
        return safeError("Failed to get rule set");
      }
    },

    async listRulesInForce(ruleSetId: Uuid, onDate: string): Promise<NexusResult<RuleRow[]>> {
      try {
        // tenancy-exempt: global-reference-data — nexus.rules carries no
        // org_id. The EXCLUDE constraint added at NX1.5 guarantees at most one
        // rule per jurisdiction is in force on any date, so this returns one
        // row per jurisdiction without a DISTINCT ON.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT r.*, s.version AS rule_set_version
           FROM nexus.rules r
           JOIN nexus.rule_sets s ON s.id = r.rule_set_id
           WHERE r.rule_set_id = $1
             AND r.effective_from <= $2
             AND (r.effective_to IS NULL OR r.effective_to > $2)
           ORDER BY r.jurisdiction`,
          [ruleSetId, onDate],
        );
        return { ok: true, value: result.rows.map(mapRule) };
      } catch {
        return safeError("Failed to list rules in force");
      }
    },

    async listRulesOverlapping(
      ruleSetId: Uuid,
      jurisdiction: string,
      from: string,
      to: string,
    ): Promise<NexusResult<RuleRow[]>> {
      try {
        // tenancy-exempt: global-reference-data
        // The input to design §5.3 case 3: when more than one row comes back,
        // the window has a rule change in it and must be split.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT r.*, s.version AS rule_set_version
           FROM nexus.rules r
           JOIN nexus.rule_sets s ON s.id = r.rule_set_id
           WHERE r.rule_set_id = $1
             AND r.jurisdiction = $2
             AND r.effective_from < $4
             AND (r.effective_to IS NULL OR r.effective_to > $3)
           ORDER BY r.effective_from`,
          [ruleSetId, jurisdiction, from, to],
        );
        return { ok: true, value: result.rows.map(mapRule) };
      } catch {
        return safeError("Failed to list overlapping rules");
      }
    },

    async getRuleById(ruleId: Uuid): Promise<NexusResult<RuleRow>> {
      try {
        // tenancy-exempt: global-reference-data
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT r.*, s.version AS rule_set_version
           FROM nexus.rules r
           JOIN nexus.rule_sets s ON s.id = r.rule_set_id
           WHERE r.id = $1`,
          [ruleId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRule(result.rows[0]!) };
      } catch {
        return safeError("Failed to get rule");
      }
    },

    async insertDetermination(
      orgId: Uuid,
      input: InsertDeterminationInput,
    ): Promise<NexusResult<DeterminationRow>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.determinations (
             id, org_id, jurisdiction, evaluated_at, rule_set_version, rule_id, engine_version,
             period_start, period_end, measured_sales_cents, measured_transactions,
             threshold_sales_cents, threshold_transactions, status, crossed_on,
             registration_due_on, inputs, internal_only)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING *`,
          [
            input.id,
            orgId,
            input.jurisdiction,
            input.evaluatedAt.toISOString(),
            input.ruleSetVersion,
            input.ruleId,
            input.engineVersion,
            input.periodStart.toISOString(),
            input.periodEnd.toISOString(),
            input.measuredSalesCents,
            input.measuredTransactions,
            input.thresholdSalesCents,
            input.thresholdTransactions,
            input.status,
            input.crossedOn,
            input.registrationDueOn,
            JSON.stringify(input.inputs),
            input.internalOnly,
          ],
        );
        return { ok: true, value: mapDetermination(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "determination" } };
        }
        return safeError("Failed to insert determination");
      }
    },

    async listCurrentDeterminations(orgId: Uuid): Promise<NexusResult<DeterminationRow[]>> {
      try {
        // "Current position" is the first row of nexus_determinations_current_idx
        // per jurisdiction; DISTINCT ON reads exactly that and stops.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT DISTINCT ON (jurisdiction) *
           FROM nexus.determinations
           WHERE org_id = $1
           ORDER BY jurisdiction, evaluated_at DESC, id DESC`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapDetermination) };
      } catch {
        return safeError("Failed to list current determinations");
      }
    },

    async listDeterminationsPaged(
      orgId: Uuid,
      jurisdiction: string | null,
      params: PageQueryParams,
    ): Promise<NexusResult<PagedResult<DeterminationRow>>> {
      try {
        const values: unknown[] = [orgId];
        // Same discipline as listSaleEventsPaged: the tenant predicate is in
        // the literal, the optional filters are in this list.
        const clauses: string[] = [];
        if (jurisdiction) {
          values.push(jurisdiction);
          clauses.push(`jurisdiction = $${values.length}`);
        }
        if (params.cursor) {
          values.push(params.cursor.createdAt, params.cursor.id);
          clauses.push(`(evaluated_at, id) < ($${values.length - 1}, $${values.length})`);
        }
        values.push(params.limit + 1);

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.determinations
           WHERE org_id = $1${andAll(clauses)}
           ORDER BY evaluated_at DESC, id DESC
           LIMIT $${values.length}`,
          values,
        );
        return {
          ok: true,
          value: page(result.rows.map(mapDetermination), params.limit, (d) => ({
            createdAt: d.evaluatedAt.toISOString(),
            id: d.id,
          })),
        };
      } catch {
        return safeError("Failed to list determinations");
      }
    },

    async getDeterminationById(orgId: Uuid, id: Uuid): Promise<NexusResult<DeterminationRow>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.determinations WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapDetermination(result.rows[0]!) };
      } catch {
        return safeError("Failed to get determination");
      }
    },

    async upsertRegistration(
      orgId: Uuid,
      input: UpsertRegistrationInput,
    ): Promise<NexusResult<RegistrationRow>> {
      try {
        // The partial unique index covers only non-closed rows, so
        // ON CONFLICT cannot name it. Update-then-insert keeps the write to
        // one round trip in the common case and stays correct under the
        // constraint either way.
        const updated = await executor.execute<Record<string, unknown>>(
          `UPDATE nexus.registrations
           SET status = $3, registered_on = $4, permit_ref = $5, notes = $6, updated_at = $7
           WHERE org_id = $1 AND jurisdiction = $2 AND status <> 'closed'
           RETURNING *`,
          [
            orgId,
            input.jurisdiction,
            input.status,
            input.registeredOn,
            input.permitRef,
            input.notes,
            input.now.toISOString(),
          ],
        );
        if (updated.rowCount > 0) {
          return { ok: true, value: mapRegistration(updated.rows[0]!) };
        }

        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.registrations
             (id, org_id, jurisdiction, status, registered_on, permit_ref, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           RETURNING *`,
          [
            input.id,
            orgId,
            input.jurisdiction,
            input.status,
            input.registeredOn,
            input.permitRef,
            input.notes,
            input.now.toISOString(),
          ],
        );
        return { ok: true, value: mapRegistration(inserted.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "registration" } };
        }
        return safeError("Failed to upsert registration");
      }
    },

    async listRegistrations(orgId: Uuid): Promise<NexusResult<RegistrationRow[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.registrations WHERE org_id = $1 ORDER BY jurisdiction`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapRegistration) };
      } catch {
        return safeError("Failed to list registrations");
      }
    },

    async getAlertContact(orgId: Uuid): Promise<NexusResult<AlertContactRow | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.alert_contacts WHERE org_id = $1`,
          [orgId],
        );
        const row = result.rows[0];
        return { ok: true, value: row ? mapAlertContact(row) : null };
      } catch {
        return safeError("Failed to read alert contact");
      }
    },

    async upsertAlertContact(
      orgId: Uuid,
      input: UpsertAlertContactInput,
    ): Promise<NexusResult<AlertContactRow>> {
      try {
        // One row per org, so this is an upsert rather than an insert with a
        // conflict path the caller has to reason about.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.alert_contacts (org_id, email, label, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (org_id) DO UPDATE
             SET email = EXCLUDED.email,
                 label = EXCLUDED.label,
                 updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [orgId, input.email, input.label, input.now],
        );
        const row = result.rows[0];
        if (!row) return safeError("Failed to save alert contact");
        return { ok: true, value: mapAlertContact(row) };
      } catch {
        return safeError("Failed to save alert contact");
      }
    },

    async deleteAlertContact(orgId: Uuid): Promise<NexusResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM nexus.alert_contacts WHERE org_id = $1 RETURNING org_id`,
          [orgId],
        );
        return { ok: true, value: result.rows.length > 0 };
      } catch {
        return safeError("Failed to clear alert contact");
      }
    },

    async insertAlertOnce(orgId: Uuid, input: InsertAlertInput): Promise<NexusResult<AlertRow | null>> {
      try {
        // nexus_alerts_once_idx makes this exactly-once even if the cron
        // double-fires. A null return means "already sent", which is the
        // success path on a second firing — cheaper and more honest than a
        // distributed lock, and correct under concurrency, which a lock with
        // a TTL is not.
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO nexus.alerts (id, org_id, jurisdiction, determination_id, kind, sent_at, notification_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (org_id, jurisdiction, determination_id, kind) DO NOTHING
           RETURNING *`,
          [
            input.id,
            orgId,
            input.jurisdiction,
            input.determinationId,
            input.kind,
            input.sentAt.toISOString(),
            input.notificationRef,
          ],
        );
        if (result.rowCount === 0) return { ok: true, value: null };
        return { ok: true, value: mapAlert(result.rows[0]!) };
      } catch {
        return safeError("Failed to insert alert");
      }
    },

    async listAlerts(orgId: Uuid, limit: number): Promise<NexusResult<AlertRow[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.alerts WHERE org_id = $1 ORDER BY sent_at DESC, id DESC LIMIT $2`,
          [orgId, limit],
        );
        return { ok: true, value: result.rows.map(mapAlert) };
      } catch {
        return safeError("Failed to list alerts");
      }
    },

    async getWatermark(orgId: Uuid): Promise<NexusResult<WatermarkRow | null>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM nexus.evaluation_watermarks WHERE org_id = $1`,
          [orgId],
        );
        if (result.rowCount === 0) return { ok: true, value: null };
        const row = result.rows[0]!;
        return {
          ok: true,
          value: {
            orgId: row.org_id as string,
            lastIngestedAt: new Date(row.last_ingested_at as string),
            lastEvaluatedAt: new Date(row.last_evaluated_at as string),
          },
        };
      } catch {
        return safeError("Failed to read watermark");
      }
    },

    async setWatermark(orgId: Uuid, lastIngestedAt: Date, evaluatedAt: Date): Promise<NexusResult<void>> {
      try {
        // GREATEST rather than a plain assignment: two evaluations racing must
        // not move the watermark backwards, which would re-evaluate work
        // already done and, worse, could skip work if the loser wrote last.
        await executor.execute(
          `INSERT INTO nexus.evaluation_watermarks (org_id, last_ingested_at, last_evaluated_at, updated_at)
           VALUES ($1, $2, $3, $3)
           ON CONFLICT (org_id) DO UPDATE
             SET last_ingested_at = GREATEST(nexus.evaluation_watermarks.last_ingested_at, EXCLUDED.last_ingested_at),
                 last_evaluated_at = EXCLUDED.last_evaluated_at,
                 updated_at = EXCLUDED.updated_at`,
          [orgId, lastIngestedAt.toISOString(), evaluatedAt.toISOString()],
        );
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to write watermark");
      }
    },

    async listOrgsWithActivity(
      limit: number,
    ): Promise<NexusResult<Array<{ orgId: string; maxIngestedAt: Date }>>> {
      try {
        // tenancy-exempt: cross-tenant-sweep — the hourly job's "who has work
        // I have not seen" question is inherently cross-tenant; it returns org
        // ids and a timestamp and no tenant data, and every subsequent query
        // it drives is scoped to one of those ids.
        //
        // Compared against the watermark's `last_ingested_at`, not
        // `occurred_at`: a backfilled 2024 sale ingested a minute ago is
        // unseen work, and a window over occurred_at would skip it forever.
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT e.org_id, MAX(e.ingested_at) AS max_ingested_at
           FROM nexus.sale_events e
           LEFT JOIN nexus.evaluation_watermarks w ON w.org_id = e.org_id
           WHERE w.last_ingested_at IS NULL OR e.ingested_at > w.last_ingested_at
           GROUP BY e.org_id
           ORDER BY MAX(e.ingested_at) ASC
           LIMIT $1`,
          [limit],
        );
        return {
          ok: true,
          value: result.rows.map((r) => ({
            orgId: r.org_id as string,
            maxIngestedAt: new Date(r.max_ingested_at as string),
          })),
        };
      } catch {
        return safeError("Failed to list orgs with activity");
      }
    },

    async getChannelIdsForOrg(orgId: Uuid): Promise<NexusResult<string[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id FROM nexus.channels WHERE org_id = $1 AND revoked_at IS NULL`,
          [orgId],
        );
        return { ok: true, value: result.rows.map((r) => r.id as string) };
      } catch {
        return safeError("Failed to list channels");
      }
    },

    async touchChannelLastEvent(orgId: Uuid, channelId: Uuid, occurredAt: Date): Promise<NexusResult<void>> {
      try {
        // GREATEST, because a backfill walks history BACKWARDS and must not
        // drag the staleness signal back with it — that is precisely the R3
        // failure ("a channel that silently stopped delivering") served by our
        // own bookkeeping.
        await executor.execute(
          `UPDATE nexus.channels
           SET last_event_at = GREATEST(COALESCE(last_event_at, $3::timestamptz), $3::timestamptz),
               updated_at = now()
           WHERE org_id = $1 AND id = $2`,
          [orgId, channelId, occurredAt.toISOString()],
        );
        return { ok: true, value: undefined };
      } catch {
        return safeError("Failed to update channel activity");
      }
    },
  };
}

/**
 * Read back the rows that conflicted and report the ones whose stored money
 * differs from what was submitted (NX1.5 finding S-8 / R9).
 */
async function findDivergent(
  executor: SqlExecutor,
  orgId: Uuid,
  conflicted: readonly AppendSaleEventInput[],
): Promise<DivergentEvent[]> {
  const channelIds = [...new Set(conflicted.map((r) => r.channelId))];
  const providerIds = [...new Set(conflicted.map((r) => r.providerEventId))];

  const result = await executor.execute<Record<string, unknown>>(
    `SELECT id, channel_id, provider_event_id, kind, gross_cents, transaction_count
     FROM nexus.sale_events
     WHERE org_id = $1 AND channel_id = ANY($2) AND provider_event_id = ANY($3)`,
    [orgId, channelIds, providerIds],
  );

  const stored = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) {
    stored.set(`${row.channel_id as string}|${row.provider_event_id as string}|${row.kind as string}`, row);
  }

  const divergent: DivergentEvent[] = [];
  for (const row of conflicted) {
    const match = stored.get(`${row.channelId}|${row.providerEventId}|${row.kind}`);
    if (!match) continue;
    const storedGross = toCents(match.gross_cents);
    const storedCount = toCount(match.transaction_count);
    if (storedGross !== row.grossCents || storedCount !== row.transactionCount) {
      divergent.push({
        providerEventId: row.providerEventId,
        kind: row.kind,
        storedId: match.id as string,
        storedGrossCents: storedGross,
        submittedGrossCents: row.grossCents,
        storedTransactionCount: storedCount,
        submittedTransactionCount: row.transactionCount,
      });
    }
  }
  return divergent;
}

/**
 * Join optional filter clauses onto a query whose tenant predicate is already
 * in the SQL literal. Returns `""` when there are none, so the literal reads
 * `WHERE org_id = $1` and nothing else.
 */
function andAll(clauses: readonly string[]): string {
  return clauses.length === 0 ? "" : ` AND ${clauses.join(" AND ")}`;
}

/** Trim the sentinel row and derive the next cursor from the last kept row. */
function page<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => CursorPosition,
): PagedResult<T> {
  let nextCursor: CursorPosition | null = null;
  if (rows.length > limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last !== undefined) nextCursor = cursorOf(last);
  }
  return { items: rows, nextCursor };
}
