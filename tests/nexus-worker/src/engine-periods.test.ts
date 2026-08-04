// Measurement windows — design §5.3 cases 1, 2, and 4.

import {
  calendarYearWindow,
  groupByWindow,
  previousCalendarYearWindow,
  rollingWindow,
  windowFor,
} from "@nexus-worker/engine/periods";
import { dateInZone, startOfDayInZone } from "@nexus-worker/engine/zones";
import { addDays, addMonths, endOfMonth } from "@nexus-worker/engine/dates";

const CHICAGO = "America/Chicago";
const LA = "America/Los_Angeles";
const NY = "America/New_York";

describe("§5.3 case 1 — the rolling window is half-open", () => {
  // A window that includes its end date double-counts the boundary day when
  // two consecutive evaluations run, and `BETWEEN` is how that happens.
  const asOf = new Date("2026-08-04T12:00:00.000Z");

  it("ends the day after asOf, exclusive", () => {
    const w = rollingWindow(asOf, CHICAGO);
    expect(w.endDate).toBe("2026-08-05");
    // endDate is the first day NOT measured, so today IS measured.
    expect(addDays(w.endDate, -1)).toBe(dateInZone(asOf, CHICAGO));
  });

  it("spans exactly twelve months of days, ending today inclusive", () => {
    const w = rollingWindow(asOf, CHICAGO);
    expect(w.startDate).toBe("2025-08-05");
    // start = (today − 12 months) + 1 day
    expect(w.startDate).toBe(addDays(addMonths("2026-08-04", -12), 1));
  });

  it("places the boundary instants at local midnight, not UTC midnight", () => {
    const w = rollingWindow(asOf, CHICAGO);
    // Chicago in August is UTC−5, so local midnight is 05:00Z. A window that
    // started at 00:00Z would silently include five hours of the prior day.
    expect(w.start).toBe("2025-08-05T05:00:00.000Z");
    expect(w.end).toBe("2026-08-05T05:00:00.000Z");
  });

  it("clamps a month-end start rather than overflowing into the next month", () => {
    // 2024-02-29 − 12 months is 2023-02-28 (2023 has no 29 Feb), not
    // 2023-03-01. The naive setMonth implementation overflows, which moves a
    // window by a day or two a couple of times a year and raises no error.
    const leapDay = startOfDayInZone("2024-02-29", CHICAGO);
    const w = rollingWindow(leapDay, CHICAGO);
    expect(w.startDate).toBe("2023-03-01"); // 2023-02-28 clamped, then +1 day
    expect(w.endDate).toBe("2024-03-01");
  });

  it("survives a DST spring-forward inside the window", () => {
    // 2026-03-08 is the US spring-forward. Local midnight still exists (the
    // transition is at 02:00), so both boundaries resolve cleanly.
    const w = rollingWindow(startOfDayInZone("2026-03-08", CHICAGO), CHICAGO);
    expect(w.startDate).toBe("2025-03-09");
    expect(new Date(w.end).getTime()).toBeGreaterThan(new Date(w.start).getTime());
  });
});

describe("§5.3 case 2 — previous calendar year is discontinuous, and that is correct", () => {
  it("measures the whole prior year", () => {
    const w = previousCalendarYearWindow(new Date("2026-06-15T00:00:00.000Z"), NY);
    expect(w.startDate).toBe("2025-01-01");
    expect(w.endDate).toBe("2026-01-01");
  });

  it("jumps a whole year across the New Year boundary", () => {
    // 31 Dec 2026 23:59 local → the 2025 window.
    // 1 Jan 2027 00:01 local → the 2026 window.
    // A seller's measured basis changes overnight. States that use this basis
    // genuinely do reset, and smoothing it would report something no state
    // asked for.
    const lastMoment = new Date(startOfDayInZone("2027-01-01", NY).getTime() - 60_000);
    const firstMoment = new Date(startOfDayInZone("2027-01-01", NY).getTime() + 60_000);

    expect(previousCalendarYearWindow(lastMoment, NY).startDate).toBe("2025-01-01");
    expect(previousCalendarYearWindow(firstMoment, NY).startDate).toBe("2026-01-01");
  });

  it("does not overlap the current-year window", () => {
    const asOf = new Date("2026-06-15T00:00:00.000Z");
    const prev = previousCalendarYearWindow(asOf, NY);
    const curr = calendarYearWindow(asOf, NY);
    // Half-open windows abut exactly: prev.end === curr.start, no gap, no
    // double-count.
    expect(prev.end).toBe(curr.start);
  });
});

