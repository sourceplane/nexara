// Storefront honesty.
//
// Marketing copy is where a compliance product lies first — not maliciously,
// but because "we handle your sales tax" is shorter and sells better than
// "we measure your activity against a published threshold and show the
// working". Design §10 names three permanent non-goals; this file is what
// stops a future edit from quietly promising past them.
//
// The sweep is crude on purpose. It matches phrasings rather than intent, and
// it exempts the `NON_GOALS` strings — those are the disclaimer, so they must
// be allowed to name the thing they disclaim.

import {
  EVIDENCE_STEPS,
  FEATURES,
  HERO,
  NON_GOALS,
  allStorefrontCopy,
  violatesNonGoals,
} from "@web-console-next/components/nexara/storefront";

describe("storefront copy", () => {
  it("promises nothing the product does not do", () => {
    const offenders = allStorefrontCopy().filter((line) => violatesNonGoals(line));
    expect(offenders).toEqual([]);
  });

  // A guard that cannot fail is not a guard. These are the sentences a
  // well-meaning edit would actually introduce.
  it("catches the claims it exists to catch", () => {
    expect(violatesNonGoals("We file your returns for you.")).toBe(true);
    expect(violatesNonGoals("Get tax advice from our experts.")).toBe(true);
    expect(violatesNonGoals("Nexara guarantees compliance in all 50 states.")).toBe(true);
    expect(violatesNonGoals("It calculates the tax you owe at checkout.")).toBe(true);
    expect(violatesNonGoals("Automatically registers you in new states.")).toBe(true);
  });

  it("does not fire on honest copy", () => {
    expect(violatesNonGoals(HERO.subhead)).toBe(false);
    expect(violatesNonGoals("Shows you when a threshold was crossed, and the working behind it."))
      .toBe(false);
  });

  it("states the non-goals on the page rather than only in a contract", () => {
    expect(NON_GOALS.length).toBeGreaterThanOrEqual(3);
    const all = NON_GOALS.join(" ").toLowerCase();
    expect(all).toMatch(/does not file/);
    expect(all).toMatch(/not tax advice/);
    expect(all).toMatch(/does not calculate/);
  });

  it("keeps the disclaimers exempt from the sweep, or they could not be written", () => {
    // Each non-goal names a forbidden claim in order to deny it. If they were
    // swept, the page could not honestly disclaim anything.
    expect(NON_GOALS.some((n) => violatesNonGoals(n))).toBe(true);
    expect(allStorefrontCopy()).not.toEqual(expect.arrayContaining(NON_GOALS));
  });

  it("has a hero that says what is measured, not what is promised", () => {
    expect(HERO.headline.length).toBeLessThan(120);
    expect(HERO.subhead).toMatch(/threshold/i);
    expect(HERO.primaryCta.href).toBe("/login");
  });

  it("carries the four evidence artefacts in order", () => {
    expect(EVIDENCE_STEPS.map((s) => s.title)).toEqual([
      "1 · The ledger",
      "2 · The window",
      "3 · The rule",
      "4 · The determination",
    ]);
  });

  it("has no empty feature bodies", () => {
    for (const f of FEATURES) {
      expect(f.title.trim().length).toBeGreaterThan(0);
      expect(f.body.trim().length).toBeGreaterThan(20);
    }
  });
});
