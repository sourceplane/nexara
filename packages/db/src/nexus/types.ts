// Repository types for the nexus bounded context.
//
// `Result`-typed throughout (`{ ok: true; value } | { ok: false; error }`) to
// match the platform convention: a repository never throws for an expected
// condition, so a handler cannot accidentally turn a not-found into a 500 by
// forgetting a catch.
//
// Every input bound to a UUID column is typed `Uuid`, the branded string from
// `@saas/db/ids`. A caller can only satisfy it by going through
// `uuidFromPublicId`, which makes a missing public-id decode a *compile*
// error rather than an `invalid input syntax for type uuid` at runtime.

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../hyperdrive/executor.js";
import type { Uuid } from "../ids/index.js";

// ── Column unions ────────────────────────────────────────────
//
// Declared locally rather than imported from `@saas/contracts`, matching every
// other repository in this package. `@saas/db` has no contract dependency by
// design: these unions mirror the Postgres CHECK constraints, which is a
// different thing from the wire shape even when the two happen to coincide,
// and the mapping between them lives in the worker's `mappers.ts` where a
// divergence is visible.

export type SaleEventSource = "backfill" | "webhook" | "csv";
export type SaleEventKind = "sale" | "refund";
export type JurisdictionSourceKind =
  | "shipping_address"
  | "billing_address"
  | "tax_lines"
  | "declared";
export type MeasurementBasis = "gross" | "retail" | "taxable";
export type MeasurementPeriod =
  | "rolling_12m"
  | "calendar_year"
  | "previous_calendar_year";
export type ThresholdLogic =
  | "none"
  | "sales_only"
  | "transactions_only"
  | "either"
  | "both";
export type MarketplaceTreatment = "include" | "exclude";
export type DeterminationStatus =
  | "no_obligation"
  | "clear"
  | "approaching"
  | "crossed"
  | "registered";
export type RegistrationStatus = "planned" | "filed" | "active" | "closed";
export type AlertKind = "approaching" | "crossed" | "deadline";

/**
 * The `inputs` JSONB column, opaque at this layer.
 *
 * The repository stores and returns it verbatim and never reads inside it —
 * interpreting it is the engine's job, and a db-layer type would be a second
 * definition of the reproducibility payload that could drift from the one the
 * engine actually replays.
 */
export type DeterminationInputsJson = Record<string, unknown>;

/** The `registration_deadline_rule` JSONB column, likewise opaque here. */
export type RegistrationDeadlineRuleJson = Record<string, unknown>;

/**
 * One jurisdiction's totals over a window, split by marketplace treatment and
 * carrying all three bases — the shape returned by the single grouped scan of
 * design §5.1. The engine picks the basis and applies the treatment; the
 * database does neither.
 */
export interface JurisdictionAggregateRow {
  jurisdiction: string;
  directGrossCents: number;
  directRetailCents: number;
  directTaxableCents: number;
  directTransactions: number;
  marketplaceGrossCents: number;
  marketplaceRetailCents: number;
  marketplaceTaxableCents: number;
  marketplaceTransactions: number;
}

export type NexusRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "invalid"; message: string }
  | { kind: "internal"; message: string };

export type NexusResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NexusRepositoryError };

// ── Ledger ───────────────────────────────────────────────────

export interface SaleEvent {
  id: string;
  orgId: string;
  channelId: string;
  source: SaleEventSource;
  providerEventId: string;
  kind: SaleEventKind;
  reversesEventId: string | null;
  occurredAt: Date;
  jurisdiction: string;
  jurisdictionSource: JurisdictionSourceKind;
  shipToCountry: string | null;
  shipToRegion: string | null;
  grossCents: number;
  retailCents: number;
  taxableCents: number;
  transactionCount: number;
  marketplaceFacilitated: boolean;
  currency: string;
  ingestedAt: Date;
}

export interface AppendSaleEventInput {
  id: string;
  channelId: Uuid;
  source: SaleEventSource;
  providerEventId: string;
  kind: SaleEventKind;
  reversesEventId: Uuid | null;
  occurredAt: Date;
  jurisdiction: string;
  jurisdictionSource: JurisdictionSourceKind;
  shipToCountry: string | null;
  shipToRegion: string | null;
  grossCents: number;
  retailCents: number;
  taxableCents: number;
  transactionCount: number;
  marketplaceFacilitated: boolean;
  currency: string;
}

/**
 * The outcome of an append.
 *
 * `duplicates` is success, not error — it is what makes the deliberate
 * backfill/live-sync overlap free (design §6.3).
 *
 * `divergent` is the NX1.5 finding S-8 requirement, and it is the reason this
 * type is not just two counters. A provider re-sending the same event id with
 * **different amounts** — a Stripe charge amended after currency conversion
 * settles, a Shopify order edited before fulfilment — is dropped by
 * `ON CONFLICT DO NOTHING`, and the first amount stands forever. That must not
 * read as an ordinary no-op: it is the one case where a silent duplicate is
 * wrong, and the caller has to be able to raise it (R9).
 */
