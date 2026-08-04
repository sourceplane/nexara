// Nexus contracts — economic-nexus threshold monitoring.
// Owner: nexus-worker (apps/nexus-worker).
//
// Three invariants shape every type in this file, and each is enforced here
// rather than left to the caller:
//
//   1. Money is integer cents. Every monetary field is `number` holding whole
//      cents and is named `*Cents`. There is no float, no decimal string, and
//      no `NUMERIC` anywhere behind these types — including inside the engine.
//   2. The ledger is append-only. There is no `UpdateSaleEventRequest` and
//      there never will be; a refund is a new `PublicSaleEvent` with
//      `kind: "refund"`, negative cents, and `reversesEventId` set.
//   3. A determination is reproducible. `PublicDetermination` carries the
//      reproducibility triple (`ruleSetVersion`, `ruleId`, `engineVersion`)
//      plus the exact `inputs` it was computed from, so re-running that engine
//      version against those inputs and that rule must return the same
//      `status`, `crossedOn`, and `registrationDueOn`.
//
// The engine-facing types (`Rule`, `JurisdictionAggregate`,
// `DeterminationInputs`, `DeterminationOutcome`) live here rather than in the
// worker because the engine imports *only types* from `@saas/contracts` — that
// import restriction is what keeps it pure and testable without a database.
//
// Spec: specs/epics/nexus/design.md §3–§5.

// ── Enumerations ─────────────────────────────────────────────
// Each `as const` array mirrors a Postgres CHECK constraint one-for-one. When
// one changes the other is a migration, not an edit.

/**
 * What the rule measures. The same order contributes a different amount to
 * each, which is why all three are captured at ingest (design §3.2).
 */
export const MEASUREMENT_BASES = ["gross", "retail", "taxable"] as const;
export type MeasurementBasis = (typeof MEASUREMENT_BASES)[number];

/** The window the measurement is taken over. There are exactly three. */
export const MEASUREMENT_PERIODS = [
  "rolling_12m",
  "calendar_year",
  "previous_calendar_year",
] as const;
export type MeasurementPeriod = (typeof MEASUREMENT_PERIODS)[number];

/**
 * How the sales and transaction tests combine.
 *
 * `"none"` is a position, not a gap: the jurisdictions that enforce no
 * economic-nexus threshold (New Hampshire, Oregon, Montana, Delaware, Alaska
 * at the state level) get an explicit rule row saying so. The engine treats it
 * as terminal — no measurement is computed and the answer is
 * `"no_obligation"`, never `"clear"` at 0%. Absent data and deliberately
 * absent obligation must not render alike.
 */
export const THRESHOLD_LOGICS = [
  "none",
  "sales_only",
  "transactions_only",
  "either",
  "both",
] as const;
export type ThresholdLogic = (typeof THRESHOLD_LOGICS)[number];

/** Whether marketplace-facilitated sales count toward this jurisdiction's threshold. */
export const MARKETPLACE_TREATMENTS = ["include", "exclude"] as const;
export type MarketplaceTreatment = (typeof MARKETPLACE_TREATMENTS)[number];

/**
 * The determination status.
 *
 * `"no_obligation"` is the terminal answer for `thresholdLogic: "none"` and is
 * deliberately distinct from `"clear"`: `"clear"` means *measured, below the
 * line*, and `"no_obligation"` means *there is no line*. A UI that renders
 * them alike has lost the distinction the rule row exists to carry.
 */
export const DETERMINATION_STATUSES = [
  "no_obligation",
  "clear",
  "approaching",
  "crossed",
  "registered",
] as const;
export type DeterminationStatus = (typeof DETERMINATION_STATUSES)[number];

/**
 * The subset the **engine** can produce (NX1.5 finding S-7).
 *
 * `"registered"` is not an engine output and cannot be: the engine is pure
 * and is handed an aggregate and a rule, neither of which knows whether the
 * seller has registered. It is applied over the top by the board projection,
 * from `nexus.registrations`. Typing `DeterminationOutcome.status` as the full
 * union invited a caller to expect the engine to return it — and then to write
 * a branch that never runs.
 */
export const ENGINE_STATUSES = [
  "no_obligation",
  "clear",
  "approaching",
  "crossed",
] as const;
export type EngineStatus = (typeof ENGINE_STATUSES)[number];

