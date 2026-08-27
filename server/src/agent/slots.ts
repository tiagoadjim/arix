import { nowInTimezone, type Schedule } from './hours';

/**
 * Appointment slot arithmetic.
 *
 * hours.ts answers "are we open right now?" — enough to decide what the agent
 * may promise, but not enough to book. This module answers the harder
 * question: which concrete slots are free, expressed as real instants.
 *
 * All of it is pure. The schedule, timezone and busy list are parameters, so
 * the behaviour around midnight, overnight windows and DST can be tested
 * without a database, a clock, or a server.
 */

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

export interface WallTime {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
}

/**
 * Resolve a wall-clock time in `timezone` to the UTC instant it names.
 *
 * There is no standard API for this direction, so it is solved by
 * successive approximation: guess, ask what that instant actually looks like
 * in the zone, and correct by the difference. Two rounds are enough — the
 * first absorbs the base UTC offset, the second the DST discontinuity when
 * the guess landed on the far side of a transition.
 *
 * On a spring-forward gap the named wall time does not exist; the result is
 * the nearest instant that does, which is the sane thing to hand someone
 * booking an appointment.
 */
export function zonedWallTimeToUtc(wall: WallTime, timezone: string): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const seen = nowInTimezone(new Date(guess), timezone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const drift = target - seenAsUtc;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

/** Calendar-only date arithmetic on local fields — never a timezone conversion. */
function localDatePlusDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function overlaps(a: Slot, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export interface AvailabilityOptions {
  /** Instant to search forward from — normally "now". */
  from: Date;
  /** Weekly opening windows, minutes from local midnight (see hours.ts). */
  schedule: Schedule;
  timezone: string;
  /** Length of one appointment, and the grid slots are generated on. */
  slotMinutes: number;
  /** How many days ahead to look. */
  horizonDays: number;
  /** Appointments already taken, as real instants. */
  busy: ReadonlyArray<{ startsAt: Date; endsAt: Date }>;
  /** Refuse to offer anything starting sooner than this. */
  leadMinutes: number;
  /** Stop after this many free slots. */
  limit: number;
}

/**
 * Free slots, earliest first.
 *
 * Slots sit on a fixed grid from each day's opening minute, so the same slot
 * has the same start time whoever asks and whenever they ask — two customers
 * racing for "the 15:00" collide on one row rather than booking two
 * overlapping appointments a few minutes apart (the partial unique index in
 * migration 0008 is what actually settles that race).
 */
export function availableSlots(options: AvailabilityOptions): Slot[] {
  const {
    from,
    schedule,
    timezone,
    slotMinutes,
    horizonDays,
    busy,
    leadMinutes,
    limit,
  } = options;

  if (slotMinutes <= 0 || horizonDays <= 0 || limit <= 0) return [];

  const earliest = new Date(from.getTime() + leadMinutes * 60_000);
  const today = nowInTimezone(from, timezone);
  const out: Slot[] = [];

  for (let dayOffset = 0; dayOffset <= horizonDays && out.length < limit; dayOffset += 1) {
    const date = localDatePlusDays(today, dayOffset);
    const window = schedule[date.weekday];
    if (!window) continue;
    const [open, close] = window;

    for (let minute = open; minute + slotMinutes <= close && out.length < limit; minute += slotMinutes) {
      // A window may run past midnight (close > 1440); minutes beyond that
      // belong to the following calendar day, at the wrapped hour.
      const dayCarry = Math.floor(minute / 1440);
      const wrapped = minute % 1440;
      const target = dayCarry === 0 ? date : localDatePlusDays(date, dayCarry);

      const startsAt = zonedWallTimeToUtc(
        {
          year: target.year,
          month: target.month,
          day: target.day,
          hour: Math.floor(wrapped / 60),
          minute: wrapped % 60,
        },
        timezone,
      );
      if (startsAt < earliest) continue;

      const slot: Slot = { startsAt, endsAt: new Date(startsAt.getTime() + slotMinutes * 60_000) };
      if (busy.some((taken) => overlaps(slot, taken))) continue;
      out.push(slot);
    }
  }

  return out;
}

/** Whether `at` falls inside an opening window — the check a reminder uses to
 * avoid waking someone at 3am, and a booking uses to reject an off-hours slot. */
export function isWithinSchedule(at: Date, schedule: Schedule, timezone: string): boolean {
  const local = nowInTimezone(at, timezone);
  const minutes = local.hour * 60 + local.minute;

  const today = schedule[local.weekday];
  if (today && minutes >= today[0] && minutes < Math.min(today[1], 1440)) return true;

  // Yesterday's window may still be running past midnight.
  const yesterday = schedule[(local.weekday + 6) % 7];
  if (yesterday && yesterday[1] > 1440 && minutes < yesterday[1] - 1440) return true;

  return false;
}

/**
 * The next instant at or after `at` that falls inside an opening window.
 *
 * Used to defer a reminder that would otherwise fire while the business is
 * closed. Returns null when the schedule is empty in the days searched, which
 * the caller must treat as "do not send" rather than "send now".
 */
export function nextTimeWithinSchedule(
  at: Date,
  schedule: Schedule,
  timezone: string,
  searchDays = 8,
): Date | null {
  if (isWithinSchedule(at, schedule, timezone)) return at;

  const local = nowInTimezone(at, timezone);
  const minutes = local.hour * 60 + local.minute;

  for (let dayOffset = 0; dayOffset <= searchDays; dayOffset += 1) {
    const date = localDatePlusDays(local, dayOffset);
    const window = schedule[date.weekday];
    if (!window) continue;
    // Today's window only counts if it has not already opened and closed.
    if (dayOffset === 0 && minutes >= window[0]) continue;

    return zonedWallTimeToUtc(
      {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: Math.floor(window[0] / 60),
        minute: window[0] % 60,
      },
      timezone,
    );
  }

  return null;
}
