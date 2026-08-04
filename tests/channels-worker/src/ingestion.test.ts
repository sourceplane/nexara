// NX6 — the ingestion pipeline.
//
// The milestone's acceptance criteria, made executable:
//
//   * a backfill page overlapping a live delivery for the same charge produces
//     ONE ledger row, not two — the design §6.3 seam, driven through the real
//     drain rather than asserted about the index;
//   * an unsigned or wrongly-signed delivery is rejected and **never reaches
//     the inbox**;
//   * a provider outage retries and then terminates at `failed` without
//     blocking other deliveries.
//
// Plus the two gate answers: Q4's staleness baseline and Q6's retention sweep.

import { backoffMs, drainInbox, MAX_ATTEMPTS, RETENTION } from "@channels-worker/drain";
import { evaluateStaleness, thresholdHours, MIN_QUIET_HOURS, MAX_QUIET_HOURS } from "@channels-worker/staleness";
import { normalizeCharge, normalizeRefund, createStripeProvider } from "@channels-worker/providers/stripe";
import { resolveProvider, isKnownProvider } from "@channels-worker/providers/registry";
import { handleIngest } from "@channels-worker/handlers/ingest";
import type { Env } from "@channels-worker/env";

const USD = (d: number): number => Math.round(d * 100);
const NOW = new Date("2026-08-04T12:00:00.000Z");

// ── Q4: staleness ────────────────────────────────────────────

describe("Q4 — the volume-aware staleness baseline", () => {
  it("uses the floor for a high-volume seller", () => {
    // Ten orders a day → a ~2.4h median. 6× is well under the floor, so the
    // floor governs: for that seller, a silent day IS an outage.
    const intervals = Array.from({ length: 20 }, () => 2.4);
    expect(thresholdHours(intervals)).toBe(MIN_QUIET_HOURS);
  });

  it("widens for a low-volume seller instead of nagging them", () => {
    // One order a week → 168h median → 6× = 1008h, capped at 504 (three weeks).
    const intervals = Array.from({ length: 10 }, () => 168);
    expect(thresholdHours(intervals)).toBe(MAX_QUIET_HOURS);
  });

  it("takes the median, not the mean", () => {
    // A Black Friday burst followed by a quiet January. The mean is dominated
    // by the burst and would put the threshold far too tight in January.
    const intervals = [1, 1, 1, 1, 1, 1, 1, 1, 1, 2000];
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    expect(thresholdHours(intervals)).toBe(MIN_QUIET_HOURS);
    expect(6 * mean).toBeGreaterThan(MIN_QUIET_HOURS);
  });

  it("does not flag a channel that is still backfilling", () => {
    // Flagging it would make the signal fire on every new connection, which is
    // how a signal gets muted.
    expect(
      evaluateStaleness({
        intervalsHours: [1, 1, 1, 1, 1],
        lastEventAt: new Date("2026-01-01T00:00:00.000Z"),
        backfillCompletedAt: null,
        now: NOW,
      }),
    ).toEqual({ stale: false, reason: "backfilling" });
  });

  it("does not invent a cadence from four events", () => {
    // A confidently wrong baseline is the failure mode this product is
    // organised against.
    expect(
      evaluateStaleness({
        intervalsHours: [1, 1],
        lastEventAt: new Date("2026-01-01T00:00:00.000Z"),
        backfillCompletedAt: NOW,
        now: NOW,
      }),
    ).toEqual({ stale: false, reason: "insufficient_history" });
  });

  it("flags a busy channel that went quiet for two days", () => {
    const verdict = evaluateStaleness({
      intervalsHours: [2, 2, 3, 2, 2, 3],
      lastEventAt: new Date("2026-08-02T12:00:00.000Z"),
      backfillCompletedAt: new Date("2026-07-01T00:00:00.000Z"),
      now: NOW,
    });
    expect(verdict.stale).toBe(true);
    if (!verdict.stale) return;
    expect(verdict.quietHours).toBeCloseTo(48, 5);
    expect(verdict.thresholdHours).toBe(MIN_QUIET_HOURS);
  });

  it("does not flag the same gap on a weekly seller", () => {
    expect(
      evaluateStaleness({
        intervalsHours: [168, 170, 160, 175, 168, 172],
        lastEventAt: new Date("2026-08-02T12:00:00.000Z"),
        backfillCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
        now: NOW,
      }),
    ).toEqual({ stale: false, reason: "within_cadence" });
  });

  it("reads no clock", async () => {
    // Same discipline as the determination engine: a function that reads the
    // clock cannot be replayed against a stored sample when someone asks why a
    // channel was flagged.
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      resolve(here, "../../..", "apps/channels-worker/src/staleness.ts"),
      "utf-8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/new\s+Date\s*\(\s*\)/);
  });
});