/** How a sale event reached the ledger. */
export const SALE_EVENT_SOURCES = ["backfill", "webhook", "csv"] as const;
export type SaleEventSource = (typeof SALE_EVENT_SOURCES)[number];

/** A ledger row is either a sale or the reversal of one. */
export const SALE_EVENT_KINDS = ["sale", "refund"] as const;
export type SaleEventKind = (typeof SALE_EVENT_KINDS)[number];

/** Registration lifecycle, tracked by the seller — we never file on their behalf. */
export const REGISTRATION_STATUSES = ["planned", "filed", "active", "closed"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** What an alert is about. */
export const ALERT_KINDS = ["approaching", "crossed", "deadline"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * How the ship-to jurisdiction was resolved (design §6.2). Recorded on every
 * ledger row and surfaced in the explainer so a low-confidence attribution is
 * visible rather than laundered into a fact.
 */
export const JURISDICTION_SOURCES = [
  "shipping_address",
  "billing_address",
  "tax_lines",
  "declared",
] as const;
export type JurisdictionSource = (typeof JURISDICTION_SOURCES)[number];

// ── Registration deadline rules ──────────────────────────────

/**
 * The `registration_deadline_rule` JSONB shape. States express the deadline
 * once a threshold is crossed in a handful of distinct forms; each is a
 * variant here rather than a free-text field, so `deadline.ts` is a total
 * function over the union.
 */
export type RegistrationDeadlineRule =
  /** N calendar days after the crossing date. */
  | { kind: "days_after_crossing"; days: number }
  /** The first day of the month following the crossing. */
  | { kind: "first_of_next_month" }
  /** The last day of the month following the crossing. */
  | { kind: "end_of_next_month" }
  /** The first day of the calendar quarter following the crossing. */
  | { kind: "first_of_next_quarter" }
  /** The first day of the month following `days` days after the crossing. */
  | { kind: "first_of_month_after_days"; days: number }
  /** No deadline is defined by the jurisdiction; the console shows none. */
  | { kind: "none" };

export const REGISTRATION_DEADLINE_RULE_KINDS = [
  "days_after_crossing",
  "first_of_next_month",
  "end_of_next_month",
  "first_of_next_quarter",
  "first_of_month_after_days",
  "none",
] as const;
export type RegistrationDeadlineRuleKind =
  (typeof REGISTRATION_DEADLINE_RULE_KINDS)[number];

// ── Rules and rule sets ──────────────────────────────────────

/**
 * A published rule set. Global reference data — deliberately **not**
 * tenant-scoped (design §3.3), so it carries no `orgId`.
 */
export interface PublicRuleSet {
  /** Public id, `rst_<32hex>`. */
  id: string;
  /** Human-ordered version, e.g. `"2026.08.01"`. Unique. */
  version: string;
  publishedAt: string;
  /**
   * A gate, not a label. No customer-facing determination may be produced
   * from a rule set with `verified: false` (design §11). Enforcement is in
   * the engine's caller; a UI-only gate is not a gate.
   */
  verified: boolean;
  /** Where the data came from, and — when unverified — why it is not. */
  sourceNote: string | null;
}

/**
 * A jurisdiction's rule as it stands over one effective period.
 *
 * This is also the engine's input shape. It carries no `orgId` and no
 * database concerns; `apps/nexus-worker/src/engine/` imports it as a type and
 * nothing else.
 */
export interface Rule {
  /** Public id, `rul_<32hex>`. */
  id: string;
  /** Owning rule set's public id, `rst_<32hex>`. */
  ruleSetId: string;
  /** Owning rule set's version — half of the reproducibility triple. */
  ruleSetVersion: string;
  /**
   * `US-CA`, `US-TX` for states; a bare ISO country code (`GB`, `DE`) for the
   * international VAT/GST registration thresholds, which are carried
   * display-only in v1 and are never evaluated into a determination.
   */
  jurisdiction: string;
  /** ISO date, inclusive. */
  effectiveFrom: string;
  /** ISO date, exclusive. Null means "still in force". */
  effectiveTo: string | null;
  measurementBasis: MeasurementBasis;
  measurementPeriod: MeasurementPeriod;
  /**
   * IANA zone the measurement *dates* are taken in, e.g. `America/Chicago`.
   *
   * `occurredAt` is a UTC instant; a threshold window is a range of the
   * jurisdiction's own calendar dates. Without this, a 31 December 23:00 PST
   * sale — a 1 January UTC row — lands in the wrong measurement year, which is
   * the single most likely silent bug in the product (design §5.3 case 4, R7).
   */
  measurementTimezone: string;
  /** Null when the logic does not test sales. */
  salesThresholdCents: number | null;
  /** Null when the logic does not test transaction count. */
  transactionThreshold: number | null;
  thresholdLogic: ThresholdLogic;
  marketplaceTreatment: MarketplaceTreatment;
  registrationDeadlineRule: RegistrationDeadlineRule;
  notes: string | null;
}

/** Wire projection of a rule; identical shape, named for the API boundary. */
export type PublicRule = Rule;

// ── The ledger ───────────────────────────────────────────────

/**
 * A ledger row. Append-only: there is no update shape, and a reversal is a
 * separate row with negative cents and `reversesEventId` set.
 */
export interface PublicSaleEvent {
  /** Public id, `sev_<32hex>`. */
  id: string;
  orgId: string;
  /** Public channel id, `chn_<32hex>`. */
  channelId: string;
  source: SaleEventSource;
  /** The provider's own id for the charge/order. Half of the dedupe key. */
  providerEventId: string;
  kind: SaleEventKind;
  /** Set when `kind` is `"refund"`; the `sev_` id of the row being reversed. */
  reversesEventId: string | null;
  /** The **provider's** timestamp. This is the measurement date, not `ingestedAt`. */
  occurredAt: string;
  jurisdiction: string;
  /** Which fallback produced `jurisdiction` — visible, never laundered. */
  jurisdictionSource: JurisdictionSource;
  shipToCountry: string | null;
  shipToRegion: string | null;
  /** Negative on a refund. */
  grossCents: number;
  retailCents: number;
  taxableCents: number;
  /** Negative on a refund, so counts reverse the same way amounts do. */
  transactionCount: number;
  marketplaceFacilitated: boolean;
  currency: string;
  ingestedAt: string;
}

/**
 * One row of a ledger import. Deliberately not `PublicSaleEvent`: the caller
 * does not choose ids, and `source` is fixed by the endpoint.
 */
export interface ImportSaleEventInput {
  /** Channel to attribute the row to; must belong to the caller's org. */
  channelId: string;
  providerEventId: string;
  kind: SaleEventKind;
  /** Required when `kind` is `"refund"`. */
  reversesEventId?: string | null;
  occurredAt: string;
  jurisdiction: string;
  jurisdictionSource?: JurisdictionSource;
  shipToCountry?: string | null;
  shipToRegion?: string | null;
  grossCents: number;
  retailCents: number;
  taxableCents: number;
  transactionCount?: number;
  marketplaceFacilitated?: boolean;
  currency: string;
}

export interface ImportLedgerRequest {
  events: ImportSaleEventInput[];
}

/**
 * A malformed import is rejected wholesale (422, no partial writes), so this
 * response only ever describes a success. `applied + duplicates === submitted`.
 */
export interface ImportLedgerResponse {
  submitted: number;
  /** Rows that became new ledger entries. */
  applied: number;
  /**
   * Rows the dedupe index rejected because they were already applied. This is
   * success, not error — it is what makes backfill and live sync safe to
   * overlap (design §6.3).
   */
  duplicates: number;
}

export interface ListLedgerResponse {
  events: PublicSaleEvent[];
}

// ── Aggregation and the engine ───────────────────────────────

/**
 * A half-open measurement window, `[start, end)`. Never `BETWEEN`.
 *
 * `start`/`end` are UTC instants — what the aggregation query compares
 * `occurred_at` against. `startDate`/`endDate` are the same boundaries as the
 * jurisdiction's own calendar dates, which is what the console renders and
 * what a reader of the evidence recognises.
 */
export interface MeasurementWindow {
  start: string;
  end: string;
  startDate: string;
  endDate: string;
}

/**
 * One jurisdiction's totals over a window, split by marketplace treatment and
 * carrying all three bases — the shape returned by the single grouped scan of
 * design §5.1. The engine picks the basis and applies the treatment; the
 * database does neither.
 *
 * Refunds are negative rows, so a plain `SUM` handles reversals with no
 * special casing. That is the payoff for invariant 2.
 */
export interface JurisdictionAggregate {
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

/** What the engine measured, after basis selection and marketplace treatment. */
export interface MeasuredTotals {
  salesCents: number;
  transactions: number;
}

/**
 * The exact payload handed to the engine, stored verbatim on the
 * determination as `inputs`. Re-running `engineVersion` against this object
 * and `ruleId` must reproduce `status`, `crossedOn`, and `registrationDueOn`
 * byte-identically — that is `reproducibility.test.ts`, not a comment.
 */
export interface DeterminationInputs {
  /** The instant the evaluation was taken as of. The engine never reads a clock. */
  asOf: string;
  window: MeasurementWindow;
  aggregate: JurisdictionAggregate;
  /** Fraction of the threshold at which `"approaching"` begins. Default 0.8. */
  approachingFraction: number;
}

/** What the engine returns. Every field is a pure function of the inputs and the rule. */
export interface DeterminationOutcome {
  /** Never `"registered"` — see `EngineStatus`. */
  status: EngineStatus;
  measuredSalesCents: number;
  measuredTransactions: number;
  thresholdSalesCents: number | null;
  thresholdTransactions: number | null;
  /**
   * The jurisdiction-local date of `inputs.asOf` when the status is
   * `"crossed"`, otherwise null.
   *
   * Read this as **"the date on which the measurement was first observed to
   * cross"**, not as a claim about the legal instant of crossing. The engine
   * is handed a window aggregate, which has no day resolution; deriving the
   * exact ledger date needs a second scan and is a named follow-on. Live
   * traffic is evaluated hourly, so for a connected channel the two coincide;
   * for a freshly backfilled ledger this is the date we could first have
   * known. The console says exactly that.
   */
  crossedOn: string | null;
  /** Null until crossed, and null when the rule defines no deadline. */
  registrationDueOn: string | null;
  /**
   * Progress toward the binding threshold in `[0, ∞)`, or null when there is
   * no threshold to be a fraction of (`thresholdLogic: "none"`). The console
   * renders a meter from this; a null renders as "out of scope", never as 0%.
   */
  fractionOfThreshold: number | null;
}

// ── Determinations ───────────────────────────────────────────

export interface PublicDetermination {
  /** Public id, `det_<32hex>`. */
  id: string;
  orgId: string;
  jurisdiction: string;
  evaluatedAt: string;
  /** ── the reproducibility triple ── */
  ruleSetVersion: string;
  /** Public rule id, `rul_<32hex>`. */
  ruleId: string;
  engineVersion: string;
  /** ── what was measured ── */
  periodStart: string;
  periodEnd: string;
  measuredSalesCents: number;
  measuredTransactions: number;
  thresholdSalesCents: number | null;
  thresholdTransactions: number | null;
  status: DeterminationStatus;
  crossedOn: string | null;
  registrationDueOn: string | null;
  /** The exact aggregate handed to the engine. */
  inputs: DeterminationInputs;
  /**
   * True when the determination was produced from an unverified rule set. Such
   * determinations are internal-only: they raise no alert and the console
   * renders the §11 banner in place of a status.
   */
  internalOnly: boolean;
}

// ── Exposure board ───────────────────────────────────────────

/**
 * One card on the exposure board. This is a *projection*, not a determination
 * — it is the current position, assembled from the newest determination plus
 * the rule in force and any registration.
 */
export interface PublicJurisdictionExposure {
  jurisdiction: string;
  /** Display name, e.g. "Texas". */
  jurisdictionName: string;
  status: DeterminationStatus;
  measuredSalesCents: number;
  measuredTransactions: number;
  thresholdSalesCents: number | null;
  thresholdTransactions: number | null;
  fractionOfThreshold: number | null;
  periodStart: string;
  periodEnd: string;
  measurementBasis: MeasurementBasis;
  measurementPeriod: MeasurementPeriod;
  marketplaceTreatment: MarketplaceTreatment;
  thresholdLogic: ThresholdLogic;
  crossedOn: string | null;
  registrationDueOn: string | null;
  registrationStatus: RegistrationStatus | null;
  /** Newest determination's public id, or null when never evaluated. */
  determinationId: string | null;
  evaluatedAt: string | null;
  ruleSetVersion: string;
  /** False when the rule set behind this card is unverified (design §11). */
  ruleSetVerified: boolean;
  /**
   * True when this jurisdiction is beyond the org's plan limit (design §9).
   *
   * A locked card is **named but not measured**: its sale events are still
   * ingested and still in the ledger, and the seller can see that they trade
   * here — they simply do not get a determination until they upgrade. The
   * three alternatives were each worse:
   *
   *   * refusing the ledger row costs the seller their own history, and no
   *     later upgrade can repair it;
   *   * erroring the board hides the jurisdictions they *are* entitled to;
   *   * hiding the excess entirely means a compliance product concealing that
   *     a seller trades into a state, which is the thing it exists to surface.
   *
   * When true, `status`, `measuredSalesCents` and `fractionOfThreshold` carry
   * no measurement and the console renders an upgrade prompt in their place.
   */
  locked: boolean;
}

export interface ListExposureResponse {
  exposure: PublicJurisdictionExposure[];
  /** The rule set the board was computed against. */
  ruleSet: PublicRuleSet;
  /**
   * How many jurisdictions this org's plan monitors, or null for unlimited
   * (design §9). Present so the console can explain a locked card with the
   * actual number rather than a generic "upgrade" nag.
   */
  monitoredLimit: number | null;
}

export interface GetJurisdictionResponse {
  exposure: PublicJurisdictionExposure;
  /** The rule in force at `exposure.evaluatedAt`. */
  rule: PublicRule;
  /** Newest first. The current position is the first entry. */
  determinations: PublicDetermination[];
  registration: PublicRegistration | null;
}

export interface EvaluateRequest {
  /**
   * Evaluate as of this instant instead of now. Bounded by the server to
   * prevent a caller from mining future or ancient positions.
   */
  asOf?: string;
}

export interface EvaluateResponse {
  evaluatedAt: string;
  /** Determinations written by this run — only changed positions produce one. */
  determinations: PublicDetermination[];
  /** Jurisdictions evaluated, including those whose position did not change. */
  evaluated: number;
  ruleSetVersion: string;
  ruleSetVerified: boolean;
}

// ── Registrations and alerts ─────────────────────────────────

export interface PublicRegistration {
  /** Public id, `reg_<32hex>`. */
  id: string;
  orgId: string;
  jurisdiction: string;
  status: RegistrationStatus;
  registeredOn: string | null;
  permitRef: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRegistrationRequest {
  jurisdiction: string;
  status: RegistrationStatus;
  registeredOn?: string | null;
  permitRef?: string | null;
  notes?: string | null;
}

export interface UpsertRegistrationResponse {
  registration: PublicRegistration;
}

export interface ListRegistrationsResponse {
  registrations: PublicRegistration[];
}

export interface PublicAlert {
  id: string;
  orgId: string;
  jurisdiction: string;
  determinationId: string;
  kind: AlertKind;
  sentAt: string;
  notificationRef: string | null;
}

export interface ListAlertsResponse {
  alerts: PublicAlert[];
}

/**
 * Where this org's threshold alerts go (R10).
 *
 * Deliberately not a user id. The person who should read "you have crossed
 * Texas" is often an accountant or a shared finance inbox rather than a
 * console user, and requiring a login would push sellers to name their own
 * address and then never read it.
 */
export interface PublicAlertContact {
  email: string;
  /** A seller-chosen label — "our bookkeeper". Never used for routing. */
  label: string | null;
  updatedAt: string;
}

export interface GetAlertContactResponse {
  /** Null when none is set; alerts then fall back to the environment default
   *  and the alert row records that they did. */
  contact: PublicAlertContact | null;
  /**
   * True when an environment-level fallback exists, so the console can say
   * "alerts are going somewhere, just not somewhere you chose" rather than
   * implying silence.
   */
  hasEnvironmentFallback: boolean;
}

export interface SetAlertContactRequest {
  email: string;
  label?: string | null;
}

export interface SetAlertContactResponse {
  contact: PublicAlertContact;
}

// ── Event types ──────────────────────────────────────────────

/**
 * Domain events emitted to `events-worker`. That append-only log **is** the
 * compliance audit trail; there is no second one.
 *
 * `nexus.threshold.crossed` is additionally registered in `webhooks-worker` as
 * a subscribable outgoing webhook type, so a seller's own systems can react.
 */
export const NEXUS_EVENT_TYPES = [
  "nexus.channel.connected",
  "nexus.channel.revoked",
  "nexus.backfill.completed",
  "nexus.ledger.imported",
  "nexus.determination.created",
  "nexus.threshold.approaching",
  "nexus.threshold.crossed",
  "nexus.registration.updated",
] as const;
export type NexusEventType = (typeof NEXUS_EVENT_TYPES)[number];
