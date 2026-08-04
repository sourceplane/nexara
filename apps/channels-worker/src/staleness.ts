// Channel staleness — the Q4 answer (see `specs/epics/nexus/connector-gate.md`).
//
// R3: a connector that silently stops delivering produces a board that keeps
// saying `clear`, because absence of data reads identically to absence of
// sales. A fixed window does not work — a low-volume seller can legitimately
// go a week without an order, and alerting them weekly teaches them to ignore
// the alert that matters.
//
// Pure and synchronous, taking the interval sample and `now` as parameters,
// for the same reason the determination engine does: a function that reads the
// clock cannot be replayed against a stored sample when someone asks why a
// channel was flagged.

/** Below this, a channel is never flagged. A silent day is an outage for a
 *  seller with ten orders a day; anything tighter is noise for everyone. */
export const MIN_QUIET_HOURS = 24;

/** Multiple of the channel's own typical gap. Six is wide enough that ordinary
 *  variance does not trip it and narrow enough that a real stop is caught
 *  within a working week for most sellers. */
export const QUIET_MULTIPLE = 6;

/** Above this, silence is a stop regardless of cadence — three weeks. */
export const MAX_QUIET_HOURS = 21 * 24;

/** Below this many events, a channel has no cadence to take a median of. */
export const MIN_SAMPLE_EVENTS = 5;

export type StalenessVerdict =
  | { stale: false; reason: "within_cadence" | "insufficient_history" | "backfilling" | "no_events" }
  | { stale: true; quietHours: number; thresholdHours: number };

export interface StalenessInput {
  /** Hours between consecutive events, oldest first. */
  intervalsHours: readonly number[];
  lastEventAt: Date | null;
  backfillCompletedAt: Date | null;
  now: Date;
}

/**
 * The threshold, in hours, for this channel's own cadence.
 *
 * **Median, not mean.** A seller's order intervals are heavily skewed — a
 * Black Friday burst followed by a quiet January. The mean is dominated by the
 * burst and would put the threshold far too tight in January; the median is
 * the typical gap, which is the thing being asked about.
 */
export function thresholdHours(intervalsHours: readonly number[]): number {
  if (intervalsHours.length === 0) return MIN_QUIET_HOURS;
  const sorted = [...intervalsHours].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return Math.min(MAX_QUIET_HOURS, Math.max(MIN_QUIET_HOURS, QUIET_MULTIPLE * median));
}

export function evaluateStaleness(input: StalenessInput): StalenessVerdict {
  // A channel mid-backfill is not stale, it is working. Flagging it would make
  // the signal fire on every new connection, which is how a signal gets muted.
  if (input.backfillCompletedAt === null) return { stale: false, reason: "backfilling" };

  if (input.lastEventAt === null) return { stale: false, reason: "no_events" };

  // A channel with four lifetime orders has no cadence, and inventing one from
  // a sample of four produces a confidently wrong baseline — the failure mode
  // this whole product is organised against.
  if (input.intervalsHours.length < MIN_SAMPLE_EVENTS - 1) {
    return { stale: false, reason: "insufficient_history" };
  }

  const quietHours = (input.now.getTime() - input.lastEventAt.getTime()) / 3_600_000;
  const threshold = thresholdHours(input.intervalsHours);
  if (quietHours <= threshold) return { stale: false, reason: "within_cadence" };
  return { stale: true, quietHours, thresholdHours: threshold };
}
