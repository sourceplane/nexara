"use client";

/**
 * One jurisdiction on the exposure board.
 *
 * The card carries the position *and* the reason it holds: the rule's basis,
 * period and marketplace treatment are on the face of it, because "Texas:
 * crossed" without "measuring gross sales over the trailing twelve months,
 * marketplace sales excluded" is a number a seller cannot check.
 *
 * A `no_obligation` card renders the rule row that says so — never a blank and
 * never a meter at 0%. That is the acceptance criterion, and it is here rather
 * than in a conditional at the page level so it cannot be forgotten by a
 * second caller.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { PublicJurisdictionExposure } from "@saas/contracts/nexus";
import { ThresholdMeter } from "./threshold-meter";
import {
  describeBasis,
  describeMarketplace,
  describePeriod,
  formatCents,
  formatDate,
  presentStatus,
  toneVariant,
} from "./nexus";

export interface ExposureCardProps {
  exposure: PublicJurisdictionExposure;
  /** `/orgs/:slug` — the card links to `${orgBase}/jurisdictions/:code`. */
  orgBase: string;
}

export function ExposureCard({ exposure: e, orgBase }: ExposureCardProps) {
  const status = presentStatus(e.status);
  const outOfScope = e.status === "no_obligation";
  const neverEvaluated = e.determinationId === null;

  return (
    <Card className="transition-shadow hover:shadow-sm" data-testid={`exposure-card-${e.jurisdiction}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              href={`${orgBase}/jurisdictions/${encodeURIComponent(e.jurisdiction)}`}
              className="group flex items-center gap-1 font-medium hover:underline"
            >
              <span className="truncate">{e.jurisdictionName}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
            </Link>
            <div className="font-mono text-[11px] text-muted-foreground">{e.jurisdiction}</div>
          </div>
          <Badge variant={toneVariant(status.tone)} className="shrink-0">
            {status.label}
          </Badge>
        </div>

        {outOfScope ? (
          // Cites the rule row rather than showing an empty meter. The rule
          // exists and says there is no threshold; that is a fact worth
          // rendering, and it is not the same fact as "we have no data".
          <p className="text-xs text-muted-foreground">
            {status.description} Rule set {e.ruleSetVersion} carries an explicit rule row for{" "}
            {e.jurisdictionName} with no economic-nexus threshold.
          </p>
        ) : neverEvaluated ? (
          <p className="text-xs italic text-muted-foreground">
            Not yet evaluated. Nothing is being claimed about this jurisdiction.
          </p>
        ) : (
          <>
            <ThresholdMeter
              fraction={e.fractionOfThreshold}
              label={`${e.jurisdictionName} progress toward threshold`}
            />
            <dl className="space-y-0.5 text-xs text-muted-foreground">
              <div className="flex justify-between gap-2">
                <dt>Measured sales</dt>
                <dd className="tabular-nums text-foreground">
                  {formatCents(e.measuredSalesCents)}
                  {e.thresholdSalesCents !== null
                    ? ` / ${formatCents(e.thresholdSalesCents)}`
                    : ""}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Transactions</dt>
                <dd className="tabular-nums text-foreground">
                  {e.measuredTransactions.toLocaleString("en-US")}
                  {e.thresholdTransactions !== null
                    ? ` / ${e.thresholdTransactions.toLocaleString("en-US")}`
                    : ""}
                </dd>
              </div>
            </dl>
          </>
        )}

        {/*
          Suppressed when out of scope. The rule footer ends "…from this
          threshold", and printing it under a card that has just said there is
          no threshold contradicts the card in its own last line — the exact
          conflation `no_obligation` exists to prevent.
        */}
        {outOfScope ? null : (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {describeBasis(e.measurementBasis)} over {describePeriod(e.measurementPeriod)};{" "}
            {describeMarketplace(e.marketplaceTreatment)}.
          </p>
        )}

        {e.registrationDueOn ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <CalendarClock className="h-3.5 w-3.5" />
            Registration deadline {formatDate(e.registrationDueOn)}
          </p>
        ) : null}

        {e.registrationStatus ? (
          <Badge variant="outline" className="text-[10px]">
            Registration: {e.registrationStatus}
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  );
}
