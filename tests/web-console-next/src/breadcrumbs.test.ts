import { buildBreadcrumbs } from "@web-console-next/components/shell/breadcrumbs";

const org = { orgSlug: "acme", orgName: "Acme Inc" };

describe("buildBreadcrumbs", () => {
  it("starts with the org name linking to the exposure board", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/usage" });
    expect(crumbs[0]).toEqual({ label: "Acme Inc", href: "/orgs/acme/exposure" });
  });

  it("renders the org page itself as a single unlinked crumb", () => {
    expect(buildBreadcrumbs({ ...org, pathname: "/orgs/acme" })).toEqual([{ label: "Acme Inc" }]);
  });

  it("labels known segments and leaves the last crumb unlinked", () => {
    const crumbs = buildBreadcrumbs({ ...org, pathname: "/orgs/acme/settings/members" });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme/exposure" },
      { label: "Settings", href: "/orgs/acme/settings" },
      { label: "Members" },
    ]);
  });

  it("renders a jurisdiction detail page with its code as the current crumb", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/jurisdictions/US-TX",
    });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme/exposure" },
      { label: "Jurisdictions", href: "/orgs/acme/jurisdictions" },
      { label: "US-TX" },
    ]);
  });

  it("labels the product surfaces", () => {
    const labels = (p: string) =>
      buildBreadcrumbs({ ...org, pathname: p }).map((c) => c.label);
    expect(labels("/orgs/acme/exposure")).toContain("Exposure");
    expect(labels("/orgs/acme/ledger")).toContain("Ledger");
    expect(labels("/orgs/acme/channels")).toContain("Channels");
    expect(labels("/orgs/acme/registrations")).toContain("Registrations");
  });

  it("renders nested billing pages with every ancestor linked", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/settings/billing/change-plan",
    });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme/exposure" },
      { label: "Settings", href: "/orgs/acme/settings" },
      { label: "Billing & plan", href: "/orgs/acme/settings/billing" },
      { label: "Change plan" },
    ]);
  });

  it("leaves an unknown dynamic segment unlinked when not last", () => {
    const crumbs = buildBreadcrumbs({
      ...org,
      pathname: "/orgs/acme/settings/webhooks/ep_123",
    });
    expect(crumbs).toEqual([
      { label: "Acme Inc", href: "/orgs/acme/exposure" },
      { label: "Settings", href: "/orgs/acme/settings" },
      { label: "Webhooks", href: "/orgs/acme/settings/webhooks" },
      { label: "ep_123" },
    ]);
  });

  it("falls back to an unlinked org crumb on a foreign pathname", () => {
    expect(buildBreadcrumbs({ ...org, pathname: "/account" })).toEqual([{ label: "Acme Inc" }]);
    expect(buildBreadcrumbs({ ...org, pathname: null })).toEqual([{ label: "Acme Inc" }]);
  });
});