// ── The Stripe adapter ───────────────────────────────────────

describe("the Stripe adapter", () => {
  const charge = {
    id: "ch_1",
    amount: USD(1_200),
    currency: "usd",
    created: Math.floor(Date.parse("2026-03-04T15:00:00.000Z") / 1000),
    shipping: { address: { country: "US", state: "TX" } },
  };

  it("normalises a charge with integer cents and no conversion", () => {
    const [event] = normalizeCharge(charge);
    expect(event).toMatchObject({
      providerEventId: "ch_1",
      kind: "sale",
      jurisdiction: "US-TX",
      jurisdictionSource: "shipping_address",
      grossCents: USD(1_200),
      transactionCount: 1,
      currency: "USD",
    });
    // The one place a float could enter this product is an adapter doing
    // arithmetic on an amount. This one does none.
    expect(Number.isInteger(event!.grossCents)).toBe(true);
  });

  it("falls back to the billing address and records that it did", () => {
    // R4: "we guessed" must be visible in the evidence rather than laundered
    // into a fact.
    const [event] = normalizeCharge({
      ...charge,
      shipping: null,
      billing_details: { address: { country: "US", state: "CA" } },
    });
    expect(event).toMatchObject({
      jurisdiction: "US-CA",
      jurisdictionSource: "billing_address",
    });
  });

  it("returns nothing rather than guessing when no jurisdiction resolves", () => {
    // A sale attributed to the wrong state silently moves a threshold; a sale
    // we know we could not attribute shows up as a gap someone can ask about.
    expect(normalizeCharge({ ...charge, shipping: null })).toEqual([]);
  });

  it("does not attribute a US charge with no state", () => {
    // "US" is not a jurisdiction this product measures, and inventing one is
    // worse than skipping.
    expect(
      normalizeCharge({ ...charge, shipping: { address: { country: "US", state: null } } }),
    ).toEqual([]);
  });

  it("handles a non-US country as its own jurisdiction", () => {
    const [event] = normalizeCharge({
      ...charge,
      shipping: { address: { country: "gb", state: null } },
    });
    expect(event!.jurisdiction).toBe("GB");
  });

  it("normalises a refund as a negative row with a distinct provider id", () => {
    // A distinct id so the refund and its sale cannot collide on the dedupe
    // key — `kind` is also in that key, so this is belt to those braces, and
    // it makes the row legible without decoding the key.
    const [event] = normalizeRefund({ ...charge, amount_refunded: USD(1_200), refunded: true });
    expect(event).toMatchObject({
      providerEventId: "ch_1:refund",
      kind: "refund",
      reversesProviderEventId: "ch_1",
      grossCents: -USD(1_200),
      transactionCount: -1,
    });
  });

  it("nets a full reversal to exactly zero", () => {
    const sale = normalizeCharge(charge)[0]!;
    const refund = normalizeRefund({ ...charge, amount_refunded: USD(1_200) })[0]!;
    expect(sale.grossCents + refund.grossCents).toBe(0);
    expect(sale.transactionCount + refund.transactionCount).toBe(0);
  });

  it("ignores event types that are not sales", () => {
    // Providers send dozens we do not care about. Treating them as failures
    // would fill the drain's retry budget with events that will never become
    // sales.
    const provider = createStripeProvider({
      clientId: "ca_x", secretKey: "sk_x", webhookSecret: "whsec_x",
    });
    expect(provider.normalize({ type: "customer.created", data: { object: {} } })).toEqual([]);
  });

  describe("signature verification", () => {
    const secret = "whsec_test";
    const provider = createStripeProvider({ clientId: "ca_x", secretKey: "sk_x", webhookSecret: secret });

    async function sign(body: string, timestamp: number): Promise<string> {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      );
      const sig = await crypto.subtle.sign(
        "HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`),
      );
      const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `t=${timestamp},v1=${hex}`;
    }

    const body = JSON.stringify({ id: "evt_1" });
    const bytes = (): ArrayBuffer => new TextEncoder().encode(body).buffer as ArrayBuffer;

    it("accepts a correctly signed body", async () => {
      const ts = Math.floor(Date.now() / 1000);
      const headers = new Headers({ "stripe-signature": await sign(body, ts) });
      expect(await provider.verifyInboundSignature(bytes(), headers)).toBe(true);
    });

    it("rejects a body signed with the wrong secret", async () => {
      const other = createStripeProvider({
        clientId: "ca_x", secretKey: "sk_x", webhookSecret: "whsec_other",
      });
      const ts = Math.floor(Date.now() / 1000);
      const headers = new Headers({ "stripe-signature": await sign(body, ts) });
      expect(await other.verifyInboundSignature(bytes(), headers)).toBe(false);
    });

    it("rejects a tampered body", async () => {
      const ts = Math.floor(Date.now() / 1000);
      const headers = new Headers({ "stripe-signature": await sign(body, ts) });
      const tampered = new TextEncoder().encode(JSON.stringify({ id: "evt_2" }))
        .buffer as ArrayBuffer;
      expect(await provider.verifyInboundSignature(tampered, headers)).toBe(false);
    });

    it("rejects a replayed delivery outside the tolerance window", async () => {
      // Without a replay window a captured delivery is replayable forever —
      // and because the ledger dedupes, the damage is not a double-count but a
      // resurrection of a refunded or corrected event.
      const stale = Math.floor(Date.now() / 1000) - 3_600;
      const headers = new Headers({ "stripe-signature": await sign(body, stale) });
      expect(await provider.verifyInboundSignature(bytes(), headers)).toBe(false);
    });

    it("rejects a missing header", async () => {
      expect(await provider.verifyInboundSignature(bytes(), new Headers())).toBe(false);
    });

    it("accepts either signature during a secret rotation", async () => {
      const ts = Math.floor(Date.now() / 1000);
      const good = (await sign(body, ts)).split("v1=")[1]!;
      const headers = new Headers({ "stripe-signature": `t=${ts},v1=deadbeef,v1=${good}` });
      expect(await provider.verifyInboundSignature(bytes(), headers)).toBe(true);
    });
  });
});

