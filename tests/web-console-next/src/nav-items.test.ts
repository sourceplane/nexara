import { buildNavSections, isLinkActive } from "@web-console-next/components/shell/nav-items";

describe("buildNavSections", () => {
  it("does not render Workspace/Account nav sections (org switcher + account chip own those)", () => {
    const ids = buildNavSections({ orgSlug: "acme" }).map((s) => s.id);
    expect(ids).not.toContain("workspace");
    expect(ids).not.toContain("account");
    const allHrefs = buildNavSections({ orgSlug: "acme" }).flatMap((s) => s.links.map((l) => l.href));
    expect(allHrefs).not.toContain("/orgs"); // Organizations link removed
    expect(allHrefs).not.toContain("/account");
    expect(allHrefs).not.toContain("/account/security");
  });

  it("flags the Settings link as a sub-panel (renderer shows a chevron)", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const settings = org.links.find((l) => l.href === "/orgs/acme/settings")!;
    expect(settings.subPanel).toBe(true);
    const exposure = org.links.find((l) => l.href === "/orgs/acme/exposure")!;
    expect(exposure.subPanel ?? false).toBe(false);
  });

  it("returns no sections when there is no org scope", () => {
    expect(buildNavSections({})).toHaveLength(0);
  });

  it("omits the org section without a slug", () => {
    const ids = buildNavSections({}).map((s) => s.id);
    expect(ids).not.toContain("org");
  });

  // The whole nav, pinned in order. The board leads because it is the product;
  // anything that pushes it down is a regression worth failing a build over.
  it("is the product navigation, in the order a seller works it", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    expect(org.links.map((l) => l.href)).toEqual([
      "/orgs/acme/exposure",
      "/orgs/acme/registrations",
      "/orgs/acme/ledger",
      "/orgs/acme/channels",
      "/orgs/acme/usage",
      "/orgs/acme/settings",
    ]);
    expect(org.label).toBe("Org · acme");
  });

  it("keeps org administration out of the primary sidebar (moved under Settings)", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const hrefs = org.links.map((l) => l.href);
    // These now live behind the dedicated Settings surface.
    expect(hrefs).not.toContain("/orgs/acme/members");
    expect(hrefs).not.toContain("/orgs/acme/billing");
    expect(hrefs).not.toContain("/orgs/acme/webhooks");
  });

  it("keeps the Settings link active across nested settings pages", () => {
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings")).toBe(true);
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings/webhooks")).toBe(true);
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings/members")).toBe(true);
  });

  // "Projects" was a developer-platform concept inherited from the starter this
  // repo grew out of. Nexara measures an organization's sales against published
  // thresholds; there is nothing for a project to name.
  it("never renders a project section or any project link", () => {
    const withProjectScope = buildNavSections({ orgSlug: "acme", projectSlug: "web" });
    expect(withProjectScope.find((s) => s.id === "project")).toBeUndefined();
    const hrefs = withProjectScope.flatMap((s) => s.links.map((l) => l.href));
    expect(hrefs.some((h) => h.includes("/projects"))).toBe(false);
  });
});

describe("isLinkActive", () => {
  it("matches /orgs only exactly (not nested org pages)", () => {
    expect(isLinkActive("/orgs", "/orgs")).toBe(true);
    expect(isLinkActive("/orgs", "/orgs/acme/exposure")).toBe(false);
  });

  it("matches /account exactly so it does not swallow /account/security", () => {
    expect(isLinkActive("/account", "/account")).toBe(true);
    expect(isLinkActive("/account", "/account/security")).toBe(false);
    expect(isLinkActive("/account/security", "/account/security")).toBe(true);
  });

  it("matches a link when the path is the href or a child of it", () => {
    expect(isLinkActive("/orgs/acme/usage", "/orgs/acme/usage")).toBe(true);
    expect(isLinkActive("/orgs/acme/webhooks", "/orgs/acme/webhooks/ep_123")).toBe(true);
  });

  it("does not match sibling prefixes", () => {
    expect(isLinkActive("/orgs/acme/api-keys", "/orgs/acme/api-keys-archive")).toBe(false);
  });

  it("returns false for a null pathname", () => {
    expect(isLinkActive("/orgs", null)).toBe(false);
  });
});
