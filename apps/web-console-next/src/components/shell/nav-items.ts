/**
 * Pure navigation model for the sidebar and the mobile nav drawer (Task 0127 /
 * U11). Dependency-free (no React, no icons) so the section/link composition is
 * unit-testable and shared by both `sidebar.tsx` (desktop) and `mobile-nav.tsx`
 * (the Sheet drawer on small screens). Icon resolution happens in the renderer.
 */

export interface NavLink {
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
  /** When true the link opens a nested sidebar panel (renderer shows a ›). */
  subPanel?: boolean;
}

export interface NavSection {
  /** stable id for keys/tests. */
  id: string;
  label: string;
  links: NavLink[];
}

export interface NavScope {
  orgSlug?: string | null;
}

/**
 * Build the sidebar sections for the current URL scope. The org section only
 * appears when a slug is present, matching the URL-driven scope invariant (no
 * local navigation state).
 *
 * The order is the order a seller works: the board first, then the evidence
 * behind it, then the plumbing that feeds it, then what it costs. There is no
 * project scope — Nexara measures an organization's sales against published
 * thresholds, and "projects" was a developer-platform concept inherited from
 * the starter this repo grew out of, with nothing to name in this product.
 */
export function buildNavSections(scope: NavScope): NavSection[] {
  const sections: NavSection[] = [];
  const orgSlug = scope.orgSlug ?? null;
  const orgBase = orgSlug ? `/orgs/${orgSlug}` : null;

  // The Workspace/Organizations section is intentionally omitted: the org
  // switcher at the top of the sidebar is the home for org selection (and links
  // to the full list), so a separate "Organizations" nav row would be redundant.
  //
  // Account (Profile / Security activity) is likewise not a nav section — the
  // signed-in identity lives in the account chip at the bottom of the sidebar.

  if (orgBase) {
    // The primary sidebar is product-focused: the day-to-day surfaces an
    // operator works in. Organization administration (members, billing, API
    // keys, webhooks, config, audit, identity) lives behind a single Settings
    // entry, which opens the dedicated `/settings` surface with its own
    // secondary navigation (see `settings-nav.ts`).
    sections.push({
      id: "org",
      label: orgSlug ? `Org · ${orgSlug}` : "Organization",
      links: [
        { href: `${orgBase}/exposure`, label: "Exposure", icon: "Map" },
        { href: `${orgBase}/registrations`, label: "Registrations", icon: "Stamp" },
        { href: `${orgBase}/ledger`, label: "Ledger", icon: "Receipt" },
        { href: `${orgBase}/channels`, label: "Channels", icon: "Plug" },
        { href: `${orgBase}/usage`, label: "Usage & quota", icon: "Gauge" },
        // Opens the dedicated settings panel — flagged so the renderer shows a ›.
        { href: `${orgBase}/settings`, label: "Settings", icon: "Settings", subPanel: true },
      ],
    });
  }

  return sections;
}

/**
 * Resolve the active link for a pathname: the longest matching `href` prefix
 * wins, so `/orgs/x/jurisdictions/US-TX` highlights the jurisdiction page
 * rather than a parent. `/orgs` (exact) only highlights on exactly `/orgs`.
 */
export function isLinkActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/orgs") return pathname === "/orgs";
  if (href === "/account") return pathname === "/account";
  return pathname === href || pathname.startsWith(`${href}/`);
}
