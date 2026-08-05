import {
  PLAN_OPTIONS,
  createButtonLabel,
  flowSteps,
  postCreatePath,
  type PlanOption,
} from "@web-console-next/components/orgs/create-org-model";

const plan = (code: string): PlanOption => {
  const p = PLAN_OPTIONS.find((x) => x.code === code);
  if (!p) throw new Error(`unknown plan ${code}`);
  return p;
};

describe("flowSteps", () => {
  it("gives a parent (first) org the plan step", () => {
    expect(flowSteps("parent").map((s) => s.id)).toEqual(["details", "plan", "review"]);
  });

  // A child org inherits its parent's plan through the MO3 entitlement
  // fan-out, so it has nothing to choose. The step it used to have asked the
  // user to import a Git repository — a developer-platform question this
  // product has no reason to ask a seller.
  it("gives a child (additional) org details and review only", () => {
    expect(flowSteps("child").map((s) => s.id)).toEqual(["details", "review"]);
  });

  it("offers no starting-point step in either mode", () => {
    for (const mode of ["parent", "child"] as const) {
      expect(flowSteps(mode).map((s) => s.id)).not.toContain("source");
    }
  });
});

describe("PLAN_OPTIONS", () => {
  it("starts on Free and ends on the contact-sales tier", () => {
    expect(PLAN_OPTIONS[0]?.code).toBe("free");
    expect(PLAN_OPTIONS[PLAN_OPTIONS.length - 1]?.contact).toBe(true);
  });

  it("only the contact-sales tier skips self-serve checkout", () => {
    expect(PLAN_OPTIONS.filter((p) => p.contact).map((p) => p.code)).toEqual(["enterprise"]);
  });

  it("describes the plans in the product's terms, not the starter's", () => {
    const copy = PLAN_OPTIONS.map((p) => p.tagline).join(" ").toLowerCase();
    expect(copy).not.toContain("project");
    expect(copy).not.toContain("ship");
  });
});

describe("createButtonLabel", () => {
  it("names the hand-off the create triggers", () => {
    expect(createButtonLabel("parent", plan("free"))).toBe("Create organization");
    expect(createButtonLabel("parent", plan("pro"))).toBe("Create & continue to checkout");
    expect(createButtonLabel("parent", plan("enterprise"))).toBe("Create & contact sales");
  });

  it("ignores the plan in child mode — a child org does not check out", () => {
    expect(createButtonLabel("child", plan("business"))).toBe("Create organization");
    expect(createButtonLabel("child", plan("free"))).toBe("Create organization");
  });
});

describe("postCreatePath", () => {
  // The board is where the "connect a channel" call to action lives, so a
  // brand-new (empty) org lands on the thing it needs to do next.
  it("routes to the new org's exposure board", () => {
    expect(postCreatePath("acme")).toBe("/orgs/acme/exposure");
  });

  it("takes only a slug — the destination no longer depends on a git source", () => {
    expect(postCreatePath.length).toBe(1);
  });
});
