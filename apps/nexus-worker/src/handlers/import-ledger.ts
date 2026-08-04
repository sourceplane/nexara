// POST /v1/organizations/:orgId/ledger/import
//
// The seam through which a ledger can be seeded without a connector — CSV
// import, the demo tenant, and the whole NX0→NX4 demo cut.
//
// Two properties are non-negotiable and both are asserted:
//
//   * **A malformed import is a wholesale 422 with no partial writes.** Half a
//     ledger is worse than none: the totals look plausible and are wrong, and
//     an append-only ledger has no way to take the half back.
//   * **A duplicate is success.** `applied + duplicates === submitted`, and a
//     re-run of the same file changes nothing. That is the same guarantee the
//     backfill/live-sync overlap depends on, exercised by a path a human can
//     drive.

import type { ImportLedgerResponse, ImportSaleEventInput } from "@saas/contracts/nexus";
import type { AppendSaleEventInput, NexusRepository } from "@saas/db/nexus";
import type { Uuid } from "@saas/db/ids";
import { createNexusRepository } from "@saas/db/nexus";
import { createSqlExecutor } from "@saas/db/hyperdrive";

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { requireBindings, requireOrgAction } from "./gate.js";
import { parseChannelPublicId, parseSaleEventPublicId } from "../ids.js";
import { isKnownJurisdictionCode } from "../jurisdictions.js";

const MAX_EVENTS = 1_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const KINDS = new Set(["sale", "refund"]);
const JURISDICTION_SOURCES = new Set([
  "shipping_address",
  "billing_address",
  "tax_lines",
  "declared",
]);

export interface HandleImportLedgerDeps {
  repo?: NexusRepository;
}

