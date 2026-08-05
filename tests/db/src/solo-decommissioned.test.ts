// The Solo (M0) profile is decommissioned. This is the control that keeps it
// that way.
//
// Solo made the product a single-user B2C app: one auto-provisioned, invisible
// personal organization per user, with orgs, members, invitations, API keys,
// projects, metering and webhooks all 404'd at the edge and hidden in the
// console. Nexara is not that product. A seller's tax exposure is worked by a
// finance team and often by an outside accountant, so members and API keys are
// part of the job rather than plumbing to hide — and the metering routes Solo
// suppressed are the ones usage reporting needs.
//
// Removing it was a wide edit across three workers, a console, two wrangler
// templates and a build flag. The failure mode of a wide edit is a survivor:
// one `SOLO_MODE` check left in a branch nobody runs, quietly changing
// behaviour in an environment nobody tests. So the removal is asserted rather
// than assumed.
//
// This lives in `tests/db` because that package already owns the repo-wide
// source scans (`tenancy-scan.test.ts`) and therefore already walks every tree
// this needs to see. It is not about the database.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/** Trees that make up the shipped product. */
const SCANNED_TREES = ["apps", "packages", "tests"];

const SCANNED_EXT = /\.(ts|tsx|mjs|js|jsonc|json)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "build", ".turbo", "coverage"]);

/**
 * `wrangler.jsonc` is RENDERED from `wrangler.template.jsonc` at deploy time
 * and is gitignored. Scanning it would be worse than useless: it does not
 * exist in CI (so the assertion would pass vacuously there) while a stale
 * local render would fail the suite on a developer's machine for a file no
 * commit can contain. The template is the committed artifact and the template
 * is what this scan checks.
 */
const GENERATED_FILES = /(^|\/)wrangler\.jsonc$/;

/**
 * This file necessarily contains the very tokens it bans, so it excludes
 * itself. Nothing else is exempt — an exemption list here would be the same
 * mistake the tenancy scan refuses to make with table names.
 */
const SELF = "tests/db/src/solo-decommissioned.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCANNED_EXT.test(entry)) out.push(full);
  }
  return out;
}

function sourceFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const tree of SCANNED_TREES) {
    for (const full of walk(join(REPO_ROOT, tree))) {
      const rel = relative(REPO_ROOT, full);
      if (rel === SELF) continue;
      if (GENERATED_FILES.test(rel)) continue;
      files.push({ path: rel, text: readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("the Solo (M0) profile is fully decommissioned", () => {
  const files = sourceFiles();

  it("scans a non-trivial number of files (the walk itself is not silently empty)", () => {
    // Without this, a broken path would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(200);
  });

  it("has no SOLO_MODE switch anywhere — source, tests, or wrangler templates", () => {
    const offenders = files
      .filter((f) => /SOLO_MODE/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("has no solo-mode module left to import", () => {
    const offenders = files
      .filter((f) => /["'][^"']*solo-mode(\.js)?["']/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no longer auto-provisions a personal organization on sign-in", () => {
    // The console's `/onboarding` flow is the one path that creates a first
    // org. A second, invisible one racing it at login is what Solo did.
    const offenders = files
      .filter((f) => /ensurePersonalOrg|personalOrgSlug|personalOrgName/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("suppresses no routes at the edge", () => {
    const offenders = files
      .filter((f) => /isSoloSuppressed|isSoloMode|SOLO_SUPPRESSED/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("has no SOLO_MODE var in either committed wrangler template", () => {
    // The rendered wrangler.jsonc is skipped above, so assert the committed
    // source of it directly rather than trusting the skip.
    for (const tpl of ["apps/api-edge", "apps/identity-worker"]) {
      const text = readFileSync(join(REPO_ROOT, tpl, "wrangler.template.jsonc"), "utf8");
      expect(text).not.toContain("SOLO_MODE");
    }
  });

  it("keeps the metering routes Solo used to 404 — usage reporting depends on them", () => {
    const edge = files.find((f) => f.path === "apps/api-edge/src/index.ts");
    expect(edge).toBeDefined();
    expect(edge!.text).toContain("isMeteringRoute");
    // A reinstated suppression branch would sit before the facade dispatch.
    expect(edge!.text).not.toMatch(/notFound\([^)]*\)[^;]*;\s*\}\s*else if \(isAuthRoute/);
  });
});
