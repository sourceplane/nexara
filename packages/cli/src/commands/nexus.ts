// `nexara nexus …`, `nexara ledger …`, `nexara registration …`
//
// The CLI walkthrough is how backend milestones are verified on stage
// (epic README § Verification bar), so every command has `--output json`
// parity and nothing here formats a number in a way a script cannot parse.
//
// Money is printed as dollars in human mode and emitted as **integer cents**
// in JSON mode. That asymmetry is deliberate: a human reading a board wants
// `$512,300.00`, and a script comparing against a threshold must never be
// handed a float it has to parse back.

import { readFile } from "node:fs/promises";

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";
import type {
  ImportSaleEventInput,
  ListLedgerQuery,
  PublicDetermination,
  PublicJurisdictionExposure,
  PublicSaleEvent,
} from "@saas/sdk";

/** Integer cents → a human-readable amount. Never used in JSON mode. */
function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.trunc(abs / 100).toLocaleString("en-US")}.${(abs % 100)
    .toString()
    .padStart(2, "0")}`;
}

/** A fraction → a percentage, or the em dash that means "there is no line". */
function meter(fraction: number | null): string {
  // An en-dash rather than "0%": `threshold_logic = 'none'` means there is no
  // threshold to be a fraction of, and rendering that as 0% is the exact
  // confusion the explicit no-obligation rule row exists to prevent.
  return fraction === null ? "—" : `${(fraction * 100).toFixed(1)}%`;
}

function strFlag(flag: string | boolean | undefined): string | undefined {
  return typeof flag === "string" && flag.length > 0 ? flag : undefined;
}

// ── nexus exposure ───────────────────────────────────────────

export async function nexusExposureCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const response = await client.exposure.list(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  // The banner, not a status. Design §11: an unverified rule set produces
  // internal-only determinations and no customer-facing claim, and a CLI that
  // printed a bare "crossed" here would be making exactly that claim.
  if (!response.ruleSet.verified) {
    ctx.stderr(
      `! Rule set ${response.ruleSet.version} is UNVERIFIED. These positions are ` +
        `internal-only and are not a compliance determination.`,
    );
  }

  const rows = response.exposure.map((e: PublicJurisdictionExposure) => ({
    jurisdiction: e.jurisdiction,
    name: e.jurisdictionName,
    status: e.status,
    measured: dollars(e.measuredSalesCents),
    threshold: e.thresholdSalesCents === null ? "—" : dollars(e.thresholdSalesCents),
    at: meter(e.fractionOfThreshold),
    due: e.registrationDueOn ?? "",
  }));

  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["jurisdiction", "name", "status", "measured", "threshold", "at", "due"],
      rows,
      title: `exposure · rule set ${response.ruleSet.version}${response.ruleSet.verified ? "" : " (unverified)"}`,
    }),
  );
  return { exitCode: 0 };
}

// ── nexus jurisdiction show <code> ───────────────────────────

export async function nexusJurisdictionShowCommand(ctx: CommandContext): Promise<CommandResult> {
  const code = ctx.args[0];
  if (!code) throw new UsageError("usage: nexara nexus jurisdiction show <code>");

  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const response = await client.exposure.getJurisdiction(orgId, code);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  const { exposure, rule, determinations } = response;
  if (!exposure.ruleSetVerified) {
    ctx.stderr(
      `! Rule set ${exposure.ruleSetVersion} is UNVERIFIED. This is not a compliance determination.`,
    );
  }

  // The explainer, in text. Same fields NX8's `determination-explainer`
  // renders, because a support conversation should not depend on which
  // surface the person happens to be looking at.
  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        jurisdiction: `${exposure.jurisdiction} (${exposure.jurisdictionName})`,
        status: exposure.status,
        rule: `${rule.id} · ${rule.ruleSetVersion}`,
        basis: rule.measurementBasis,
        period: rule.measurementPeriod,
        marketplace: rule.marketplaceTreatment,
        logic: rule.thresholdLogic,
        window:
          exposure.periodStart && exposure.periodEnd
            ? `${exposure.periodStart.slice(0, 10)} → ${exposure.periodEnd.slice(0, 10)} (exclusive)`
            : "not yet evaluated",
        measured: `${dollars(exposure.measuredSalesCents)} · ${exposure.measuredTransactions} txns`,
        threshold:
          exposure.thresholdSalesCents === null && exposure.thresholdTransactions === null
            ? "none — this jurisdiction enforces no economic-nexus threshold"
            : `${exposure.thresholdSalesCents === null ? "—" : dollars(exposure.thresholdSalesCents)} · ${exposure.thresholdTransactions ?? "—"} txns`,
        at: meter(exposure.fractionOfThreshold),
        crossed_on: exposure.crossedOn ?? "—",
        registration_due_on: exposure.registrationDueOn ?? "—",
        engine: determinations[0]?.engineVersion ?? "—",
        history: `${determinations.length} determination(s)`,
      },
      title: `${exposure.jurisdiction} · ${exposure.jurisdictionName}`,
    }),
  );
  return { exitCode: 0 };
}

// ── nexus evaluate ───────────────────────────────────────────

export async function nexusEvaluateCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const asOf = strFlag(ctx.flags["as-of"]);
  if (asOf && Number.isNaN(Date.parse(asOf))) {
    throw new UsageError(`--as-of must be an ISO-8601 timestamp (got ${asOf})`);
  }

  const client = await ctx.sdk();
  const response = await client.exposure.evaluate(orgId, asOf ? { asOf } : {});

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        evaluated_at: response.evaluatedAt,
        jurisdictions_evaluated: String(response.evaluated),
        // "Changed" rather than "written": a second run over an unchanged
        // ledger writes nothing, and that is the design working (§8 step 4),
        // not a failure to do anything.
        positions_changed: String(response.determinations.length),
        rule_set: `${response.ruleSetVersion}${response.ruleSetVerified ? "" : " (unverified)"}`,
      },
    }),
  );
  return { exitCode: 0 };
}

// ── ledger import --file ─────────────────────────────────────

export async function ledgerImportCommand(ctx: CommandContext): Promise<CommandResult> {
  const file = strFlag(ctx.flags["file"]);
  if (!file) throw new UsageError("usage: nexara ledger import --file <path.json>");

  let events: ImportSaleEventInput[];
  try {
    const raw = await readFile(file, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    events = Array.isArray(parsed)
      ? (parsed as ImportSaleEventInput[])
      : ((parsed as { events?: ImportSaleEventInput[] }).events ?? []);
  } catch (err) {
    throw new UsageError(`could not read ${file}: ${(err as Error).message}`);
  }
  if (events.length === 0) throw new UsageError(`${file} contains no events`);

  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  // `exactOptionalPropertyTypes` is on: an explicit `undefined` is not the
  // same as an absent key, and the transport treats an absent key as "send no
  // Idempotency-Key header" (Stripe parity — the CLI never auto-generates one).
  const idempotencyKey = strFlag(ctx.flags["idempotency-key"]);
  const response = await client.ledger.import(
    orgId,
    { events },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        submitted: String(response.submitted),
        applied: String(response.applied),
        // Not an error. A re-run of the same file reports every row as a
        // duplicate and changes nothing, which is the same guarantee the
        // backfill/live-sync overlap depends on.
        duplicates: String(response.duplicates),
      },
    }),
  );
  return { exitCode: 0 };
}

// ── ledger list ──────────────────────────────────────────────

export async function ledgerListCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const query: ListLedgerQuery = {};
  const jurisdiction = strFlag(ctx.flags["jurisdiction"]);
  if (jurisdiction !== undefined) query.jurisdiction = jurisdiction;
  const kind = strFlag(ctx.flags["kind"]);
  if (kind !== undefined) {
    if (kind !== "sale" && kind !== "refund") {
      throw new UsageError(`--kind must be 'sale' or 'refund' (got ${kind})`);
    }
    query.kind = kind;
  }
  const limit = strFlag(ctx.flags["limit"]);
  if (limit !== undefined) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError(`--limit must be a positive integer (got ${limit})`);
    }
    query.limit = n;
  }
  const cursor = strFlag(ctx.flags["cursor"]);
  if (cursor !== undefined) query.cursor = cursor;

  const response = await client.ledger.list(orgId, query);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "occurred", "jurisdiction", "kind", "gross", "reverses"],
      rows: response.events.map((e: PublicSaleEvent) => ({
        id: e.id,
        occurred: e.occurredAt.slice(0, 10),
        jurisdiction: e.jurisdiction,
        kind: e.kind,
        gross: dollars(e.grossCents),
        // A refund is shown as its own row linked to the original, never as a
        // mutation of it. Invariant 2, visible in the product.
        reverses: e.reversesEventId ?? "",
      })),
    }),
  );
  return { exitCode: 0 };
}

// ── registration list / set ──────────────────────────────────

export async function registrationListCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const response = await client.registrations.list(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["jurisdiction", "status", "registered_on", "permit_ref"],
      rows: response.registrations.map((r) => ({
        jurisdiction: r.jurisdiction,
        status: r.status,
        registered_on: r.registeredOn ?? "",
        permit_ref: r.permitRef ?? "",
      })),
    }),
  );
  return { exitCode: 0 };
}

export async function registrationSetCommand(ctx: CommandContext): Promise<CommandResult> {
  const jurisdiction = ctx.args[0];
  const status = strFlag(ctx.flags["status"]);
  if (!jurisdiction || !status) {
    throw new UsageError(
      "usage: nexara registration set <jurisdiction> --status <planned|filed|active|closed>",
    );
  }

  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const response = await client.registrations.upsert(orgId, {
    jurisdiction,
    status: status as "planned" | "filed" | "active" | "closed",
    registeredOn: strFlag(ctx.flags["registered-on"]) ?? null,
    permitRef: strFlag(ctx.flags["permit-ref"]) ?? null,
    notes: strFlag(ctx.flags["notes"]) ?? null,
  });

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: response }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      record: {
        jurisdiction: response.registration.jurisdiction,
        status: response.registration.status,
        registered_on: response.registration.registeredOn ?? "—",
      },
    }),
  );
  return { exitCode: 0 };
}

/** Determination history, newest first — the evidence trail as a table. */
export async function nexusHistoryCommand(ctx: CommandContext): Promise<CommandResult> {
  const code = ctx.args[0];
  if (!code) throw new UsageError("usage: nexara nexus history <code>");

  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const response = await client.exposure.getJurisdiction(orgId, code);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { determinations: response.determinations } }));
    return { exitCode: 0 };
  }

  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "evaluated", "status", "measured", "rule_set", "engine"],
      rows: response.determinations.map((d: PublicDetermination) => ({
        id: d.id,
        evaluated: d.evaluatedAt.slice(0, 19).replace("T", " "),
        status: d.status,
        measured: dollars(d.measuredSalesCents),
        // The reproducibility triple, on every row, so the table itself is
        // the audit answer rather than a pointer to one.
        rule_set: d.ruleSetVersion,
        engine: d.engineVersion,
      })),
      title: `${code} · determination history`,
    }),
  );
  return { exitCode: 0 };
}
