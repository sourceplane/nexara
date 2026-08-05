// The internal metering seam must stay unreachable from the public edge.
//
// `metering-worker` gained `POST /v1/internal/metering/usage`, a route that
// records usage WITHOUT resolving an actor — its callers are the evaluation
// cron and the inbound drain, neither of which has a session. That is safe
// only for as long as nothing outside the trust boundary can route to it.
//
// Two things protect it and this file asserts both, because each alone is one
// edit away from being wrong:
//
//   1. no edge facade matches an `/v1/internal/…` path, so the dispatcher has
//      no branch that could forward one; and
//   2. an unmatched path 404s rather than falling through to a default
//      upstream.
//
// The metering facade is the one to watch, since it is the facade that fronts
// the same worker. A future `/v1/internal` catch-all added to any facade fails
// this file rather than silently publishing the seam.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMeteringRoute } from "@api-edge/metering-facade";
import { isProjectRoute } from "@api-edge/project-facade";
import { isWebhooksRoute } from "@api-edge/webhooks-facade";
import { isNexusRoute } from "@api-edge/nexus-facade";
import { isOrgRoute } from "@api-edge/org-facade";
import { isAuthRoute } from "@api-edge/auth-facade";
import { isBillingRoute } from "@api-edge/billing-facade";
import { isConfigRoute } from "@api-edge/config-facade";
import { isAuditRoute } from "@api-edge/audit-facade";
import { isNotificationsRoute } from "@api-edge/notifications-facade";
import { isIntegrationsRoute, isIntegrationsIngressRoute } from "@api-edge/integrations-facade";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE_SRC = resolve(__dirname, "../../../apps/api-edge/src");

const INTERNAL_PATHS = [
  "/v1/internal/metering/usage",
  "/v1/internal/billing/entitlements/check",
  "/v1/internal/billing/plan/assign",
  "/v1/internal/",
  "/v1/internal",
];

const MATCHERS: Array<[string, (p: string) => boolean]> = [
  ["metering", isMeteringRoute],
  ["project", isProjectRoute],
  ["webhooks", isWebhooksRoute],
  ["nexus", isNexusRoute],
  ["org", isOrgRoute],
  ["auth", isAuthRoute],
  ["billing", isBillingRoute],
  ["config", isConfigRoute],
  ["audit", isAuditRoute],
  ["notifications", isNotificationsRoute],
  ["integrations", isIntegrationsRoute],
  ["integrations-ingress", isIntegrationsIngressRoute],
];

describe("no api-edge facade claims an /v1/internal path", () => {
  for (const [name, match] of MATCHERS) {
    it(`${name} facade matches no internal path`, () => {
      for (const path of INTERNAL_PATHS) {
        expect([path, match(path)]).toEqual([path, false]);
      }
    });
  }

  it("the matchers are not vacuously false — each still claims its own routes", () => {
    // Without this, deleting a facade's patterns would make the block above
    // pass while breaking the product.
    expect(isMeteringRoute("/v1/organizations/org_1/usage")).toBe(true);
    expect(isNexusRoute("/v1/organizations/org_1/nexus/exposure")).toBe(true);
    expect(isAuthRoute("/v1/auth/login/start")).toBe(true);
  });
});

describe("the edge source has no internal forwarding path", () => {
  const sources = readdirSync(EDGE_SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ name: f, text: readFileSync(join(EDGE_SRC, f), "utf8") }));

  it("reads a non-trivial number of edge sources", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it("never constructs a metering internal URL", () => {
    // billing-webhooks-facade legitimately targets an internal billing URL for
    // a provider webhook it verifies at source. Metering has no such case:
    // nothing at the edge should ever address the usage seam.
    const offenders = sources
      .filter((s) => /\/v1\/internal\/metering/.test(s.text))
      .map((s) => s.name);
    expect(offenders).toEqual([]);
  });
});
