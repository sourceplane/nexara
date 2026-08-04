// Civil-date arithmetic. No timezones, no clock, no `Date.now()`.
//
// A *civil date* here is the string `YYYY-MM-DD` — a date on a calendar, with
// no instant attached. Everything in this file maps civil date → civil date.
// Turning one into an instant is `zones.ts`'s job and needs a timezone; doing
// it here would silently pick UTC and reintroduce exactly the bug design §5.3
// case 4 exists to prevent.
//
// Internally a civil date is carried as a `Date` pinned to UTC midnight. That
// is a representation choice, not a timezone claim: `Date.UTC` gives exact,
// DST-free day arithmetic, and every value crosses this module's boundary as a
// string.

const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a well-formed `YYYY-MM-DD` naming a real calendar day. */
export function isCivilDate(value: string): boolean {
  const m = CIVIL_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Round-tripping catches 2026-02-30 and friends, which the range check above
  // lets through.
  return toCivilDate(new Date(Date.UTC(y, mo - 1, d))) === value;
}

/** Parse `YYYY-MM-DD` into its UTC-midnight carrier. Throws on a bad date. */
export function parseCivilDate(value: string): Date {
  if (!isCivilDate(value)) {
    throw new RangeError(`Not a civil date: ${value}`);
  }
  const m = CIVIL_DATE_RE.exec(value)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Format a UTC-midnight carrier back to `YYYY-MM-DD`. */
export function toCivilDate(carrier: Date): string {
  const y = carrier.getUTCFullYear().toString().padStart(4, "0");
  const mo = (carrier.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = carrier.getUTCDate().toString().padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** `date` shifted by whole days. Negative moves backwards. */
export function addDays(date: string, days: number): string {
  const carrier = parseCivilDate(date);
  carrier.setUTCDate(carrier.getUTCDate() + days);
  return toCivilDate(carrier);
}

/**
 * `date` shifted by whole months, **clamped to the end of the target month**.
 *
 * 2024-03-31 minus one month is 2024-02-29, not 2024-03-02. The naive
 * implementation (`setUTCMonth`) overflows into the following month and moves
 * a measurement window by a couple of days once or twice a year, which is
 * exactly the size of error that changes a threshold answer and produces no
 * error anywhere.
 */
export function addMonths(date: string, months: number): string {
  const carrier = parseCivilDate(date);
  const day = carrier.getUTCDate();
  const target = new Date(
    Date.UTC(carrier.getUTCFullYear(), carrier.getUTCMonth() + months, 1),
  );
  const lastDay = daysInMonth(target.getUTCFullYear(), target.getUTCMonth());
  target.setUTCDate(Math.min(day, lastDay));
  return toCivilDate(target);
}

/** The first day of `date`'s month. */
export function startOfMonth(date: string): string {
  const carrier = parseCivilDate(date);
  return toCivilDate(
    new Date(Date.UTC(carrier.getUTCFullYear(), carrier.getUTCMonth(), 1)),
  );
}

/** The last day of `date`'s month. */
export function endOfMonth(date: string): string {
  const carrier = parseCivilDate(date);
  const y = carrier.getUTCFullYear();
  const m = carrier.getUTCMonth();
  return toCivilDate(new Date(Date.UTC(y, m, daysInMonth(y, m))));
}

/** The first day of the calendar quarter containing `date`. */
export function startOfQuarter(date: string): string {
  const carrier = parseCivilDate(date);
  const quarterMonth = Math.floor(carrier.getUTCMonth() / 3) * 3;
  return toCivilDate(
    new Date(Date.UTC(carrier.getUTCFullYear(), quarterMonth, 1)),
  );
}

/** The first day of `date`'s calendar year. */
export function startOfYear(year: number): string {
  return toCivilDate(new Date(Date.UTC(year, 0, 1)));
}

/** The calendar year of `date`. */
export function yearOf(date: string): number {
  return parseCivilDate(date).getUTCFullYear();
}

function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
