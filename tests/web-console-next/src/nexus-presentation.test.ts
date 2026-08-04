// Console presentation rules for the nexus surfaces.
//
// These are not styling tests. Each block below pins a rule where getting the
// display wrong would make the product *say something false* — the difference
// between "we have no data" and "there is no threshold", between a clamped bar
// and a clamped number, between a rule set we have verified and one we have
// not. Everything under test is pure, so the rule is asserted directly rather
// than through a rendered tree.

import {
  describeBackfill,
  describeBasis,
  describeJurisdictionSource,
  describeLogic,
  describeMarketplace,
  describePeriod,
  describeWindow,
  formatCents,
  formatCentsCompact,
  formatDate,
  isReversal,
  meterPercent,
  meterWidth,
  presentChannel,
  presentDelivery,
  presentStatus,
  shouldWarnUnverified,
  sortExposure,
  summarizeExposure,
  toneVariant,
  unverifiedNotice,
} from "@web-console-next/components/nexus/nexus";
import {
  alertContactState,
  presentAlertContact,
} from "@web-console-next/components/nexus/alert-contact-card";
import type { PublicJurisdictionExposure } from "@saas/contracts/nexus";

const exposure = (over: Partial<PublicJurisdictionExposure>): PublicJurisdictionExposure => ({
  jurisdiction: "US-TX",
  jurisdictionName: "Texas",
  status: "clear",
  measuredSalesCents: 100_00,
  measuredTransactions: 4,
  thresholdSalesCents: 500_000_00,
  thresholdTransactions: null,
  fractionOfThreshold: 0.0002,
  periodStart: "2025-08-05T00:00:00.000Z",
  periodEnd: "2026-08-04T00:00:00.000Z",
  measurementBasis: "gross",
  measurementPeriod: "rolling_12m",
  marketplaceTreatment: "exclude",
  thresholdLogic: "sales_only",
  crossedOn: null,
  registrationDueOn: null,
  registrationStatus: null,
  determinationId: "det_1",
  evaluatedAt: "2026-08-04T00:00:00.000Z",
  ruleSetVersion: "2026.08.01",
  ruleSetVerified: true,
  locked: false,
  ...over,
});

describe("formatCents", () => {
  it("renders integer cents without ever building a float", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(99)).toBe("$0.99");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
  });

  it("renders a refund as negative, not as a smaller positive", () => {
    expect(formatCents(-4599)).toBe("−$45.99");
  });

  // The classic float bug: 0.1 + 0.2 style drift shows up as a cent that
  // rounds the wrong way. Cents-in/string-out cannot drift, and this is the
  // value that would expose it if the implementation ever changed.
  it("is exact at values a float round-trip would corrupt", () => {
    expect(formatCents(1_000_000_000_05)).toBe("$1,000,000,000.05");
    expect(formatCents(8_070)).toBe("$80.70");
  });

  it("prefixes a non-USD currency rather than assuming a dollar sign", () => {
    expect(formatCents(1234, "EUR")).toBe("EUR 12.34");
  });
});

describe("formatCentsCompact", () => {
  it("compacts thousands and millions", () => {
    expect(formatCentsCompact(512_300_00)).toBe("$512.3k");
    expect(formatCentsCompact(1_200_000_00)).toBe("$1.2M");
    expect(formatCentsCompact(999_00)).toBe("$999");
  });
});

