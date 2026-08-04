// The engine's purity is the premise of every other test in this suite.
//
// Design §4 states the conventions — engine files import only types from
// `@saas/contracts`, never `@saas/db`, never `Env`, never `fetch`, and there is
// no `Date.now()` because `asOf` is always a parameter. Those are claims about
// code made in a document. This file turns them into a control by reading the
// sources.
//
// Why it matters more here than in most codebases: reproducibility is the
// product. An engine that reads a clock, a database, or a network cannot be
// replayed against a two-year-old `inputs` payload, and the determination
// record stops being evidence the moment that is true.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = resolve(__dirname, "../../..", "apps/nexus-worker/src/engine");

const FILES = readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();

/** Source with `//` and block comments stripped — these assertions are about
 *  code, and the comments in the engine discuss the very things being banned. */
function codeOf(file: string): string {
  return readFileSync(resolve(ENGINE_DIR, file), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("engine purity", () => {
  it("has engine files to check", () => {
    // Guards against this whole suite passing vacuously if the directory moves.
    expect(FILES.length).toBeGreaterThanOrEqual(6);
    expect(FILES).toContain("index.ts");
  });

  describe.each(FILES)("%s", (file) => {
    const code = codeOf(file);

    it("imports nothing but types from @saas/contracts", () => {
      const imports = [...code.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)];
      for (const [, typeOnly, specifier] of imports) {
        if (specifier!.startsWith(".")) continue; // sibling engine modules
        expect({ file, specifier, typeOnly: Boolean(typeOnly) }).toEqual({
          file,
          specifier: expect.stringMatching(/^@saas\/contracts/),
          typeOnly: true,
        });
      }
    });

    it("does not reach for the database, the environment, or the network", () => {
      for (const banned of [
        "@saas/db",
        "@saas/notifications-client",
        "fetch(",
        "Env",
        "process.env",
        "crypto.randomUUID",
      ]) {
        expect({ file, banned, present: code.includes(banned) }).toEqual({
          file,
          banned,
          present: false,
        });
      }
    });

    it("reads no clock and no randomness", () => {
      // `new Date(x)` is fine — parsing a supplied instant. `new Date()` with
      // no argument is a clock read and would make replay impossible.
      expect({ file, m: /Date\.now\s*\(/.test(code) }).toEqual({ file, m: false });
      expect({ file, m: /new\s+Date\s*\(\s*\)/.test(code) }).toEqual({ file, m: false });
      expect({ file, m: /Math\.random/.test(code) }).toEqual({ file, m: false });
      expect({ file, m: /performance\.now/.test(code) }).toEqual({ file, m: false });
    });

    it("declares no async function and returns no promise", () => {
      // Every engine function is synchronous. An async one would be a seam
      // through which I/O could later arrive without this test noticing.
      expect({ file, m: /\basync\b/.test(code) }).toEqual({ file, m: false });
      expect({ file, m: /\bawait\b/.test(code) }).toEqual({ file, m: false });
      expect({ file, m: /Promise</.test(code) }).toEqual({ file, m: false });
    });
  });

  it("keeps `asOf` a parameter everywhere it is used", () => {
    // The positive form of the "no clock" rule: every function that needs the
    // current instant takes it.
    const periods = codeOf("periods.ts");
    expect(periods).toMatch(/asOf:\s*Date/);
  });
});
