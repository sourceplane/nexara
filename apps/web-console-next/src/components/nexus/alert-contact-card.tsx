"use client";

/**
 * Where threshold alerts go (R10).
 *
 * NX5 shipped the alerting mechanism with a per-environment fallback and said
 * in writing that the right answer is a seller naming their own tax contact,
 * with the console as the place to ask. This card is that ask.
 *
 * The state it works hard to get right is the *third* one. There are three,
 * not two, and a card that renders only "set" and "unset" would tell a seller
 * something false in the middle case:
 *
 *   - a contact is set          → alerts go there;
 *   - no contact, no fallback   → alerts go NOWHERE, and the card says so
 *                                 loudly, because the seller will otherwise
 *                                 assume this product is watching for them;
 *   - no contact, but the
 *     environment has a default → alerts are going somewhere the seller did
 *                                 not choose. Saying "no recipient" here is a
 *                                 lie; saying nothing is worse.
 */

import * as React from "react";
import { BellRing, BellOff, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GetAlertContactResponse } from "@saas/contracts/nexus";

export type AlertContactState =
  | { kind: "configured"; email: string; label: string | null }
  | { kind: "environment-fallback" }
  | { kind: "none" };

/** Pure: the three-way read of the response. Unit-tested; see `nexus-presentation.test.ts`. */
export function alertContactState(data: GetAlertContactResponse): AlertContactState {
  if (data.contact) {
    return { kind: "configured", email: data.contact.email, label: data.contact.label };
  }
  return data.hasEnvironmentFallback ? { kind: "environment-fallback" } : { kind: "none" };
}

export interface AlertContactPresentation {
  tone: "success" | "warning" | "danger";
  headline: string;
  detail: string;
}

/** Pure: how each of the three states reads. */
export function presentAlertContact(state: AlertContactState): AlertContactPresentation {
  switch (state.kind) {
    case "configured":
      return {
        tone: "success",
        headline: `Alerts go to ${state.email}`,
        detail: state.label
          ? `${state.label}. One email per jurisdiction per crossing — never a digest, never a repeat.`
          : "One email per jurisdiction per crossing — never a digest, never a repeat.",
      };
    case "environment-fallback":
      return {
        tone: "warning",
        headline: "Alerts are going to an address you did not choose",
        detail:
          "This deployment has a default alert address configured. Name your own tax contact so " +
          "crossings reach the person who acts on them.",
      };
    default:
      return {
        tone: "danger",
        // The loudest copy on the surface, deliberately. A compliance product
        // whose alerts go nowhere is worse than no alerts, because the seller
        // believes something is watching.
        headline: "No one is being told when you cross a threshold",
        detail:
          "Positions are still measured and recorded, but no alert is being sent. Add a tax " +
          "contact so a crossing reaches a person.",
      };
  }
}

export interface AlertContactCardProps {
  state: AlertContactState;
  saving?: boolean | undefined;
  onSave: (email: string, label: string | null) => void;
  /** Absent when there is nothing to remove — a "Remove" button next to no
   *  contact is a control that does nothing. */
  onClear?: (() => void) | undefined;
}

const TONE_CLASS: Record<AlertContactPresentation["tone"], string> = {
  success: "border-success/40",
  warning: "border-warning/50 bg-warning/5",
  danger: "border-destructive/50 bg-destructive/5",
};

const TONE_ICON = { success: BellRing, warning: Bell, danger: BellOff } as const;

export function AlertContactCard({ state, saving, onSave, onClear }: AlertContactCardProps) {
  const presentation = presentAlertContact(state);
  const Icon = TONE_ICON[presentation.tone];
  const [editing, setEditing] = React.useState(state.kind !== "configured");
  const [email, setEmail] = React.useState(state.kind === "configured" ? state.email : "");
  const [label, setLabel] = React.useState(
    state.kind === "configured" ? (state.label ?? "") : "",
  );

  return (
    <Card className={TONE_CLASS[presentation.tone]} data-testid="alert-contact-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4" />
          {presentation.headline}
        </CardTitle>
        <CardDescription>{presentation.detail}</CardDescription>
      </CardHeader>
      <CardContent>
        {editing ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              onSave(email.trim(), label.trim() || null);
              setEditing(false);
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="alert-email" className="text-xs">
                Tax contact
              </Label>
              <Input
                id="alert-email"
                type="email"
                className="w-64"
                placeholder="finance@yourcompany.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="alert-label" className="text-xs">
                Label (optional)
              </Label>
              <Input
                id="alert-label"
                className="w-48"
                placeholder="Our bookkeeper"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={saving || !email.trim()}>
              {saving ? "Saving…" : "Save contact"}
            </Button>
            {state.kind === "configured" ? (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Change
            </Button>
            {onClear ? (
              <Button variant="ghost" size="sm" onClick={onClear}>
                Remove
              </Button>
            ) : null}
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Often an accountant or a shared finance inbox — it does not need a {""}
          console login.
        </p>
      </CardContent>
    </Card>
  );
}
