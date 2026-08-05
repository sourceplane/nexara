// The console is the product's console.
//
// This repo grew out of a developer-platform starter, and the console carried
// its furniture: a project tree with environments and a Git page, a
// "pick a starting point — import from GitHub/GitLab/Bitbucket" step in org
// creation, and plan cards selling "Up to 3 projects". None of it means
// anything to someone measuring sales against state tax thresholds, and all of
// it competed with the thing they came for.
//
// The nav, breadcrumb and command-palette tests already assert that nothing
// *links* to those surfaces. This file asserts the surfaces are *gone* — a
// route that exists but is unlinked is still reachable by URL, still shipped
// in the bundle, and still the first thing a curious user finds.
//
// It lives in `tests/db` rather than `tests/web-console-next` for a mechanical
// reason: the console's test package is deliberately compiled WITHOUT node
// types (see the `declare const process` note that used to sit in its
// solo-mode module), so a filesystem scan cannot typecheck there. `tests/db`
// already owns the repo-wide source scans and has the types. This is not
// about the database.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSOLE_SRC = resolve(__dirname, "../../..", "apps/web-console-next/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FILES = walk(CONSOLE_SRC).map((f) => ({
  path: relative(CONSOLE_SRC, f),
  text: readFileSync(f, "utf8"),
}));

describe("the starter's developer-platform surfaces are gone", () => {
  it("scans a non-trivial number of console files", () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  it("has no project, environment or git route", () => {
    const routes = FILES.filter((f) => f.path.endsWith("page.tsx")).map((f) => f.path);
    const offenders = routes.filter(
      (r) => r.includes("/projects/") || r.includes("/environments") || r.includes("/git/"),
    );
    expect(offenders).toEqual([]);
  });

  it("still has every product route (the scan above is not passing by deleting the app)", () => {
    const routes = FILES.filter((f) => f.path.endsWith("page.tsx")).map((f) => f.path);
    for (const required of ["exposure", "registrations", "ledger", "channels", "jurisdictions"]) {
      expect(routes.some((r) => r.includes(required))).toBe(true);
    }
  });

  it("has no scope switcher or source picker component", () => {
    const offenders = FILES.filter(
      (f) => f.path.includes("scope-switcher") || f.path.includes("source-picker"),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("never navigates to a project URL", () => {
    // A dead link is worse than a missing one: it is a 404 the user reached by
    // following our own suggestion.
    const offenders = FILES.filter((f) => /["'`][^"'`]*\/projects(\/|["'`?])/.test(f.text)).map(
      (f) => f.path,
    );
    expect(offenders).toEqual([]);
  });

  it("sells the plans on what this product does", () => {
    const plans = FILES.find((f) => f.path.endsWith("billing/plan-actions.ts"));
    expect(plans).toBeDefined();
    // The bullets are transcribed from billing-worker's plan catalog; a card
    // promising a limit the catalog does not grant only surfaces after someone
    // has paid.
    expect(plans!.text).toContain("monitored jurisdictions");
    expect(plans!.text).toContain("sales channel");
    expect(plans!.text).not.toContain("Up to 3 projects");
  });
});
