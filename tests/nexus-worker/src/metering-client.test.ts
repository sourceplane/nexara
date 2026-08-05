// Usage reporting from the evaluation cron.
//
// Two properties carry this module and both are asserted here rather than
// trusted to a comment:
//
//   1. **The idempotency key is deterministic per period.** The cron runs
//      hourly and re-measures any org with new ledger activity. Without a
//      period-derived key the rollup would count how often the cron fired
//      rather than what the seller used.
//   2. **It never throws.** The caller ignores the result, so an exception
//      here would abort an org's evaluation partway through the tick — a
//      metering outage costing a seller their tax measurement, which is
//      exactly the wrong trade.

import {
  reportUsage,
  usageIdempotencyKey,
  usagePeriodKey,
  INTERNAL_CALLER,
} from "@nexus-worker/metering-client";

const ORG = "org_11111111111111111111111111111111";
const METRIC = "jurisdictions_monitored";

function fetcherReturning(body: unknown, status = 201): Fetcher & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    fetch(input: unknown, init?: RequestInit) {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
    calls,
  } as unknown as Fetcher & { calls: Array<{ url: string; init: RequestInit }> };
}

const throwingFetcher = {
  fetch() {
    throw new Error("service binding exploded");
  },
} as unknown as Fetcher;

describe("usagePeriodKey", () => {
  it("buckets to the UTC hour", () => {
    expect(usagePeriodKey(new Date("2026-08-05T11:07:00.000Z"))).toBe("2026-08-05T11");
    expect(usagePeriodKey(new Date("2026-08-05T11:59:59.999Z"))).toBe("2026-08-05T11");
  });

  it("rolls to the next bucket on the hour boundary", () => {
    expect(usagePeriodKey(new Date("2026-08-05T12:00:00.000Z"))).toBe("2026-08-05T12");
  });
});

describe("usageIdempotencyKey", () => {
  it("is stable across every run inside one hour", () => {
    const a = usageIdempotencyKey(ORG, METRIC, new Date("2026-08-05T11:07:00Z"));
    const b = usageIdempotencyKey(ORG, METRIC, new Date("2026-08-05T11:53:00Z"));
    expect(a).toBe(b);
  });

  it("differs by hour, by org, and by metric", () => {
    const base = usageIdempotencyKey(ORG, METRIC, new Date("2026-08-05T11:00:00Z"));
    expect(usageIdempotencyKey(ORG, METRIC, new Date("2026-08-05T12:00:00Z"))).not.toBe(base);
    expect(usageIdempotencyKey("org_2", METRIC, new Date("2026-08-05T11:00:00Z"))).not.toBe(base);
    expect(usageIdempotencyKey(ORG, "sale_events_ingested", new Date("2026-08-05T11:00:00Z"))).not.toBe(base);
  });

  it("namespaces the key so it cannot collide with another context's", () => {
    expect(usageIdempotencyKey(ORG, METRIC, new Date("2026-08-05T11:00:00Z"))).toMatch(/^nexus:/);
  });
});

describe("reportUsage", () => {
  const asOf = new Date("2026-08-05T11:07:00Z");

  it("presents the internal-caller header metering-worker's allow-list expects", async () => {
    const f = fetcherReturning({ data: { recorded: true, duplicate: false } });
    await reportUsage(f, ORG, METRIC, 12, asOf, "req_1");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-internal-caller"]).toBe(INTERNAL_CALLER);
    expect(INTERNAL_CALLER).toBe("nexus-worker");
    expect(f.calls[0]!.url).toContain("/v1/internal/metering/usage");
  });

  it("sends the period-derived idempotency key and the org public id", async () => {
    const f = fetcherReturning({ data: { recorded: true, duplicate: false } });
    await reportUsage(f, ORG, METRIC, 12, asOf, "req_1");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.orgId).toBe(ORG);
    expect(body.metric).toBe(METRIC);
    expect(body.quantity).toBe(12);
    expect(body.idempotencyKey).toBe(usageIdempotencyKey(ORG, METRIC, asOf));
  });

  it("reports a duplicate as a distinct outcome, not an error", async () => {
    const f = fetcherReturning({ data: { recorded: false, duplicate: true } }, 200);
    await expect(reportUsage(f, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({ kind: "duplicate" });
  });

  it("reports a fresh write as recorded", async () => {
    const f = fetcherReturning({ data: { recorded: true, duplicate: false } }, 201);
    await expect(reportUsage(f, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({ kind: "recorded" });
  });

  // Everything below is the never-throws contract.
  it("degrades when the binding is absent", async () => {
    await expect(reportUsage(undefined, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("degrades when the binding throws", async () => {
    await expect(reportUsage(throwingFetcher, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("degrades on a non-OK status", async () => {
    const f = fetcherReturning({ error: { code: "unauthorized" } }, 403);
    await expect(reportUsage(f, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("degrades on a malformed envelope rather than guessing", async () => {
    const f = fetcherReturning({ nonsense: true }, 201);
    await expect(reportUsage(f, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("degrades on a non-JSON body", async () => {
    const f = {
      fetch: () => Promise.resolve(new Response("not json", { status: 201 })),
    } as unknown as Fetcher;
    await expect(reportUsage(f, ORG, METRIC, 12, asOf, "req_1")).resolves.toEqual({
      kind: "service_error",
    });
  });
});