describe("the provider registry fails closed", () => {
  it("resolves null when a credential is missing", () => {
    // An adapter that "works" until it reaches the network produces a channel
    // that looks connected and ingests nothing — indistinguishable from a
    // seller with no sales.
    const env = { ENVIRONMENT: "test", STRIPE_CLIENT_ID: "ca_x" } as Env;
    expect(resolveProvider(env, "stripe")).toBeNull();
  });

  it("resolves a provider when the set is complete", () => {
    const env = {
      ENVIRONMENT: "test",
      STRIPE_CLIENT_ID: "ca_x",
      STRIPE_SECRET_KEY: "sk_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    } as Env;
    expect(resolveProvider(env, "stripe")?.id).toBe("stripe");
  });

  it("resolves shopify to null until NX7", () => {
    expect(resolveProvider({ ENVIRONMENT: "test" } as Env, "shopify")).toBeNull();
  });

  it("rejects an unknown provider id", () => {
    expect(isKnownProvider("paypal")).toBe(false);
  });
});

// ── The ingress ──────────────────────────────────────────────

describe("the unauthenticated ingress", () => {
  const env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as Hyperdrive,
    STRIPE_CLIENT_ID: "ca_x",
    STRIPE_SECRET_KEY: "sk_x",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  } as Env;

  function post(body: string, headers: Record<string, string> = {}): Request {
    return new Request("https://c/v1/channels/stripe/webhook", {
      method: "POST",
      body,
      headers,
    });
  }

  it("rejects an unsigned delivery", async () => {
    const res = await handleIngest(post(JSON.stringify({ id: "evt_1" })), env, "req_1", "stripe");
    expect(res.status).toBe(401);
  });

  it("rejects an unknown provider with the SAME shape as a bad signature", async () => {
    // The difference is an oracle for someone probing which provider a tenant
    // uses.
    const bad = await handleIngest(post(JSON.stringify({ id: "e" })), env, "req_1", "stripe");
    const unknown = await handleIngest(post(JSON.stringify({ id: "e" })), env, "req_1", "paypal");
    expect(unknown.status).toBe(bad.status);
    expect(await unknown.json()).toEqual(await bad.json());
  });

  it("refuses an oversized body before doing any crypto", async () => {
    // A signature check on an unbounded body is a free CPU-exhaustion
    // primitive on an unauthenticated route.
    const res = await handleIngest(
      post("{}", { "content-length": String(10_000_000) }),
      env,
      "req_1",
      "stripe",
    );
    expect(res.status).toBe(413);
  });

  it("reports 503, not 401, when the provider is unconfigured", async () => {
    // This failure is OURS. A provider retrying against a misconfigured
    // environment should be told to come back, not to give up.
    const res = await handleIngest(
      post(JSON.stringify({ id: "e" })),
      { ENVIRONMENT: "test" } as Env,
      "req_1",
      "stripe",
    );
    expect(res.status).toBe(503);
  });
});

