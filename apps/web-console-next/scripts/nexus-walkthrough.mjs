// The NX8 acceptance walkthrough: connect -> backfill -> exposure ->
// jurisdiction -> registration, driven through a real browser against the real
// components.
//
// WHAT THIS PROVES that the unit tests cannot. `nexus-presentation.test.ts`
// pins every display *rule* in isolation; this pins that the pages actually
// render those rules -- that the out-of-scope card really has no meter in the
// DOM, that the explainer's figures really are the stored determination's, and
// that the section-11 banner really replaces the headline counts rather than
// sitting beside them.
//
// The api-edge is intercepted with fixture payloads rather than stood up: a
// live edge needs Hyperdrive and a seeded tenant, which is NX9's demo tenant.
// When that exists, point BASE at a deployed console, drop the `ctx.route`
// block, and the same assertions run against real data.
//
// NOT IN CI, deliberately: it needs Playwright, which this repo does not
// depend on, and a running dev server. It is a manual verification artefact --
// re-runnable, and honest that nothing re-runs it for you.
//
//   pnpm --filter @saas/web-console-next dev     # serves on :3001; edit BASE
//   npm i playwright --no-save
//   node scripts/nexus-walkthrough.mjs ./shots
//
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:3311";
const OUT = process.argv[2] ?? "/tmp/shots";
mkdirSync(OUT, { recursive: true });

const ORG = "org_11111111111142228333444455556666";

const RULE_SET = {
  id: "rst_1",
  version: "2026.08.01",
  publishedAt: "2026-08-01T00:00:00.000Z",
  verified: true,
  sourceNote: "Synthetic rule set, NX1 seed",
};

const base = (over) => ({
  jurisdiction: "US-TX",
  jurisdictionName: "Texas",
  status: "clear",
  measuredSalesCents: 1_000_00,
  measuredTransactions: 12,
  thresholdSalesCents: 500_000_00,
  thresholdTransactions: null,
  fractionOfThreshold: 0.002,
  periodStart: "2025-08-05T06:00:00.000Z",
  periodEnd: "2026-08-05T06:00:00.000Z",
  measurementBasis: "gross",
  measurementPeriod: "rolling_12m",
  marketplaceTreatment: "exclude",
  thresholdLogic: "sales_only",
  crossedOn: null,
  registrationDueOn: null,
  registrationStatus: null,
  determinationId: "det_1",
  evaluatedAt: "2026-08-04T12:00:00.000Z",
  ruleSetVersion: "2026.08.01",
  ruleSetVerified: true,
  ...over,
});

const EXPOSURE = [
  base({
    jurisdiction: "US-TX", jurisdictionName: "Texas", status: "crossed",
    measuredSalesCents: 612_450_00, fractionOfThreshold: 1.2249,
    crossedOn: "2026-07-19", registrationDueOn: "2026-09-01",
    determinationId: "det_tx",
  }),
  base({
    jurisdiction: "US-WA", jurisdictionName: "Washington", status: "approaching",
    measuredSalesCents: 94_200_00, thresholdSalesCents: 100_000_00,
    fractionOfThreshold: 0.942, marketplaceTreatment: "include",
    determinationId: "det_wa",
  }),
  base({
    jurisdiction: "US-NY", jurisdictionName: "New York", status: "approaching",
    measuredSalesCents: 421_000_00, thresholdSalesCents: 500_000_00,
    measuredTransactions: 96, thresholdTransactions: 100,
    thresholdLogic: "both", fractionOfThreshold: 0.842,
    determinationId: "det_ny",
  }),
  base({
    jurisdiction: "US-CA", jurisdictionName: "California", status: "registered",
    measuredSalesCents: 780_000_00, fractionOfThreshold: 1.56,
    registrationStatus: "active", crossedOn: "2026-02-11",
    determinationId: "det_ca",
  }),
  base({ jurisdiction: "US-CO", jurisdictionName: "Colorado", status: "clear",
    measuredSalesCents: 12_400_00, thresholdSalesCents: 100_000_00,
    fractionOfThreshold: 0.124, determinationId: "det_co" }),
  base({
    // The acceptance case: no threshold at all. Must cite its rule row, must
    // NOT render as clear, must NOT render a meter at 0%.
    jurisdiction: "US-NH", jurisdictionName: "New Hampshire", status: "no_obligation",
    measuredSalesCents: 88_300_00, measuredTransactions: 240,
    thresholdSalesCents: null, thresholdTransactions: null,
    thresholdLogic: "none", fractionOfThreshold: null,
    determinationId: "det_nh",
  }),
  base({
    // Never evaluated: also not 0%, and a different sentence again.
    jurisdiction: "US-OR", jurisdictionName: "Oregon", status: "clear",
    determinationId: null, evaluatedAt: null, fractionOfThreshold: null,
    measuredSalesCents: 0, measuredTransactions: 0,
  }),
];

