// Jurisdiction codes and their display names.
//
// Two things live here and nowhere else:
//
//   1. **Which jurisdictions the evaluator acts on.** International VAT/GST
//      rows are carried in the same `nexus.rules` table by design §3.3 and are
//      **display-only** in v1 — stored, versioned, and shown, but never
//      evaluated into a determination or an alert. Nothing in the schema
//      distinguishes them; this filter does, in one place, which is what makes
//      the scope boundary enforceable rather than aspirational.
//   2. **Display names.** A board that says `US-TX` to a merchant is a
//      database view, not a product.

/** `US-XX` — a US state or DC. Everything else is international. */
const US_JURISDICTION_RE = /^US-[A-Z]{2}$/;

/** True when this jurisdiction is in scope for *evaluation* (design §3.3). */
export function isEvaluable(jurisdiction: string): boolean {
  return US_JURISDICTION_RE.test(jurisdiction);
}

const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const COUNTRY_NAMES: Record<string, string> = {
  GB: "United Kingdom", DE: "Germany", FR: "France", IE: "Ireland",
  NL: "Netherlands", ES: "Spain", IT: "Italy", CA: "Canada", AU: "Australia",
  NZ: "New Zealand", JP: "Japan", SG: "Singapore", NO: "Norway", CH: "Switzerland",
};

/** A human name for a jurisdiction code, falling back to the code itself. */
export function jurisdictionName(jurisdiction: string): string {
  if (US_JURISDICTION_RE.test(jurisdiction)) {
    return US_STATE_NAMES[jurisdiction.slice(3)] ?? jurisdiction;
  }
  return COUNTRY_NAMES[jurisdiction] ?? jurisdiction;
}

/** Accepts `US-TX` and `GB`; rejects anything else, so a typo is a 404 rather
 *  than an empty board card. */
export function isKnownJurisdictionCode(value: string): boolean {
  if (US_JURISDICTION_RE.test(value)) return value.slice(3) in US_STATE_NAMES;
  return /^[A-Z]{2}$/.test(value);
}