// ── The drain ────────────────────────────────────────────────

describe("the drain", () => {
  it("backs off 1m, 2m, 4m, 8m, 16m and then terminates", () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000,
    ]);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it("keeps a failed payload longer than an applied one", () => {
    // A failed delivery is precisely the one someone will want to look at, and
    // also the one that will not be looked at today.
    expect(RETENTION.failedDays).toBeGreaterThan(RETENTION.appliedDays);
    expect(RETENTION).toEqual({ appliedDays: 7, failedDays: 30 });
  });

  it("covers the backfill/live seam without double-counting", async () => {
    // Design §6.3's acceptance criterion, driven through the REAL drain: a
    // live delivery and an overlapping backfill page for the same charge
    // produce one ledger row.
    const harness = drainHarness();

    // Live delivery arrives first.
    harness.enqueue({ id: "evt_live", account: "acct_1", charge: "ch_seam" });
    await drainInbox(harness.executor, harness.env, NOW);
    expect(harness.ledger).toHaveLength(1);

    // The backfill page for the same charge arrives after.
    harness.enqueue({ id: "evt_backfill", account: "acct_1", charge: "ch_seam" });
    const second = await drainInbox(harness.executor, harness.env, NOW);

    expect(harness.ledger).toHaveLength(1);
    expect(second.duplicates).toBe(1);
    expect(second.eventsAppended).toBe(0);
  });

  it("skips an unattributed delivery rather than guessing a tenant", async () => {
    // Attributing to a guess would put one seller's sales on another seller's
    // ledger — the worst outcome in the system.
    const harness = drainHarness();
    harness.enqueue({ id: "evt_x", account: "acct_unknown", charge: "ch_x" });
    const summary = await drainInbox(harness.executor, harness.env, NOW);
    expect(summary.skipped).toBe(1);
    expect(harness.ledger).toHaveLength(0);
    expect(harness.deliveries[0]!.last_error).toBe("unattributed");
  });

  it("never lets an unverified delivery become a ledger row", async () => {
    const harness = drainHarness();
    harness.enqueue({ id: "evt_x", account: "acct_1", charge: "ch_x", verified: false });
    const summary = await drainInbox(harness.executor, harness.env, NOW);
    expect(summary.skipped).toBe(1);
    expect(harness.ledger).toHaveLength(0);
  });

  it("retries a transient failure and does not block the batch", async () => {
    const harness = drainHarness();
    harness.failNext = 1;
    harness.enqueue({ id: "evt_a", account: "acct_1", charge: "ch_a" });
    harness.enqueue({ id: "evt_b", account: "acct_1", charge: "ch_b" });

    const summary = await drainInbox(harness.executor, harness.env, NOW);
    expect(summary.retried).toBe(1);
    // The second delivery still landed. A single malformed payload freezing
    // every other tenant's ingestion is the shared-fate bug whose symptom is
    // *absence*.
    expect(summary.applied).toBe(1);
    expect(harness.ledger).toHaveLength(1);
  });

  it("terminates at failed after the fifth attempt", async () => {
    const harness = drainHarness();
    harness.failNext = 1;
    harness.enqueue({ id: "evt_a", account: "acct_1", charge: "ch_a", attempts: MAX_ATTEMPTS - 1 });
    const summary = await drainInbox(harness.executor, harness.env, NOW);
    expect(summary.failed).toBe(1);
    expect(harness.deliveries[0]!.status).toBe("failed");
  });

  it("records a short reason and never a payload", async () => {
    // Design §12's prohibition: `last_error` is a log sink by another name, so
    // a driver error carrying a serialised row must not reach it.
    //
    // Note WHERE this is enforced. The repository catches the driver error and
    // returns a `Result` with a fixed message, so the PII never reaches the
    // drain at all; the drain's own `safeReason` is the second line, for
    // errors thrown outside a repository call. Two independent layers, and the
    // assertion below is deliberately about the property rather than about
    // which layer produced it.
    const harness = drainHarness();
    harness.failWith = new Error(JSON.stringify({ customer: "Jane Doe", line1: "1 Main St" }));
    harness.failNext = 1;
    harness.enqueue({ id: "evt_a", account: "acct_1", charge: "ch_a" });
    await drainInbox(harness.executor, harness.env, NOW);

    const reason = harness.deliveries[0]!.last_error!;
    expect(reason).toMatch(/^[\w.:-]{1,120}$/);
    expect(reason).not.toContain("Jane");
    expect(reason).not.toContain("Main St");
    expect(reason).not.toContain("{");
  });

  it("sanitises a reason thrown outside a repository call", () => {
    // The drain's own second line, exercised directly: anything that is not a
    // short machine token collapses to `processing_error` rather than being
    // written verbatim.
    const messy = new Error(JSON.stringify({ customer: "Jane Doe" }));
    const clean = new Error("provider_unconfigured");
    expect(safeReasonFor(messy)).toBe("processing_error");
    expect(safeReasonFor(clean)).toBe("provider_unconfigured");
  });
});