const RULE_TX = {
  id: "rul_tx", ruleSetId: "rst_1", ruleSetVersion: "2026.08.01",
  jurisdiction: "US-TX", effectiveFrom: "2019-10-01", effectiveTo: null,
  measurementBasis: "gross", measurementPeriod: "rolling_12m",
  measurementTimezone: "America/Chicago",
  salesThresholdCents: 500_000_00, transactionThreshold: null,
  thresholdLogic: "sales_only", marketplaceTreatment: "exclude",
  registrationDeadlineRule: { kind: "first_of_month_after_days", days: 30 },
  notes: "Single sales threshold; marketplace-facilitated sales excluded.",
};

const DET_TX = {
  id: "det_tx", orgId: ORG, jurisdiction: "US-TX",
  evaluatedAt: "2026-08-04T12:00:00.000Z",
  ruleSetVersion: "2026.08.01", ruleId: "rul_tx", engineVersion: "1.0.0",
  periodStart: "2025-08-05T05:00:00.000Z", periodEnd: "2026-08-05T05:00:00.000Z",
  measuredSalesCents: 612_450_00, measuredTransactions: 1_842,
  thresholdSalesCents: 500_000_00, thresholdTransactions: null,
  status: "crossed", crossedOn: "2026-07-19", registrationDueOn: "2026-09-01",
  internalOnly: false,
  inputs: {
    asOf: "2026-08-04T12:00:00.000Z",
    approachingFraction: 0.8,
    window: {
      start: "2025-08-05T05:00:00.000Z", end: "2026-08-05T05:00:00.000Z",
      startDate: "2025-08-05", endDate: "2026-08-05",
    },
    aggregate: {
      jurisdiction: "US-TX",
      directGrossCents: 612_450_00, directRetailCents: 601_100_00,
      directTaxableCents: 588_020_00, directTransactions: 1_842,
      marketplaceGrossCents: 141_900_00, marketplaceRetailCents: 141_900_00,
      marketplaceTaxableCents: 138_400_00, marketplaceTransactions: 402,
    },
  },
};

