"use client";

/**
 * The determination explainer — the visual proof of invariant 3.
 *
 * A determination is reproducible: re-running `engineVersion` against the
 * stored `inputs` and the named rule must return the same `status`,
 * `crossedOn`, and `registrationDueOn`. This component is what makes that
 * claim *inspectable by a human* rather than only by a test:
 *
 *   - the reproducibility triple is rendered verbatim (rule-set version, rule
 *     id, engine version) — not summarised, not prettified;
 *   - the window is rendered as the half-open range it is, with the end
 *     labelled exclusive;
 *   - the measured value and the threshold sit next to each other with the
 *     rule's own combining logic spelled out in words;
 *   - the raw `inputs` payload is one disclosure away, as stored.
 *
 * Nothing here is computed from the numbers. Every value shown is a field of
 * the stored determination, because a screen that recomputed the answer while
 * claiming to explain it would be showing today's code, not the decision.
 *
 * The one deliberate omission: there is no "recalculate" button and no edit
 * affordance anywhere in this component. A determination is immutable; a
 * console that could nudge one turns the audit record into an opinion.
 */

import * as React from "react";
import { ChevronRight, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PublicDetermination, PublicRule } from "@saas/contracts/nexus";
import {
  describeBasis,
  describeLogic,
  describeMarketplace,
  describePeriod,
  describeWindow,
  formatCents,
  formatDate,
  presentStatus,
  toneVariant,
} from "./nexus";

export interface DeterminationExplainerProps {
  determination: PublicDetermination;
  /** The rule in force when this determination was taken. */
  rule: PublicRule;
  jurisdictionName: string;
}

export function DeterminationExplainer({
  determination: d,
  rule,
  jurisdictionName,
}: DeterminationExplainerProps) {
  const status = presentStatus(d.status);
  return (
    <Card data-testid="determination-explainer">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">How this position was reached</CardTitle>
            <CardDescription>
              {jurisdictionName}, evaluated {formatDate(d.evaluatedAt)}.
            </CardDescription>
          </div>
          <Badge variant={toneVariant(status.tone)}>{status.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {d.internalOnly ? (
          // §11, restated at the point of evidence. The board already carries
          // the banner; a reader who deep-links straight to a determination
          // must not have to have seen it.
          <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
            Produced from an <strong>unverified</strong> rule set. Internal review only —
            this is not a compliance determination and it raised no alert.
          </p>
        ) : null}

        <Section title="What was measured">
          <Row label="Basis">
            {describeBasis(rule.measurementBasis)} over {describePeriod(rule.measurementPeriod)}
          </Row>
          <Row label="Window">{describeWindow(d.periodStart, d.periodEnd)}</Row>
          <Row label="Measurement dates taken in">
            <code className="text-xs">{rule.measurementTimezone}</code>
          </Row>
          <Row label="Marketplace sales">{describeMarketplace(rule.marketplaceTreatment)}</Row>
        </Section>

        <Section title="Measured against the threshold">
          <div className="grid gap-3 sm:grid-cols-2">
            <Figure
              label="Measured sales"
              value={formatCents(d.measuredSalesCents)}
              against={
                d.thresholdSalesCents === null
                  ? "no sales threshold"
                  : `of ${formatCents(d.thresholdSalesCents)}`
              }
            />
            <Figure
              label="Measured transactions"
              value={d.measuredTransactions.toLocaleString("en-US")}
              against={
                d.thresholdTransactions === null
                  ? "no transaction threshold"
                  : `of ${d.thresholdTransactions.toLocaleString("en-US")}`
              }
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {describeLogic(rule.thresholdLogic, d.thresholdSalesCents, d.thresholdTransactions)}
          </p>
        </Section>

        {d.crossedOn ? (
          <Section title="Crossing and deadline">
            <Row label="First observed to cross">
              {formatDate(d.crossedOn)}
              {/* Stated exactly as the engine means it. `crossedOn` is the
                  jurisdiction-local date of the evaluation that first saw the
                  crossing, not a claim about the legal instant — for a
                  freshly backfilled ledger those differ, and pretending
                  otherwise would be the product asserting a fact it does not
                  have. */}
              <span className="ml-2 text-xs text-muted-foreground">
                (the date this was first observed, not a legal determination of when it occurred)
              </span>
            </Row>
            <Row label="Registration deadline">
              {d.registrationDueOn
                ? formatDate(d.registrationDueOn)
                : "This jurisdiction's rule defines no deadline."}
            </Row>
          </Section>
        ) : null}

        <Section title="Reproducibility">
          <p className="text-sm text-muted-foreground">
            Re-running engine <code>{d.engineVersion}</code> against the inputs below and rule{" "}
            <code>{d.ruleId}</code> returns this same result. That is asserted by a test on every
            build, not by this sentence.
          </p>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Pair label="Rule set version" value={d.ruleSetVersion} />
            <Pair label="Rule id" value={d.ruleId} />
            <Pair label="Engine version" value={d.engineVersion} />
            <Pair label="Determination id" value={d.id} />
          </dl>
          <details className="rounded-md border bg-muted/30">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium">
              <ChevronRight className="h-4 w-4 transition-transform [details[open]_&]:rotate-90" />
              <FileText className="h-4 w-4 text-muted-foreground" />
              Raw inputs, exactly as stored
            </summary>
            <pre className="overflow-x-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(d.inputs, null, 2)}
            </pre>
          </details>
        </Section>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <span className="min-w-44 text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="min-w-36 text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}

function Figure({ label, value, against }: { label: string; value: string; against: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs text-muted-foreground">{against}</div>
    </div>
  );
}
