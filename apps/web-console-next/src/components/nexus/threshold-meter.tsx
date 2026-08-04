"use client";

/**
 * The threshold meter.
 *
 * The one rule this component exists to hold: **a null fraction is not a zero
 * fraction.** `meterPercent` returns null for a `threshold_logic = 'none'`
 * jurisdiction and for one that has never been evaluated, and this component
 * renders text in both cases rather than an empty bar. An empty bar says
 * "measured, nowhere near the line", which is a claim neither case supports.
 *
 * The bar is clamped at 100%; the *label* is not. A seller at 340% of Texas's
 * threshold should read 340%, not a full bar that looks the same as 101%.
 */

import * as React from "react";
import { cn } from "@/lib/cn";
import { meterPercent, meterWidth } from "./nexus";

export interface ThresholdMeterProps {
  /** Progress toward the binding threshold, or null when there is no threshold. */
  fraction: number | null;
  /** Shown in place of the bar when `fraction` is null. */
  emptyLabel?: string;
  className?: string;
  /** Accessible name — the meter is a figure, not decoration. */
  label?: string;
}

export function ThresholdMeter({
  fraction,
  emptyLabel = "No threshold to measure against",
  className,
  label = "Progress toward threshold",
}: ThresholdMeterProps) {
  const pct = meterPercent(fraction);

  if (pct === null) {
    return (
      <p
        className={cn("text-xs italic text-muted-foreground", className)}
        data-testid="threshold-meter-empty"
      >
        {emptyLabel}
      </p>
    );
  }

  const width = meterWidth(fraction);
  const crossed = pct >= 100;
  const approaching = pct >= 80;

  return (
    <div className={cn("space-y-1", className)} data-testid="threshold-meter">
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        // The bar's scale is 0–100% of the threshold even when the value
        // exceeds it; `aria-valuetext` carries the unclamped truth.
        aria-valuemax={100}
        aria-valuetext={`${Math.round(pct)}% of threshold`}
      >
        <div
          className={cn(
            "h-2 rounded-full transition-[width]",
            crossed ? "bg-destructive" : approaching ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        {Math.round(pct)}% of threshold
      </div>
    </div>
  );
}