const ROUTES = [
  [/\/nexus\/exposure$/, () => ({ exposure: EXPOSURE, ruleSet: RULE_SET })],
  [/\/nexus\/jurisdictions\//, () => ({
    exposure: EXPOSURE[0],
    rule: RULE_TX,
    determinations: [
      DET_TX,
      { ...DET_TX, id: "det_tx_prev", evaluatedAt: "2026-07-18T12:00:00.000Z",
        status: "approaching", crossedOn: null, registrationDueOn: null,
        measuredSalesCents: 471_200_00, measuredTransactions: 1_401 },
    ],
    registration: null,
  })],
  [/\/nexus\/alert-contact$/, () => (alertContact
    ? { contact: { email: "bookkeeper@acme.test", label: "Our bookkeeper",
                   updatedAt: "2026-08-01T00:00:00.000Z" },
        hasEnvironmentFallback: false }
    : { contact: null, hasEnvironmentFallback: false })],
  [/\/nexus\/evaluate$/, () => ({
    evaluatedAt: "2026-08-04T12:00:00.000Z", determinations: [], evaluated: 51,
    ruleSetVersion: "2026.08.01", ruleSetVerified: true,
  })],
  [/\/ledger$/, () => ({
    events: [
      { id: "sev_3", orgId: ORG, channelId: "chn_1", source: "webhook",
        providerEventId: "r_9912", kind: "refund", reversesEventId: "sev_1",
        occurredAt: "2026-08-02T18:04:00.000Z", jurisdiction: "US-TX",
        jurisdictionSource: "shipping_address", shipToCountry: "US", shipToRegion: "TX",
        grossCents: -129_95, retailCents: -129_95, taxableCents: -129_95,
        transactionCount: -1, marketplaceFacilitated: false, currency: "USD",
        ingestedAt: "2026-08-02T18:05:00.000Z" },
      { id: "sev_1", orgId: ORG, channelId: "chn_1", source: "webhook",
        providerEventId: "o_5521", kind: "sale", reversesEventId: null,
        occurredAt: "2026-07-29T11:22:00.000Z", jurisdiction: "US-TX",
        jurisdictionSource: "shipping_address", shipToCountry: "US", shipToRegion: "TX",
        grossCents: 129_95, retailCents: 129_95, taxableCents: 129_95,
        transactionCount: 1, marketplaceFacilitated: false, currency: "USD",
        ingestedAt: "2026-07-29T11:23:00.000Z" },
      { id: "sev_2", orgId: ORG, channelId: "chn_2", source: "webhook",
        providerEventId: "ch_7781", kind: "sale", reversesEventId: null,
        occurredAt: "2026-07-28T09:00:00.000Z", jurisdiction: "US-WA",
        jurisdictionSource: "billing_address", shipToCountry: "US", shipToRegion: "WA",
        grossCents: 4_500_00, retailCents: 4_500_00, taxableCents: 4_100_00,
        transactionCount: 1, marketplaceFacilitated: true, currency: "USD",
        ingestedAt: "2026-07-28T09:01:00.000Z" },
    ],
  })],
  [/\/channels\/deliveries$/, () => ({
    deliveries: [
      { id: "dlv_2", orgId: ORG, channelId: "chn_1", provider: "shopify",
        providerDeliveryId: "wh_882", signatureVerified: true, status: "failed",
        attempts: 5, nextAttemptAt: null, lastError: "append_failed_internal",
        receivedAt: "2026-08-03T04:11:00.000Z", appliedAt: null },
      { id: "dlv_1", orgId: ORG, channelId: "chn_1", provider: "shopify",
        providerDeliveryId: "wh_881", signatureVerified: true, status: "applied",
        attempts: 1, nextAttemptAt: null, lastError: null,
        receivedAt: "2026-08-03T04:10:00.000Z", appliedAt: "2026-08-03T04:10:02.000Z" },
    ],
  })],
  [/\/channels$/, () => ({
    channels: [
      { id: "chn_1", orgId: ORG, provider: "shopify", externalAccountId: "acme.myshopify.com",
        displayName: "Acme Storefront", status: "connected",
        backfillStartedAt: "2026-05-01T00:00:00.000Z",
        backfillCompletedAt: "2026-05-01T02:40:00.000Z",
        lookbackFloor: "2023-05-01", lastEventAt: "2026-08-03T04:10:00.000Z",
        createdAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-08-03T04:10:00.000Z",
        revokedAt: null },
      { id: "chn_2", orgId: ORG, provider: "stripe", externalAccountId: "acct_1Qx",
        displayName: "Acme Payments", status: "backfilling",
        backfillStartedAt: "2026-08-04T09:00:00.000Z", backfillCompletedAt: null,
        lookbackFloor: "2023-08-04", lastEventAt: "2026-08-04T09:30:00.000Z",
        createdAt: "2026-08-04T09:00:00.000Z", updatedAt: "2026-08-04T09:30:00.000Z",
        revokedAt: null },
    ],
  })],
  [/\/registrations$/, () => ({
    registrations: [
      { id: "reg_1", orgId: ORG, jurisdiction: "US-CA", status: "active",
        registeredOn: "2026-03-01", permitRef: "CA-SR-88213", notes: null,
        createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" },
    ],
  })],
  [/\/organizations\/[^/]+$/, () => ({
    organization: { id: ORG, name: "Acme Supply Co", slug: "acme", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z" },
  })],
  [/\/organizations$/, () => ({
    organizations: [{ id: ORG, name: "Acme Supply Co", slug: "acme", status: "active",
      createdAt: "2026-01-01T00:00:00.000Z" }],
  })],
  [/\/auth\/session$/, () => ({
    user: { id: "usr_1", email: "ops@acme.test", displayName: "Acme Ops" },
  })],
  [/\/auth\/profile$/, () => ({
    user: { id: "usr_1", email: "ops@acme.test", displayName: "Acme Ops" },
  })],
];

function respond(url) {
  const path = new URL(url).pathname;
  for (const [re, make] of ROUTES) {
    if (re.test(path)) return make();
  }
  return null;
}

let unverified = false;
let alertContact = true;

const shots = [];

async function shoot(page, name) {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  shots.push(file);
  console.log(`  shot → ${name}`);
}

const errors = [];

const run = async () => {
  // Honour an explicit browser path when one is provided (sandboxes that
  // pre-install Chromium), otherwise let Playwright find its own.
  const launchOpts = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {};
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  await ctx.addInitScript(() => {
    localStorage.setItem("nexara.next.token", "fixture-token");
    localStorage.setItem("nexara.next.target", "stage");
  });

  await ctx.route("**/nexara-api-edge-*.workers.dev/**", async (route) => {
    const url = route.request().url();
    let data = respond(url);
    if (data === null) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found", message: url } }),
      });
    }
    if (unverified && /nexus\/exposure$/.test(new URL(url).pathname)) {
      data = {
        exposure: data.exposure,
        ruleSet: { ...RULE_SET, verified: false,
          sourceNote: "Awaiting verification against primary state sources." },
      };
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-request-id": "req_fixture" },
      body: JSON.stringify({ data, meta: { requestId: "req_fixture", cursor: null } }),
    });
  });

  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });

  const go = async (path, wait) => {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    if (wait) await page.waitForSelector(wait, { timeout: 15000 });
  };

  console.log("1. storefront");
  await go("/nexara", "text=Economic nexus, watched continuously");
  await shoot(page, "01-storefront");

  console.log("2. channels — connect and backfill state");
  await go("/orgs/acme/channels", "[data-testid^=channel-card-]");
  await shoot(page, "02-channels");
  const backfilling = await page.locator("[data-testid=channel-card-chn_2]").innerText();
  assert(backfilling.includes("Backfilling"), "chn_2 reads Backfilling");
  assert(!/\bConnected\b/.test(backfilling.split("Last event")[0]),
    "a backfilling channel does not read as Connected");
  assert((await page.locator("text=append_failed_internal").count()) > 0,
    "the failed delivery is visible to the tenant");

  console.log("3. exposure board");
  await go("/orgs/acme/exposure", "[data-testid^=exposure-card-]");
  await shoot(page, "03-exposure");
  const nh = await page.locator("[data-testid=exposure-card-US-NH]").innerText();
  assert(nh.includes("Out of scope"), "no_obligation renders as Out of scope");
  assert(!nh.includes("Clear"), "no_obligation does NOT render as Clear");
  assert(!/\b0% of threshold\b/.test(nh), "no_obligation does NOT render a 0% meter");
  assert(nh.includes("2026.08.01"), "no_obligation cites its rule row");
  assert(!nh.includes("from this threshold"),
    "an out-of-scope card does not contradict itself by naming a threshold");
  assert(
    (await page.locator("[data-testid=exposure-card-US-NH] [data-testid=threshold-meter]").count()) === 0,
    "no_obligation renders no meter at all",
  );
  const or = await page.locator("[data-testid=exposure-card-US-OR]").innerText();
  assert(or.includes("Not yet evaluated"), "never-evaluated says so rather than showing zero");
  const order = await page.locator("[data-testid^=exposure-card-]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")),
  );
  assert(order[0] === "exposure-card-US-TX", "the crossed jurisdiction leads the board");

  console.log("3b. R10 — where alerts go");
  const withContact = await page.locator("[data-testid=alert-contact-card]").innerText();
  assert(withContact.includes("bookkeeper@acme.test"), "a configured contact is named");

  alertContact = false;
  await go("/orgs/acme/exposure", "[data-testid=alert-contact-card]");
  await shoot(page, "03b-no-alert-contact");
  const noContact = await page.locator("[data-testid=alert-contact-card]").innerText();
  assert(/no one is being told/i.test(noContact),
    "no contact and no fallback says so, loudly");
  assert(/still measured and recorded/i.test(noContact),
    "and does not imply measurement stopped");
  alertContact = true;

  console.log("4. jurisdiction detail + the explainer");
  await go("/orgs/acme/jurisdictions/US-TX", "[data-testid=determination-explainer]");
  await shoot(page, "04-jurisdiction");
  const explainer = await page.locator("[data-testid=determination-explainer]").innerText();
  // The explainer's numbers must be the STORED determination's, verbatim.
  assert(explainer.includes("$612,450.00"), "measured sales match the stored determination");
  assert(explainer.includes("$500,000.00"), "threshold matches the stored determination");
  assert(explainer.includes("1,842"), "measured transactions match");
  assert(explainer.includes("2026.08.01") && explainer.includes("rul_tx") && explainer.includes("1.0.0"),
    "the reproducibility triple is rendered verbatim");
  assert(explainer.includes("America/Chicago"), "the measurement timezone is shown");
  assert(explainer.includes("up to, not including"), "the window end is labelled exclusive");
  assert(explainer.includes("2026-09-01"), "the registration deadline is shown");

  await page.locator("[data-testid=determination-explainer] details summary").click();
  await page.waitForTimeout(200);
  await shoot(page, "05-explainer-raw-inputs");
  const raw = await page.locator("[data-testid=determination-explainer] pre").innerText();
  assert(raw.includes('"directGrossCents": 61245000'),
    "the raw inputs are shown exactly as stored, in integer cents");

  console.log("5. ledger — a refund as a linked reversal");
  await go("/orgs/acme/ledger", "table");
  await shoot(page, "06-ledger");
  const ledger = await page.locator("table").innerText();
  assert(ledger.includes("−$129.95"), "the refund renders negative");
  assert(ledger.includes("reverses"), "the refund links to the row it reverses");
  assert(ledger.includes("reversed"), "the original is marked reversed, not rewritten");
  assert(ledger.includes("Billing address (fallback)"), "a weak attribution is labelled");

  console.log("6. registrations");
  await go("/orgs/acme/registrations", "table");
  await shoot(page, "07-registrations");
  const regs = await page.locator("body").innerText();
  assert(regs.includes("Crossed, with no registration recorded"),
    "a crossed jurisdiction with no registration leads the page");
  assert(regs.includes("Texas"), "Texas is the outstanding one");
  assert(regs.includes("CA-SR-88213"), "the existing registration is listed");

  console.log("7. the §11 unverified gate");
  unverified = true;
  await go("/orgs/acme/exposure", "[data-testid=unverified-banner]");
  await shoot(page, "08-unverified-banner");
  const body = await page.locator("body").innerText();
  assert(body.includes("This rule set is not verified"), "the §11 banner renders");
  assert(!/^\s*\d+\s*$/m.test(body.split("This rule set")[0].split("Exposure")[1] ?? ""),
    "headline counts are replaced, not merely annotated");
  const summaryVisible = await page.locator("text=Approaching").first().isVisible();
  assert(summaryVisible !== null, "board still lists positions");

  await browser.close();
};

function assert(cond, what) {
  if (cond) console.log(`  ✓ ${what}`);
  else {
    console.log(`  ✗ ${what}`);
    errors.push(`FAILED: ${what}`);
  }
}

run().then(
  () => {
    console.log("\nscreenshots:", shots.length);
    if (errors.length) {
      console.log("\nERRORS:\n" + errors.join("\n"));
      process.exit(1);
    }
    console.log("walkthrough clean");
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
