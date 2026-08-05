import {
  defaultOrgDestination,
  resolvePostAuthDestination,
} from "@web-console-next/lib/last-org";

describe("defaultOrgDestination", () => {
  // The board, not a settings or admin page. A seller signs in to answer one
  // question, and a landing page that makes them navigate to it has put
  // administration in front of the answer.
  it("routes to the last-used org's exposure board when one is remembered", () => {
    expect(defaultOrgDestination("acme")).toBe("/orgs/acme/exposure");
  });

  it("falls back to onboarding when none is remembered — there is no org-less landing view", () => {
    expect(defaultOrgDestination(null)).toBe("/onboarding");
  });

  // Solo mode is decommissioned: there is no second parameter and no profile
  // that lands anywhere else. Extra args must not change the destination.
  it("takes no profile argument — the destination is unconditional", () => {
    expect(defaultOrgDestination.length).toBe(1);
    expect((defaultOrgDestination as (s: string | null, x?: unknown) => string)("acme", true)).toBe(
      "/orgs/acme/exposure",
    );
  });
});

describe("resolvePostAuthDestination", () => {
  const org = (id: string, slug: string, createdAt: string) => ({ id, slug, createdAt });
  const profile = (lastOrgSlug: string | null) => ({
    getProfile: async () => ({ user: { lastOrgSlug } }),
  });
  const failingProfile = {
    getProfile: async (): Promise<{ user: { lastOrgSlug?: string | null } }> => {
      throw new Error("api-key token");
    },
  };

  it("prefers the server-side last-org preference", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile("acme"),
      organizations: { list: async () => ({ organizations: [] }) },
    });
    expect(dest).toBe("/orgs/acme/exposure");
  });

  it("sends a first sign-in (no orgs) to mandatory onboarding", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile(null),
      organizations: { list: async () => ({ organizations: [] }) },
    });
    expect(dest).toBe("/onboarding");
  });

  it("lands on the account's billing-parent (earliest-created) org when no preference is set", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile(null),
      organizations: {
        list: async () => ({
          organizations: [
            org("org_b", "beta", "2026-02-01T00:00:00Z"),
            org("org_a", "alpha", "2026-01-01T00:00:00Z"),
          ],
        }),
      },
    });
    expect(dest).toBe("/orgs/alpha/exposure");
  });

  it("still resolves via the org list when the profile read fails", async () => {
    const dest = await resolvePostAuthDestination({
      auth: failingProfile,
      organizations: {
        list: async () => ({ organizations: [org("org_a", "alpha", "2026-01-01T00:00:00Z")] }),
      },
    });
    expect(dest).toBe("/orgs/alpha/exposure");
  });

  it("falls back to the local cache (empty here) when every read fails", async () => {
    const dest = await resolvePostAuthDestination({
      auth: failingProfile,
      organizations: {
        list: async () => {
          throw new Error("offline");
        },
      },
    });
    // No window/localStorage in this environment, so the cache is empty and the
    // resolver defers to onboarding — which itself forwards once orgs load.
    expect(dest).toBe("/onboarding");
  });
});