describe("meterPercent — null is not zero", () => {
  // THE rule. A jurisdiction with no threshold and a jurisdiction never
  // evaluated must both refuse to produce a number, because 0% is the claim
  // "measured, and nowhere near the line".
  it("returns null when there is no threshold to be a fraction of", () => {
    expect(meterPercent(null)).toBeNull();
  });

  it("returns null rather than NaN for a non-finite fraction", () => {
    expect(meterPercent(Number.NaN)).toBeNull();
    expect(meterPercent(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("distinguishes null from a genuine zero measurement", () => {
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(0)).not.toBeNull();
  });

  it("does NOT clamp the label — 340% reads as 340%", () => {
    expect(meterPercent(3.4)).toBeCloseTo(340);
  });

  it("clamps only the bar width", () => {
    expect(meterWidth(3.4)).toBe(100);
    expect(meterWidth(0.5)).toBe(50);
    expect(meterWidth(null)).toBe(0);
  });
});

describe("presentStatus — no_obligation is not clear", () => {
  it("gives no_obligation its own label and tone", () => {
    const none = presentStatus("no_obligation");
    const clear = presentStatus("clear");
    expect(none.label).toBe("Out of scope");
    expect(none.label).not.toBe(clear.label);
    expect(none.tone).not.toBe(clear.tone);
  });

  it("says there is no threshold, not that the seller is below one", () => {
    expect(presentStatus("no_obligation").description).toMatch(/no economic-nexus threshold/i);
    expect(presentStatus("clear").description).toMatch(/below/i);
  });

  // R1: the copy describes a measurement, never a legal conclusion. A status
  // sentence that said "you owe tax" or "you must register" would be advice.
  it("never states a legal conclusion", () => {
    const forbidden = /\byou owe\b|\bmust register\b|\brequired to (register|file|collect)\b|\btax liability\b/i;
    for (const status of ["no_obligation", "clear", "approaching", "crossed", "registered"] as const) {
      expect(presentStatus(status).description).not.toMatch(forbidden);
    }
  });

  it("maps every status to a distinct label", () => {
    const labels = (["no_obligation", "clear", "approaching", "crossed", "registered"] as const).map(
      (s) => presentStatus(s).label,
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("toneVariant", () => {
  it("routes danger to the destructive badge and muted to outline", () => {
    expect(toneVariant("danger")).toBe("destructive");
    expect(toneVariant("muted")).toBe("outline");
    expect(toneVariant("success")).toBe("success");
    expect(toneVariant("warning")).toBe("warning");
    expect(toneVariant("neutral")).toBe("secondary");
  });

  // `no_obligation` and `clear` must not collapse to the same badge either.
  it("keeps out-of-scope visually distinct from clear", () => {
    expect(toneVariant(presentStatus("no_obligation").tone)).not.toBe(
      toneVariant(presentStatus("clear").tone),
    );
  });
});

describe("sortExposure", () => {
  it("puts what needs attention first", () => {
    const rows = [
      exposure({ jurisdiction: "US-CA", status: "clear" }),
      exposure({ jurisdiction: "US-NH", status: "no_obligation" }),
      exposure({ jurisdiction: "US-TX", status: "crossed", fractionOfThreshold: 1.4 }),
      exposure({ jurisdiction: "US-WA", status: "approaching", fractionOfThreshold: 0.9 }),
      exposure({ jurisdiction: "US-NY", status: "registered" }),
    ];
    expect(sortExposure(rows).map((r) => r.jurisdiction)).toEqual([
      "US-TX",
      "US-WA",
      "US-NY",
      "US-CA",
      "US-NH",
    ]);
  });

  it("within a status, ranks the closest to its line first", () => {
    const rows = [
      exposure({ jurisdiction: "US-A", jurisdictionName: "A", status: "approaching", fractionOfThreshold: 0.82 }),
      exposure({ jurisdiction: "US-B", jurisdictionName: "B", status: "approaching", fractionOfThreshold: 0.97 }),
    ];
    expect(sortExposure(rows).map((r) => r.jurisdiction)).toEqual(["US-B", "US-A"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      exposure({ jurisdiction: "US-CA", status: "clear" }),
      exposure({ jurisdiction: "US-TX", status: "crossed" }),
    ];
    sortExposure(rows);
    expect(rows[0]!.jurisdiction).toBe("US-CA");
  });
});

describe("summarizeExposure", () => {
  it("counts out-of-scope separately from clear", () => {
    const totals = summarizeExposure([
      exposure({ status: "clear" }),
      exposure({ status: "clear" }),
      exposure({ status: "no_obligation" }),
      exposure({ status: "crossed" }),
    ]);
    expect(totals).toEqual({ crossed: 1, approaching: 0, registered: 0, clear: 2, outOfScope: 1 });
  });
});

describe("rule copy", () => {
  it("names the basis and the period a reader would recognise", () => {
    expect(describeBasis("gross")).toBe("gross sales");
    expect(describePeriod("rolling_12m")).toMatch(/trailing twelve months/);
    expect(describePeriod("previous_calendar_year")).toMatch(/previous calendar year/);
  });

  it("states marketplace treatment in both directions", () => {
    expect(describeMarketplace("include")).toMatch(/count toward/);
    expect(describeMarketplace("exclude")).toMatch(/excluded from/);
  });

  it("spells out `either` as a disjunction and `both` as a conjunction", () => {
    const either = describeLogic("either", 100_000_00, 200);
    expect(either).toContain("OR");
    expect(either).toMatch(/whichever comes first/);

    const both = describeLogic("both", 100_000_00, 200);
    expect(both).toContain("AND");
    expect(both).toMatch(/only when BOTH/i);
  });

  it("describes `none` as an absence of threshold, not a zero threshold", () => {
    expect(describeLogic("none", null, null)).toMatch(/no economic-nexus threshold/i);
    expect(describeLogic("none", null, null)).not.toMatch(/\$0/);
  });
});

describe("describeWindow", () => {
  // `periodEnd` is exclusive. Rendering it as the last measured day is an
  // off-by-one in the *evidence*, which is worse than an off-by-one in a chart.
  it("labels the end as exclusive", () => {
    expect(describeWindow("2025-08-05T00:00:00Z", "2026-08-05T00:00:00Z")).toBe(
      "2025-08-05 → 2026-08-05 (up to, not including)",
    );
  });

  it("says so plainly when there is no window", () => {
    expect(describeWindow("", "")).toBe("Not yet evaluated");
  });
});

describe("formatDate", () => {
  it("slices the ISO date without a timezone shift", () => {
    // A Date round-trip here would render 2025-12-31 in a western timezone.
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("2026-01-01");
  });

  it("renders an absent date as an em dash, not as today", () => {
    expect(formatDate(null)).toBe("—");
  });
});

describe("the §11 gate, presentation half", () => {
  it("warns exactly when the rule set is unverified", () => {
    expect(shouldWarnUnverified(false)).toBe(true);
    expect(shouldWarnUnverified(true)).toBe(false);
  });

  it("names the version and says no alerts are being sent", () => {
    const notice = unverifiedNotice("2026.08.01");
    expect(notice.body).toContain("2026.08.01");
    expect(notice.body).toMatch(/internal review only/i);
    expect(notice.body).toMatch(/no alerts/i);
    expect(notice.body).toMatch(/not a compliance determination/i);
  });
});

describe("jurisdiction attribution", () => {
  // R4: a weak attribution is labelled as one rather than laundered into a
  // fact. Both fallbacks must carry the word.
  it("marks the fallbacks as fallbacks", () => {
    expect(describeJurisdictionSource("shipping_address")).toBe("Ship-to address");
    expect(describeJurisdictionSource("billing_address")).toMatch(/fallback/i);
    expect(describeJurisdictionSource("tax_lines")).toMatch(/fallback/i);
    expect(describeJurisdictionSource("declared")).not.toMatch(/fallback/i);
  });
});

describe("isReversal", () => {
  it("is true only for a refund that names the row it reverses", () => {
    expect(isReversal({ kind: "refund", reversesEventId: "sev_1" })).toBe(true);
    expect(isReversal({ kind: "refund", reversesEventId: null })).toBe(false);
    expect(isReversal({ kind: "sale", reversesEventId: "sev_1" })).toBe(false);
  });
});

describe("presentChannel", () => {
  // Design §12: a channel mid-backfill serving a partial ledger must not read
  // as connected. This is the assertion that stops that regression.
  it("never reads a backfilling channel as connected", () => {
    const mid = presentChannel({
      status: "backfilling",
      backfillCompletedAt: null,
      lastEventAt: "2026-08-01T00:00:00Z",
    });
    expect(mid.label).toBe("Backfilling");
    expect(mid.label).not.toBe("Connected");
    expect(mid.detail).toMatch(/incomplete/i);
  });

  it("reads a finished channel as connected", () => {
    expect(
      presentChannel({
        status: "connected",
        backfillCompletedAt: "2026-08-02T00:00:00Z",
        lastEventAt: "2026-08-03T00:00:00Z",
      }).label,
    ).toBe("Connected");
  });

  // R3: absence of data is indistinguishable from absence of sales, so the
  // copy must name the ambiguity instead of resolving it.
  it("says a quiet channel may be stalled rather than asserting it is quiet", () => {
    const quiet = presentChannel({
      status: "degraded",
      backfillCompletedAt: "2026-07-01T00:00:00Z",
      lastEventAt: "2026-07-02T00:00:00Z",
    });
    expect(quiet.detail).toMatch(/may be a stalled connection/i);
  });

  it("says a revoked channel leaves the ledger alone", () => {
    const revoked = presentChannel({
      status: "revoked",
      backfillCompletedAt: "2026-07-01T00:00:00Z",
      lastEventAt: null,
    });
    expect(revoked.detail).toMatch(/unaffected/i);
  });
});

describe("presentDelivery", () => {
  it("separates a queued delivery from one that is retrying", () => {
    expect(presentDelivery({ status: "received", attempts: 0 }).label).toBe("Queued");
    expect(presentDelivery({ status: "received", attempts: 3 }).label).toBe("Retrying");
  });

  it("marks a terminal failure as danger", () => {
    expect(presentDelivery({ status: "failed", attempts: 5 }).tone).toBe("danger");
  });
});

describe("describeBackfill", () => {
  // Deliberately not a percentage: the cursor is a provider-opaque page token,
  // so any number would be invented. The assertion pins the absence.
  it("reports no percentage while a backfill is running", () => {
    const running = describeBackfill({
      backfillStartedAt: "2026-08-01T00:00:00Z",
      backfillCompletedAt: null,
      lookbackFloor: "2023-08-01",
    });
    expect(running.done).toBe(false);
    expect(running.detail).not.toMatch(/\d+%/);
    expect(running.detail).toContain("2023-08-01");
  });

  it("explains that live capture already covers the seam", () => {
    const running = describeBackfill({
      backfillStartedAt: "2026-08-01T00:00:00Z",
      backfillCompletedAt: null,
      lookbackFloor: "2023-08-01",
    });
    expect(running.detail).toMatch(/nothing\s+is missed/i);
    expect(running.detail).toMatch(/incomplete until/i);
  });

  it("reports completion with the floor it reached", () => {
    const done = describeBackfill({
      backfillStartedAt: "2026-08-01T00:00:00Z",
      backfillCompletedAt: "2026-08-02T00:00:00Z",
      lookbackFloor: "2023-08-01",
    });
    expect(done.done).toBe(true);
    expect(done.detail).toContain("2023-08-01");
  });
});

// ── R10: where alerts go ─────────────────────────────────────

describe("alertContactState — three states, not two", () => {
  it("reads a configured contact", () => {
    expect(
      alertContactState({
        contact: { email: "finance@acme.test", label: "Bookkeeper", updatedAt: "2026-08-01T00:00:00Z" },
        hasEnvironmentFallback: false,
      }),
    ).toEqual({ kind: "configured", email: "finance@acme.test", label: "Bookkeeper" });
  });

  // The state a two-way read would get wrong. A seller with no contact but a
  // deployment-level default IS receiving alerts — somewhere they did not
  // choose. "No recipient" would be a lie and silence would be worse.
  it("distinguishes an environment fallback from nothing at all", () => {
    expect(alertContactState({ contact: null, hasEnvironmentFallback: true })).toEqual({
      kind: "environment-fallback",
    });
    expect(alertContactState({ contact: null, hasEnvironmentFallback: false })).toEqual({
      kind: "none",
    });
  });
});

describe("presentAlertContact", () => {
  it("is loudest when nobody is being told", () => {
    const none = presentAlertContact({ kind: "none" });
    expect(none.tone).toBe("danger");
    expect(none.headline).toMatch(/no one is being told/i);
    // And it must not imply measurement stopped — it did not.
    expect(none.detail).toMatch(/still measured and recorded/i);
  });

  it("says the fallback address was not the seller's choice", () => {
    const fallback = presentAlertContact({ kind: "environment-fallback" });
    expect(fallback.tone).toBe("warning");
    expect(fallback.headline).toMatch(/did not choose/i);
  });

  it("names the address when one is set, and promises no digest", () => {
    const set = presentAlertContact({
      kind: "configured",
      email: "finance@acme.test",
      label: null,
    });
    expect(set.tone).toBe("success");
    expect(set.headline).toContain("finance@acme.test");
    expect(set.detail).toMatch(/never a digest, never a repeat/i);
  });

  it("gives the three states three distinct tones", () => {
    const tones = [
      presentAlertContact({ kind: "configured", email: "a@b.c", label: null }).tone,
      presentAlertContact({ kind: "environment-fallback" }).tone,
      presentAlertContact({ kind: "none" }).tone,
    ];
    expect(new Set(tones).size).toBe(3);
  });
});
