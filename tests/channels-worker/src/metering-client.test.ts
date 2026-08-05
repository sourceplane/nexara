// Usage reporting from the drain.
//
// The property under test is the one that differs from nexus-worker's client
// and that a copy-paste would have destroyed: `sale_events_ingested` is a
// COUNTER, so its idempotency key must be derived from the batch rather than
// from the clock. An hour-keyed counter would record the drain's first tick of
// each hour and silently discard the other fifty-nine, and the seller's usage
// would read as roughly 1/60th of what they actually sent — wrong in the
// direction nobody reports.

import {
  batchKey,
  usageIdempotencyKey,
  reportBatchUsage,
  INTERNAL_CALLER,
} from "@channels-worker/metering-client";

const ORG = "org_11111111111111111111111111111111";
const METRIC = "sale_events_ingested";
const NOW = new Date("2026-08-05T11:07:00Z");

function fetcherReturning(body: unknown, status = 201): Fetcher & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    fetch(input: unknown, init?: RequestInit) {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      );
    },
    calls,
  } as unknown as Fetcher & { calls: Array<{ url: string; init: RequestInit }> };
}

describe("batchKey", () => {
  it("is stable for the same set of deliveries", () => {
    expect(batchKey(["d1", "d2", "d3"])).toBe(batchKey(["d1", "d2", "d3"]));
  });

  it("ignores the order the drain happened to claim them in", () => {
    expect(batchKey(["d3", "d1", "d2"])).toBe(batchKey(["d1", "d2", "d3"]));
  });

  it("differs for a different set — this is what stops a counter being dropped", () => {
    expect(batchKey(["d1", "d2"])).not.toBe(batchKey(["d1", "d2", "d3"]));
    expect(batchKey(["d1"])).not.toBe(batchKey(["d2"]));
  });

  it("does not collide on a concatenation ambiguity", () => {
    // Without a separator, ["ab","c"] and ["a","bc"] would hash identically.
    expect(batchKey(["ab", "c"])).not.toBe(batchKey(["a", "bc"]));
  });

  it("is a fixed-width hex string", () => {
    expect(batchKey(["d1", "d2"])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("usageIdempotencyKey (counter semantics)", () => {
  it("does NOT vary by time — two ticks in the same minute with the same batch dedupe", () => {
    const a = usageIdempotencyKey(ORG, METRIC, ["d1", "d2"]);
    const b = usageIdempotencyKey(ORG, METRIC, ["d1", "d2"]);
    expect(a).toBe(b);
  });

  it("varies by batch, so consecutive ticks are each counted", () => {
    const tick1 = usageIdempotencyKey(ORG, METRIC, ["d1", "d2"]);
    const tick2 = usageIdempotencyKey(ORG, METRIC, ["d3", "d4"]);
    expect(tick1).not.toBe(tick2);
  });

  it("varies by org so two tenants' batches never share a key", () => {
    expect(usageIdempotencyKey(ORG, METRIC, ["d1"])).not.toBe(
      usageIdempotencyKey("org_22222222222222222222222222222222", METRIC, ["d1"]),
    );
  });

  it("is namespaced and marked as a batch key", () => {
    expect(usageIdempotencyKey(ORG, METRIC, ["d1"])).toMatch(/^nexus:.*:batch-[0-9a-f]{8}$/);
  });
});

describe("reportBatchUsage", () => {
  it("presents the channels-worker caller identity", async () => {
    const f = fetcherReturning({ data: { recorded: true, duplicate: false } });
    await reportBatchUsage(f, ORG, METRIC, 7, ["d1"], NOW, "req_1");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-internal-caller"]).toBe(
      INTERNAL_CALLER,
    );
    expect(INTERNAL_CALLER).toBe("channels-worker");
  });

  it("sends the batch-derived key and the counted quantity", async () => {
    const f = fetcherReturning({ data: { recorded: true, duplicate: false } });
    await reportBatchUsage(f, ORG, METRIC, 7, ["d2", "d1"], NOW, "req_1");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.quantity).toBe(7);
    expect(body.idempotencyKey).toBe(usageIdempotencyKey(ORG, METRIC, ["d1", "d2"]));
  });

  it("makes no call at all for an empty batch", async () => {
    const f = fetcherReturning({ data: { recorded: true, duplicate: false } });
    const out = await reportBatchUsage(f, ORG, METRIC, 0, [], NOW, "req_1");
    expect(f.calls).toHaveLength(0);
    expect(out).toEqual({ kind: "duplicate" });
  });

  // The never-throws contract: ingestion must not fail because bookkeeping did.
  it("degrades without a binding", async () => {
    await expect(reportBatchUsage(undefined, ORG, METRIC, 1, ["d1"], NOW, "r")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("degrades when the binding throws", async () => {
    const f = { fetch() { throw new Error("boom"); } } as unknown as Fetcher;
    await expect(reportBatchUsage(f, ORG, METRIC, 1, ["d1"], NOW, "r")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("degrades on a non-OK status", async () => {
    const f = fetcherReturning({ error: {} }, 403);
    await expect(reportBatchUsage(f, ORG, METRIC, 1, ["d1"], NOW, "r")).resolves.toEqual({
      kind: "service_error",
    });
  });

  it("reports a duplicate distinctly", async () => {
    const f = fetcherReturning({ data: { recorded: false, duplicate: true } }, 200);
    await expect(reportBatchUsage(f, ORG, METRIC, 1, ["d1"], NOW, "r")).resolves.toEqual({
      kind: "duplicate",
    });
  });
});