export interface AppendResult {
  submitted: number;
  applied: number;
  duplicates: number;
  /** Duplicates whose stored monetary values differ from what was submitted. */
  divergent: DivergentEvent[];
  events: SaleEvent[];
}

export interface DivergentEvent {
  providerEventId: string;
  kind: SaleEventKind;
  storedId: string;
  storedGrossCents: number;
  submittedGrossCents: number;
  storedTransactionCount: number;
  submittedTransactionCount: number;
}

export interface LedgerFilters {
  jurisdiction?: string | null;
  channelId?: Uuid | null;
  kind?: SaleEventKind | null;
  /** Inclusive lower bound on `occurred_at`. */
  since?: Date | null;
  /** Exclusive upper bound on `occurred_at`. */
  until?: Date | null;
}

// ── Aggregation ──────────────────────────────────────────────

/** A half-open instant range, `[start, end)`. Never `BETWEEN`. */
export interface WindowBounds {
  start: Date;
  end: Date;
}

// ── Rules (global reference data — no org_id) ─────────────────

export interface RuleSetRow {
  id: string;
  version: string;
  publishedAt: Date;
  verified: boolean;
  sourceNote: string | null;
}

export interface RuleRow {
  id: string;
  ruleSetId: string;
  ruleSetVersion: string;
  jurisdiction: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  measurementBasis: MeasurementBasis;
  measurementPeriod: MeasurementPeriod;
  measurementTimezone: string;
  salesThresholdCents: number | null;
  transactionThreshold: number | null;
  thresholdLogic: ThresholdLogic;
  marketplaceTreatment: MarketplaceTreatment;
  registrationDeadlineRule: RegistrationDeadlineRuleJson;
  notes: string | null;
}

// ── Determinations ───────────────────────────────────────────

export interface DeterminationRow {
  id: string;
  orgId: string;
  jurisdiction: string;
  evaluatedAt: Date;
  ruleSetVersion: string;
  ruleId: string;
  engineVersion: string;
  periodStart: Date;
  periodEnd: Date;
  measuredSalesCents: number;
  measuredTransactions: number;
  thresholdSalesCents: number | null;
  thresholdTransactions: number | null;
  status: DeterminationStatus;
  crossedOn: string | null;
  registrationDueOn: string | null;
  inputs: DeterminationInputsJson;
  internalOnly: boolean;
}

export interface InsertDeterminationInput {
  id: string;
  jurisdiction: string;
  evaluatedAt: Date;
  ruleSetVersion: string;
  ruleId: Uuid;
  engineVersion: string;
  periodStart: Date;
  periodEnd: Date;
  measuredSalesCents: number;
  measuredTransactions: number;
  thresholdSalesCents: number | null;
  thresholdTransactions: number | null;
  status: DeterminationStatus;
  crossedOn: string | null;
  registrationDueOn: string | null;
  inputs: DeterminationInputsJson;
  internalOnly: boolean;
}

// ── Registrations and alerts ─────────────────────────────────

export interface RegistrationRow {
  id: string;
  orgId: string;
  jurisdiction: string;
  status: RegistrationStatus;
  registeredOn: string | null;
  permitRef: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Where one org's threshold alerts go (R10).
 *
 * Not a reference to a user: the tax contact is frequently an accountant or a
 * shared finance inbox, and requiring a console login would push sellers to
 * use their own address and then never read the alert.
 */
export interface AlertContactRow {
  orgId: string;
  email: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertAlertContactInput {
  email: string;
  label: string | null;
  now: Date;
}

export interface UpsertRegistrationInput {
  id: string;
  jurisdiction: string;
  status: RegistrationStatus;
  registeredOn: string | null;
  permitRef: string | null;
  notes: string | null;
  now: Date;
}

export interface AlertRow {
  id: string;
  orgId: string;
  jurisdiction: string;
  determinationId: string;
  kind: AlertKind;
  sentAt: Date;
  notificationRef: string | null;
}

export interface InsertAlertInput {
  id: string;
  jurisdiction: string;
  determinationId: Uuid;
  kind: AlertKind;
  sentAt: Date;
  notificationRef: string | null;
}

// ── Watermarks ───────────────────────────────────────────────

export interface WatermarkRow {
  orgId: string;
  lastIngestedAt: Date;
  lastEvaluatedAt: Date;
}

// ── Pagination ───────────────────────────────────────────────

export interface CursorPosition {
  /** ISO timestamp of the last row's ordering column. */
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

// ── The repository surface ───────────────────────────────────

/**
 * The **only** place SQL is written against the `nexus` schema.
 *
 * That is not a style preference. Design §7.3 chooses query scoping over
 * Postgres RLS because `SET LOCAL app.current_org` on a Hyperdrive-pooled
 * connection leaks a tenant context onto the next request that borrows the
 * socket — silent and cross-tenant, the worst pair of properties a bug can
 * have. Query scoping has no such failure mode, and no defence-in-depth
 * either, so the single-surface rule is what carries the isolation argument
 * and `tenancy-scan.test.ts` is what verifies it.
 */
export interface NexusRepository {
  // ── Ledger ──
  /**
   * `INSERT … ON CONFLICT DO NOTHING RETURNING *`. An empty return for a row
   * means "already applied", which is success.
   */
  appendSaleEvents(orgId: Uuid, rows: AppendSaleEventInput[]): Promise<NexusResult<AppendResult>>;
  listSaleEventsPaged(
    orgId: Uuid,
    filters: LedgerFilters,
    params: PageQueryParams,
  ): Promise<NexusResult<PagedResult<SaleEvent>>>;
  getSaleEventById(orgId: Uuid, id: Uuid): Promise<NexusResult<SaleEvent>>;