describe("§5.3 case 4 — UTC storage vs the jurisdiction's date", () => {
  it("keeps a 31 Dec 23:00 PST sale in the year it was made", () => {
    // The scenario from the design doc verbatim. 2025-12-31T23:00 PST is
    // 2026-01-01T07:00Z. Stored UTC, the row's date is 1 January; measured in
    // the jurisdiction's calendar it is 31 December, and it must count toward
    // 2025.
    const sale = new Date("2026-01-01T07:00:00.000Z");
    expect(dateInZone(sale, LA)).toBe("2025-12-31");
    expect(dateInZone(sale, "UTC")).toBe("2026-01-01");

    const w2025 = calendarYearWindow(startOfDayInZone("2025-06-01", LA), LA);
    const t = sale.getTime();
    expect(t).toBeGreaterThanOrEqual(new Date(w2025.start).getTime());
    expect(t).toBeLessThan(new Date(w2025.end).getTime());
  });

  it("excludes that same sale from the 2026 window", () => {
    const sale = new Date("2026-01-01T07:00:00.000Z");
    const w2026 = calendarYearWindow(startOfDayInZone("2026-06-01", LA), LA);
    expect(sale.getTime()).toBeLessThan(new Date(w2026.start).getTime());
  });

  it("puts the same instant in different years for different jurisdictions", () => {
    // This is the whole reason measurement_timezone lives on the rule: one
    // order, two states, two measurement years, both correct.
    const sale = new Date("2026-01-01T04:30:00.000Z");
    expect(dateInZone(sale, NY)).toBe("2025-12-31"); // UTC−5
    expect(dateInZone(sale, "Europe/London")).toBe("2026-01-01"); // UTC+0
  });
});

describe("windowFor dispatch", () => {
  const asOf = new Date("2026-08-04T12:00:00.000Z");

  it.each([
    ["rolling_12m", "2025-08-05", "2026-08-05"],
    ["calendar_year", "2026-01-01", "2027-01-01"],
    ["previous_calendar_year", "2025-01-01", "2026-01-01"],
  ] as const)("%s spans %s → %s", (period, startDate, endDate) => {
    const w = windowFor(period, asOf, CHICAGO);
    expect({ startDate: w.startDate, endDate: w.endDate }).toEqual({ startDate, endDate });
  });

  it("rejects an unknown time zone loudly rather than defaulting to UTC", () => {
    // Silently measuring in UTC is precisely the R7 failure. Fail at the
    // boundary instead.
    expect(() => windowFor("calendar_year", asOf, "Mars/Olympus_Mons")).toThrow(
      /Unknown IANA time zone/,
    );
  });
});

describe("§5.2 — one query per window, never one per jurisdiction", () => {
  const asOf = new Date("2026-08-04T12:00:00.000Z");

  it("collapses forty-eight jurisdictions into a handful of windows", () => {
    const rules = [
      { code: "US-TX", measurementPeriod: "rolling_12m", measurementTimezone: CHICAGO },
      { code: "US-CA", measurementPeriod: "rolling_12m", measurementTimezone: LA },
      { code: "US-WA", measurementPeriod: "rolling_12m", measurementTimezone: LA },
      { code: "US-NY", measurementPeriod: "calendar_year", measurementTimezone: NY },
      { code: "US-FL", measurementPeriod: "calendar_year", measurementTimezone: NY },
      { code: "US-IL", measurementPeriod: "previous_calendar_year", measurementTimezone: CHICAGO },
    ] as const;

    const groups = groupByWindow(rules, asOf);
    // Six jurisdictions, four distinct windows — CA and WA share, NY and FL
    // share. A per-jurisdiction loop would have issued six.
    expect(groups).toHaveLength(4);
    expect(groups.flatMap((g) => g.rules)).toHaveLength(6);
  });

  it("groups deterministically, so a replay issues the same queries in order", () => {
    const rules = [
      { code: "US-NY", measurementPeriod: "calendar_year", measurementTimezone: NY },
      { code: "US-TX", measurementPeriod: "rolling_12m", measurementTimezone: CHICAGO },
    ] as const;
    const first = groupByWindow(rules, asOf).map((g) => g.key);
    const second = groupByWindow([...rules].reverse(), asOf).map((g) => g.key);
    expect(first).toEqual(second);
  });
});

describe("civil-date arithmetic", () => {
  it.each([
    ["addDays across a month end", addDays("2026-01-31", 1), "2026-02-01"],
    ["addDays across a year end", addDays("2026-12-31", 1), "2027-01-01"],
    ["addDays backwards", addDays("2026-03-01", -1), "2026-02-28"],
    ["addDays into a leap day", addDays("2024-02-28", 1), "2024-02-29"],
    ["addMonths clamps 31 Jan → Feb", addMonths("2026-01-31", 1), "2026-02-28"],
    ["addMonths clamps in a leap year", addMonths("2024-01-31", 1), "2024-02-29"],
    ["addMonths across a year", addMonths("2026-11-15", 3), "2027-02-15"],
    ["endOfMonth in February", endOfMonth("2026-02-10"), "2026-02-28"],
    ["endOfMonth in a leap February", endOfMonth("2024-02-10"), "2024-02-29"],
  ])("%s", (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