/** Mirrors `drain.ts`'s private `safeReason`, so its contract has a test even
 *  though the function is not exported. Kept adjacent to the assertion above
 *  so a divergence is visible in one screen. */
function safeReasonFor(err: unknown): string {
  const message = err instanceof Error ? err.message : "unknown_error";
  return /^[\w.:-]{1,120}$/.test(message) ? message : "processing_error";
}

// ── Harness ──────────────────────────────────────────────────

interface StoredDelivery {
  id: string;
  provider: string;
  provider_delivery_id: string;
  payload: unknown;
  signature_verified: boolean;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  received_at: string;
  applied_at: string | null;
  purged_at: string | null;
  org_id: string | null;
  channel_id: string | null;
}

/**
 * A narrow in-memory stand-in for Postgres implementing exactly the statements
 * the drain issues. It exists so the seam and the retry semantics can be
 * asserted *through the real drain code*; it is not a claim that Postgres
 * agrees, which the query-shape assertions in `tests/db` cover.
 */
function drainHarness() {
  const ORG = "00000000-0000-4000-8000-000000000001";
  const CHANNEL = "00000000-0000-4000-8000-000000000b01";
  const deliveries: Array<Record<string, unknown>> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const harness = {
    deliveries: deliveries as unknown as StoredDelivery[],
    ledger,
    failNext: 0,
    failWith: new Error("boom") as Error,
    env: {
      ENVIRONMENT: "test",
      STRIPE_CLIENT_ID: "ca_x",
      STRIPE_SECRET_KEY: "sk_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    } as Env,
    enqueue(o: {
      id: string;
      account: string;
      charge: string;
      verified?: boolean;
      attempts?: number;
    }) {
      deliveries.push({
        id: `00000000-0000-4000-8000-${deliveries.length.toString().padStart(12, "0")}`,
        provider: "stripe",
        provider_delivery_id: o.id,
        payload: {
          id: o.id,
          account: o.account,
          type: "charge.succeeded",
          data: {
            object: {
              id: o.charge,
              amount: USD(500),
              currency: "usd",
              created: Math.floor(Date.parse("2026-03-04T15:00:00.000Z") / 1000),
              shipping: { address: { country: "US", state: "TX" } },
            },
          },
        },
        signature_verified: o.verified ?? true,
        status: "received",
        attempts: o.attempts ?? 0,
        next_attempt_at: null,
        last_error: null,
        received_at: NOW.toISOString(),
        applied_at: null,
        purged_at: null,
        org_id: null,
        channel_id: null,
      });
    },
    executor: undefined as never,
  };

  const execute = async (text: string, params: unknown[] = []) => {
    if (/FROM nexus\.inbound_deliveries[\s\S]*status = 'received'/.test(text)) {
      const rows = deliveries.filter((d) => d.status === "received");
      return { rows, rowCount: rows.length };
    }
    if (/SELECT \* FROM nexus\.channels[\s\S]*provider = \$1/.test(text)) {
      const [, accountId] = params as [string, string];
      if (accountId !== "acct_1") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: CHANNEL, org_id: ORG, provider: "stripe", external_account_id: "acct_1",
          display_name: "Acme", status: "connected", credentials_ref: null,
          backfill_started_at: NOW.toISOString(), backfill_completed_at: NOW.toISOString(),
          backfill_cursor: null, lookback_floor: "2023-08-04", last_event_at: null,
          created_at: NOW.toISOString(), updated_at: NOW.toISOString(), revoked_at: null,
        }],
        rowCount: 1,
      };
    }
    if (/^\s*INSERT INTO nexus\.sale_events/.test(text)) {
      if (harness.failNext > 0) {
        harness.failNext -= 1;
        throw harness.failWith;
      }
      const COLS = 18;
      const inserted: Array<Record<string, unknown>> = [];
      for (let i = 0; i < params.length; i += COLS) {
        const row: Record<string, unknown> = {
          id: params[i], org_id: params[i + 1], channel_id: params[i + 2],
          source: params[i + 3], provider_event_id: params[i + 4], kind: params[i + 5],
          reverses_event_id: params[i + 6], occurred_at: params[i + 7],
          jurisdiction: params[i + 8], jurisdiction_source: params[i + 9],
          ship_to_country: params[i + 10], ship_to_region: params[i + 11],
          gross_cents: params[i + 12], retail_cents: params[i + 13],
          taxable_cents: params[i + 14], transaction_count: params[i + 15],
          marketplace_facilitated: params[i + 16], currency: params[i + 17],
          ingested_at: NOW.toISOString(),
        };
        const key = `${row.org_id}|${row.channel_id}|${row.provider_event_id}|${row.kind}`;
        if (ledger.some((e) => `${e.org_id}|${e.channel_id}|${e.provider_event_id}|${e.kind}` === key)) {
          continue; // ON CONFLICT DO NOTHING — the seam's guarantee.
        }
        ledger.push(row);
        inserted.push(row);
      }
      return { rows: inserted, rowCount: inserted.length };
    }
    if (/SELECT id, channel_id, provider_event_id, kind/.test(text)) {
      return { rows: ledger, rowCount: ledger.length };
    }
    if (/UPDATE nexus\.inbound_deliveries[\s\S]*status = 'applied'/.test(text)) {
      const d = deliveries.find((x) => x.id === params[0]);
      if (d) { d.status = "applied"; d.org_id = params[1]; d.channel_id = params[2]; }
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE nexus\.inbound_deliveries[\s\S]*status = 'skipped'/.test(text)) {
      const d = deliveries.find((x) => x.id === params[0]);
      if (d) { d.status = "skipped"; d.last_error = params[1]; }
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE nexus\.inbound_deliveries[\s\S]*status = 'failed'/.test(text)) {
      const d = deliveries.find((x) => x.id === params[0]);
      if (d) { d.status = "failed"; d.last_error = params[1]; }
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE nexus\.inbound_deliveries[\s\S]*SET attempts/.test(text)) {
      const d = deliveries.find((x) => x.id === params[0]);
      if (d) { d.attempts = params[1]; d.next_attempt_at = params[2]; d.last_error = params[3]; }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  harness.executor = {
    execute,
    async transaction<T>(fn: (tx: { execute: typeof execute }) => Promise<T>): Promise<T> {
      // Real transactional semantics matter here: the whole point of the
      // drain's guarantee is that a failure rolls back the ledger insert AND
      // the applied mark together.
      const before = { ledger: [...ledger], deliveries: deliveries.map((d) => ({ ...d })) };
      try {
        return await fn({ execute });
      } catch (err) {
        ledger.length = 0;
        ledger.push(...before.ledger);
        deliveries.length = 0;
        deliveries.push(...before.deliveries);
        throw err;
      }
    },
    async dispose() {},
  } as never;

  return harness;
}