  // ── Aggregation ──
  /** The single grouped scan of design §5.1 — all three bases, split by
   *  marketplace treatment, one row per jurisdiction. */
  aggregateByJurisdiction(
    orgId: Uuid,
    window: WindowBounds,
    jurisdictions?: readonly string[],
  ): Promise<NexusResult<JurisdictionAggregateRow[]>>;

  /** Distinct jurisdictions this tenant has ever traded into. */
  listActiveJurisdictions(orgId: Uuid): Promise<NexusResult<string[]>>;

  // ── Rules (global; not tenant-scoped, by design §3.3) ──
  getCurrentRuleSet(): Promise<NexusResult<RuleSetRow>>;
  getRuleSetByVersion(version: string): Promise<NexusResult<RuleSetRow>>;
  listRulesInForce(ruleSetId: Uuid, onDate: string): Promise<NexusResult<RuleRow[]>>;
  /** Every rule for one jurisdiction overlapping `[from, to)` — the input to
   *  the mid-window split of design §5.3 case 3. */
  listRulesOverlapping(
    ruleSetId: Uuid,
    jurisdiction: string,
    from: string,
    to: string,
  ): Promise<NexusResult<RuleRow[]>>;
  getRuleById(ruleId: Uuid): Promise<NexusResult<RuleRow>>;

  // ── Determinations ──
  insertDetermination(orgId: Uuid, input: InsertDeterminationInput): Promise<NexusResult<DeterminationRow>>;
  /** The newest determination per jurisdiction — the exposure board's spine. */
  listCurrentDeterminations(orgId: Uuid): Promise<NexusResult<DeterminationRow[]>>;
  listDeterminationsPaged(
    orgId: Uuid,
    jurisdiction: string | null,
    params: PageQueryParams,
  ): Promise<NexusResult<PagedResult<DeterminationRow>>>;
  getDeterminationById(orgId: Uuid, id: Uuid): Promise<NexusResult<DeterminationRow>>;

  // ── Registrations ──
  upsertRegistration(orgId: Uuid, input: UpsertRegistrationInput): Promise<NexusResult<RegistrationRow>>;
  listRegistrations(orgId: Uuid): Promise<NexusResult<RegistrationRow[]>>;

  // ── Alert contact (R10) ──
  /** Null when the seller has not named one; the caller falls back to the
   *  environment default and records that it did. */
  getAlertContact(orgId: Uuid): Promise<NexusResult<AlertContactRow | null>>;
  upsertAlertContact(
    orgId: Uuid,
    input: UpsertAlertContactInput,
  ): Promise<NexusResult<AlertContactRow>>;
  /** Deleting the contact is a deliberate act, not an empty-string update —
   *  it returns the org to the environment fallback, and that is a different
   *  state from "set to nothing". */
  deleteAlertContact(orgId: Uuid): Promise<NexusResult<boolean>>;

  // ── Alerts ──
  /** Gated by `nexus_alerts_once_idx`; a null value means "already sent". */
  insertAlertOnce(orgId: Uuid, input: InsertAlertInput): Promise<NexusResult<AlertRow | null>>;
  listAlerts(orgId: Uuid, limit: number): Promise<NexusResult<AlertRow[]>>;

  // ── Evaluation watermark ──
  getWatermark(orgId: Uuid): Promise<NexusResult<WatermarkRow | null>>;
  setWatermark(orgId: Uuid, lastIngestedAt: Date, evaluatedAt: Date): Promise<NexusResult<void>>;
  /** Cross-tenant by necessity — the cron's "who has new work" sweep. */
  listOrgsWithActivity(limit: number): Promise<NexusResult<Array<{ orgId: string; maxIngestedAt: Date }>>>;

  // ── Channel lookups the ledger needs ──
  /** Confirms a channel belongs to this tenant before a ledger row cites it. */
  getChannelIdsForOrg(orgId: Uuid): Promise<NexusResult<string[]>>;
  /** Newest `occurred_at` per channel, written after an append. */
  touchChannelLastEvent(orgId: Uuid, channelId: Uuid, occurredAt: Date): Promise<NexusResult<void>>;
}
