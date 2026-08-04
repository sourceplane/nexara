/**
 * Storefront copy, as data.
 *
 * Dependency-free and separated from the page for one reason that is not
 * tidiness: **marketing copy is where a compliance product lies first.** The
 * claims below are asserted against the epic's own non-goals by a test — no
 * headline may promise to file with a jurisdiction, to give tax advice, or to
 * calculate tax owed, because the product does none of those and says so in
 * design §10.
 *
 * A sentence that survives here has survived that test. That is a cheaper
 * guarantee than a review, and it does not lapse when the reviewer leaves.
 */

export interface Feature {
  title: string;
  body: string;
}

export const HERO = {
  eyebrow: "Economic nexus, watched continuously",
  headline: "Know which states you have crossed — before the letter arrives.",
  subhead:
    "Nexara connects your sales channels, measures your activity against every US state's economic-nexus threshold, and shows the working. Every position is reproducible, timestamped, and explainable to an auditor.",
  primaryCta: { label: "Start free", href: "/login" },
  secondaryCta: { label: "See how a position is proven", href: "#evidence" },
} as const;

export const FEATURES: Feature[] = [
  {
    title: "Connect once, measured hourly",
    body:
      "Stripe and Shopify connect in a click and backfill 36 months of history. Live orders are captured from the moment you connect, so nothing is lost across the seam — and duplicates are rejected by the database, not by a retry policy.",
  },
  {
    title: "Every state's rule, as written",
    body:
      "Sales or transactions or both; gross, retail, or taxable; rolling twelve months or the calendar year; marketplace sales in or out. The rule that applied to you is stored with the answer it produced.",
  },
  {
    title: "The working, not just the answer",
    body:
      "Each position carries the rule-set version, the rule id, the engine version, and the exact inputs it was computed from. Re-run them and you get the same answer — that is asserted on every build, not promised in a brochure.",
  },
  {
    title: "An append-only record",
    body:
      "Refunds are new rows, not edits. A determination taken last quarter still reproduces this quarter, because nothing behind it was ever rewritten.",
  },
  {
    title: "Alerts you will not learn to ignore",
    body:
      "One alert per jurisdiction per crossing, with the registration deadline that jurisdiction's own rule defines. Approaching a line is a separate, quieter signal.",
  },
  {
    title: "Honest about what it does not know",
    body:
      "A channel that stops delivering is flagged, not silently read as a quiet month. A jurisdiction never evaluated says so rather than showing zero. A rule set we have not verified against primary sources shows a banner instead of a status.",
  },
];

/**
 * The non-goals, stated on the storefront rather than buried in a contract.
 *
 * Putting these on the front page is a product decision: the buyers worth
 * having are the ones who need to know the boundary before they sign, and the
 * ones repelled by it were going to be a support problem.
 */
export const NON_GOALS: string[] = [
  "Nexara does not file registrations or returns with any jurisdiction. You file; we tell you when and where.",
  "Nexara does not calculate the tax you owe, and it is not a tax engine at checkout.",
  "Nexara is not tax advice. It is a measurement against a published threshold, with the measurement shown.",
];

export const EVIDENCE_STEPS: Feature[] = [
  {
    title: "1 · The ledger",
    body:
      "Every sale event, with the jurisdiction it was attributed to and how that attribution was made — ship-to address, billing address, or implied by tax lines. A weak attribution is labelled as one.",
  },
  {
    title: "2 · The window",
    body:
      "A half-open range in the jurisdiction's own timezone, so a 31 December evening sale in California lands in the year California would put it in.",
  },
  {
    title: "3 · The rule",
    body:
      "The version in force on the day of the measurement, with its effective dates. A rule that changed mid-window is two measurements, not one average.",
  },
  {
    title: "4 · The determination",
    body:
      "Status, measured value, threshold, crossing date, registration deadline — plus the exact inputs, one click away, exactly as stored.",
  },
];

/**
 * True when a piece of storefront copy makes a claim the product does not
 * support. Used by the storefront test to keep the page honest as it is edited.
 *
 * Deliberately crude: it matches phrasings, not intent, and it will produce a
 * false positive on a sentence that mentions filing in order to disclaim it.
 * The `NON_GOALS` strings are exempt for exactly that reason — they are the
 * disclaimer, and they must be allowed to name the thing they disclaim.
 */
const FORBIDDEN_CLAIMS: RegExp[] = [
  /\bwe file\b/i,
  /\bfiles? (?:your|their) (?:returns?|registrations?)\b/i,
  /\bfiling on your behalf\b/i,
  /\bautomatically registers?\b/i,
  /\btax advice\b/i,
  /\bcalculates? (?:the )?tax (?:you )?owe/i,
  /\bguarantee[sd]? compliance\b/i,
  /\bfully compliant\b/i,
];

export function violatesNonGoals(copy: string): boolean {
  return FORBIDDEN_CLAIMS.some((re) => re.test(copy));
}

/** Every user-visible storefront string, for the honesty test to sweep. */
export function allStorefrontCopy(): string[] {
  return [
    HERO.eyebrow,
    HERO.headline,
    HERO.subhead,
    HERO.primaryCta.label,
    HERO.secondaryCta.label,
    ...FEATURES.flatMap((f) => [f.title, f.body]),
    ...EVIDENCE_STEPS.flatMap((f) => [f.title, f.body]),
  ];
}