export async function handleImportLedger(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleImportLedgerDeps,
): Promise<Response> {
  const missing = requireBindings(env, requestId);
  if (missing) return missing;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const gate = await requireOrgAction(env, requestId, actor, orgId, "organization.ledger.import");
  if (!gate.ok) return gate.response;

  const executor = deps?.repo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps?.repo ?? createNexusRepository(executor!);

    // The caller's channels, resolved once. A row citing a channel that is not
    // this tenant's is a validation failure here AND a foreign-key violation
    // in the database (NX1.5 finding S-2) — belt and braces, because this is
    // the one write path a human drives by hand.
    const channelsResult = await repo.getChannelIdsForOrg(orgId);
    if (!channelsResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    const ownChannels = new Set(channelsResult.value);

    const parsed = validate(body, ownChannels);
    if (!parsed.valid) {
      // Wholesale. Every row is reported, so a caller fixing a 900-row file
      // does not discover the next problem one round trip at a time.
      return validationError(requestId, parsed.fields);
    }

    const result = await repo.appendSaleEvents(orgId, parsed.rows);
    if (!result.ok) {
      if (result.error.kind === "invalid") {
        return validationError(requestId, { events: [result.error.message] });
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // R3: the staleness signal is only as good as our own bookkeeping. A
    // channel that just received a year of backfill must not read as quiet.
    for (const channelId of new Set(parsed.rows.map((r) => r.channelId))) {
      const newest = parsed.rows
        .filter((r) => r.channelId === channelId)
        .reduce((max, r) => (r.occurredAt > max ? r.occurredAt : max), new Date(0));
      await repo.touchChannelLastEvent(orgId, channelId, newest);
    }

    // NX1.5 finding S-8 / R9. A re-delivery whose money differs from what is
    // stored is dropped by the dedupe index and the first amount stands
    // forever. It must not read as an ordinary no-op, so it is surfaced here
    // rather than counted as a duplicate and forgotten.
    if (result.value.divergent.length > 0) {
      // Design §12 named signal. Ids only, never payloads: the raw provider
      // body carries customer names and addresses, the inbox already holds it
      // under a retention policy, and a log sink is precisely where that
      // policy stops applying.
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "ledger.divergent_duplicate",
          requestId,
          count: result.value.divergent.length,
          providerEventIds: result.value.divergent.map((d) => d.providerEventId),
        }),
      );
    }

    const response: ImportLedgerResponse = {
      submitted: result.value.submitted,
      applied: result.value.applied,
      duplicates: result.value.duplicates,
    };
    return successResponse(response, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

type Validated =
  | { valid: true; rows: AppendSaleEventInput[] }
  | { valid: false; fields: Record<string, string[]> };

function validate(body: unknown, ownChannels: ReadonlySet<string>): Validated {
  const fields: Record<string, string[]> = {};
  if (!body || typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return { valid: false, fields: { events: ["Must be an array"] } };
  }
  if (events.length === 0) {
    return { valid: false, fields: { events: ["Must contain at least one event"] } };
  }
  if (events.length > MAX_EVENTS) {
    return { valid: false, fields: { events: [`Must contain at most ${MAX_EVENTS} events`] } };
  }

  const rows: AppendSaleEventInput[] = [];
  // Within one request, too: two rows sharing a dedupe key would make
  // `applied + duplicates === submitted` false through no fault of the
  // database, and the caller would have no way to tell which one landed.
  const seen = new Set<string>();

  events.forEach((raw, i) => {
    const at = (field: string, message: string): void => {
      const key = `events[${i}].${field}`;
      (fields[key] ??= []).push(message);
    };
    if (!raw || typeof raw !== "object") {
      at("", "Must be an object");
      return;
    }
    const e = raw as Partial<ImportSaleEventInput> & Record<string, unknown>;

    const channelUuid = typeof e.channelId === "string" ? parseChannelPublicId(e.channelId) : null;
    if (!channelUuid) at("channelId", "Must be a channel id of the form chn_<32 hex>");
    else if (!ownChannels.has(channelUuid)) at("channelId", "Unknown channel");

    if (typeof e.providerEventId !== "string" || e.providerEventId.length < 1 || e.providerEventId.length > 255) {
      at("providerEventId", "Must be a string of 1–255 characters");
    }
    if (typeof e.kind !== "string" || !KINDS.has(e.kind)) {
      at("kind", "Must be 'sale' or 'refund'");
    }
    if (typeof e.occurredAt !== "string" || !ISO_RE.test(e.occurredAt) || Number.isNaN(Date.parse(e.occurredAt))) {
      at("occurredAt", "Must be an ISO-8601 timestamp");
    }
    if (typeof e.jurisdiction !== "string" || !isKnownJurisdictionCode(e.jurisdiction)) {
      at("jurisdiction", "Must be a jurisdiction code such as US-TX or GB");
    }
    if (typeof e.currency !== "string" || !CURRENCY_RE.test(e.currency)) {
      at("currency", "Must be a three-letter uppercase ISO-4217 code");
    }

    for (const field of ["grossCents", "retailCents", "taxableCents"] as const) {
      const v = e[field];
      if (typeof v !== "number" || !Number.isSafeInteger(v)) {
        // Integer cents, refused at the boundary. A float here is how a
        // rounding error becomes a threshold answer.
        at(field, "Must be an integer number of cents");
      }
    }
    const txnCount = e.transactionCount ?? (e.kind === "refund" ? -1 : 1);
    if (!Number.isSafeInteger(txnCount)) at("transactionCount", "Must be an integer");

    if (e.jurisdictionSource !== undefined && !JURISDICTION_SOURCES.has(String(e.jurisdictionSource))) {
      at("jurisdictionSource", "Must be one of shipping_address, billing_address, tax_lines, declared");
    }

    // The sign discipline the schema enforces, checked here so the caller gets
    // a 422 naming the row rather than a 503 from a constraint violation.
    const cents = [e.grossCents, e.retailCents, e.taxableCents].filter(
      (v): v is number => typeof v === "number",
    );
    if (e.kind === "sale" && (cents.some((c) => c < 0) || txnCount < 0)) {
      at("grossCents", "A sale must not carry negative amounts");
    }
    if (e.kind === "refund" && (cents.some((c) => c > 0) || txnCount > 0)) {
      at("grossCents", "A refund must carry negative amounts");
    }

    let reversesUuid: Uuid | null = null;
    if (e.kind === "refund") {
      if (typeof e.reversesEventId !== "string") {
        at("reversesEventId", "Required when kind is 'refund'");
      } else {
        reversesUuid = parseSaleEventPublicId(e.reversesEventId);
        if (!reversesUuid) at("reversesEventId", "Must be an event id of the form sev_<32 hex>");
      }
    } else if (e.reversesEventId != null) {
      at("reversesEventId", "Only a refund may reverse an event");
    }

    if (channelUuid && typeof e.providerEventId === "string" && typeof e.kind === "string") {
      const key = `${channelUuid}|${e.providerEventId}|${e.kind}`;
      if (seen.has(key)) {
        at("providerEventId", "Duplicated within this request");
      }
      seen.add(key);
    }

    if (Object.keys(fields).length > 0) return;

    rows.push({
      id: crypto.randomUUID(),
      channelId: channelUuid!,
      // Fixed by the endpoint, never by the caller: a client claiming its rows
      // arrived by webhook would corrupt the provenance the evidence rests on.
      source: "csv",
      providerEventId: e.providerEventId as string,
      kind: e.kind as "sale" | "refund",
      reversesEventId: reversesUuid,
      occurredAt: new Date(e.occurredAt as string),
      jurisdiction: e.jurisdiction as string,
      jurisdictionSource: (e.jurisdictionSource ?? "declared") as AppendSaleEventInput["jurisdictionSource"],
      shipToCountry: typeof e.shipToCountry === "string" ? e.shipToCountry : null,
      shipToRegion: typeof e.shipToRegion === "string" ? e.shipToRegion : null,
      grossCents: e.grossCents as number,
      retailCents: e.retailCents as number,
      taxableCents: e.taxableCents as number,
      transactionCount: txnCount as number,
      marketplaceFacilitated: e.marketplaceFacilitated === true,
      currency: e.currency as string,
    });
  });

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, rows };
}
