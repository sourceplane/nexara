/**
 * Pure (no-React) model for the guided create-organization flow, kept separate
 * so step/labels/routing logic is unit-testable without a DOM — the same split
 * the billing UI uses (`plan-actions.ts`).
 *
 * "parent" mode is the account's first organization: it owns billing, so the
 * flow includes a plan step. "child" mode is any additional organization:
 * billing rolls up to the account's billing parent (MO2), so the plan step is
 * replaced by a starting-point step (connect Git / clone a template).
 */

export type CreateOrgMode = "parent" | "child";

export type StepId = "details" | "plan" | "review";

export interface StepDef {
  id: StepId;
  label: string;
  description: string;
}

/** The wizard's steps for a given mode. */
export function flowSteps(mode: CreateOrgMode): StepDef[] {
  return [
    { id: "details", label: "Organization", description: "Name and URL" },
    // An additional organization inherits its parent's plan (the MO3
    // entitlement fan-out), so it has nothing to pick — details and review.
    ...(mode === "parent"
      ? [{ id: "plan" as const, label: "Plan", description: "Pick your pricing tier" }]
      : []),
    { id: "review", label: "Review", description: "Confirm and create" },
  ];
}

// ---------------------------------------------------------------------------
// Plans (parent mode)
// ---------------------------------------------------------------------------

export interface PlanOption {
  /** Stable billing plan code — checkout runs against the real plan after create. */
  code: string;
  name: string;
  tagline: string;
  /** Display price, e.g. "$20". */
  price: string;
  /** Display billing period suffix, e.g. "/mo". */
  per?: string;
  popular?: boolean;
  /** Contact-sales tier with no self-serve checkout. */
  contact?: boolean;
}

/**
 * Display catalog for the plan step. It runs before the organization (and
 * therefore its org-scoped `/billing/plans` surface) exists, so the cards
 * render from this catalog; the selected `code` is what drives the real
 * checkout once the organization has been created.
 */
export const PLAN_OPTIONS: PlanOption[] = [
  {
    code: "free",
    name: "Free",
    tagline: "For a first look at where you stand",
    price: "$0",
    per: "/mo",
  },
  {
    code: "pro",
    name: "Pro",
    tagline: "For sellers trading across state lines",
    price: "$20",
    per: "/mo",
  },
  {
    code: "business",
    name: "Business",
    tagline: "For companies running multiple teams",
    price: "$100",
    per: "/mo",
    popular: true,
  },
  {
    code: "enterprise",
    name: "Enterprise",
    tagline: "Security, control, and support at scale",
    price: "Custom",
    contact: true,
  },
];

// ---------------------------------------------------------------------------
// Submit semantics
// ---------------------------------------------------------------------------

/** The primary button label on the review step, naming the hand-off it triggers. */
export function createButtonLabel(mode: CreateOrgMode, plan: PlanOption): string {
  if (mode === "parent" && plan.contact) return "Create & contact sales";
  if (mode === "parent" && plan.code !== "free") return "Create & continue to checkout";
  return "Create organization";
}

/**
 * Where the console routes after a successful create (when it does not leave
 * for hosted checkout): the exposure board. It is empty at this point and says
 * so, and it is still the right destination because the "connect a channel"
 * call to action lives on it.
 */
export function postCreatePath(orgSlug: string): string {
  return `/orgs/${orgSlug}/exposure`;
}
