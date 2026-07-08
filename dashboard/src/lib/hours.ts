// Client-side mirror of server/src/agent/hours.ts's Schedule shape (the
// `business.hours` setting's `json` type). Duplicated deliberately — no
// import across the server/dashboard package boundary. Index 0 = Sunday …
// index 6 = Saturday, matching the server engine exactly.

/** [openMinute, closeMinute) from local midnight. closeMinute may exceed 1440
 * to express a window that crosses into the next day (e.g. 1620 = 03:00 AM). */
export type Window = readonly [open: number, close: number];

/** `null` = closed that weekday. Length 7, index 0 = Sunday. */
export type Schedule = ReadonlyArray<Window | null>;

export function emptySchedule(): Schedule {
  return [null, null, null, null, null, null, null];
}

/** Clamp + format minutes-since-midnight as "HH:MM", wrapping any next-day overflow back into 0-23h. */
export function minutesToHHMM(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Parse an `<input type="time">` value ("HH:MM") into minutes since midnight. Returns 0 if malformed. */
export function hhmmToMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return 0;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(23, Math.max(0, h)) * 60 + Math.min(59, Math.max(0, m));
}

/** True when a window's close time crosses into the next day (close >= 1440). */
export function crossesMidnight(window: Window | null): boolean {
  return Boolean(window && window[1] >= 1440);
}
