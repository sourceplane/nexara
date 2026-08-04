// The only place in the codebase that converts between an instant and a
// jurisdiction's calendar date.
//
// This module exists because of one sentence in design §5.3:
//
//   > `occurred_at` is stored UTC but the measurement date is the
//   > **jurisdiction's** date. A 31 December 23:00 PST sale is a 1 January UTC
//   > row and must not land in the wrong year.
//
// R7 calls timezone handling "the most likely silent bug", and it is right:
// the failure mode is a handful of orders in the wrong measurement year, which
// moves a threshold by exactly enough to matter and raises no error anywhere.
// The mitigation is that no other file derives a date from a timestamp.
//
// Determinism: `Intl.DateTimeFormat` is a pure function of (instant, zone,
// tzdata). It reads no clock. A tzdata update can in principle move a
// historical offset; in practice US zone offsets for the years this product
// measures are stable, and the determination stores its computed window
// explicitly (`DeterminationInputs.window`) so a replay uses the stored
// boundaries rather than recomputing them.

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      // Normalised here rather than at each call site, so no path can reach
      // `Intl`'s own message and no path can fall back to UTC. A rule that
      // names a zone this runtime does not know is a rule-set authoring bug,
      // and measuring it in UTC instead would be the R7 failure served
      // silently.
      throw new RangeError(`Unknown IANA time zone: ${timeZone}`);
    }
    FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new RangeError(`Missing ${type} for zone ${timeZone}`);
    return Number(found.value);
  };
  // `hourCycle: "h23"` still emits 24 for midnight in some ICU builds.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Throws if `timeZone` is not a zone this runtime knows. Fail loudly at the
 *  boundary rather than silently measuring in UTC. */
export function assertKnownTimeZone(timeZone: string): void {
  try {
    formatterFor(timeZone);
  } catch {
    throw new RangeError(`Unknown IANA time zone: ${timeZone}`);
  }
}

/** The calendar date `instant` falls on, in `timeZone`. `YYYY-MM-DD`. */
export function dateInZone(instant: Date, timeZone: string): string {
  const p = partsIn(instant, timeZone);
  return (
    `${p.year.toString().padStart(4, "0")}-` +
    `${p.month.toString().padStart(2, "0")}-` +
    `${p.day.toString().padStart(2, "0")}`
  );
}

/** The zone's UTC offset in milliseconds at `instant` (positive east of UTC). */
function offsetMsAt(instant: Date, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Zero the sub-second part so the difference is the offset alone.
  return asIfUtc - (instant.getTime() - (instant.getTime() % 1000));
}

/**
 * The instant at which `date` begins in `timeZone` — local midnight, as UTC.
 *
 * Two passes, which is the standard fixed point for this: guess the offset at
 * the naive instant, correct, then re-read the offset at the corrected instant
 * in case the guess landed on the far side of a DST transition. US transitions
 * happen at 02:00 local, never at midnight, so midnight is always a real local
 * time and the fixed point is reached in one correction.
 */
export function startOfDayInZone(date: string, timeZone: string): Date {
  const naive = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(naive)) throw new RangeError(`Not a civil date: ${date}`);
  const firstGuess = naive - offsetMsAt(new Date(naive), timeZone);
  const corrected = naive - offsetMsAt(new Date(firstGuess), timeZone);
  return new Date(corrected);
}
