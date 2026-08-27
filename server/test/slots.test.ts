import { describe, it, expect } from 'vitest';
import {
  availableSlots,
  isWithinSchedule,
  nextTimeWithinSchedule,
  zonedWallTimeToUtc,
} from '../src/agent/slots';
import type { Schedule } from '../src/agent/hours';

// Mon-Fri 09:00-17:00, Sat 10:00-14:00, Sun closed.
const WEEKDAYS_9_5: Schedule = [
  null,
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [600, 840],
];

const AR = 'America/Argentina/Buenos_Aires';
const NY = 'America/New_York';

describe('zonedWallTimeToUtc', () => {
  it('resolves a wall time to the instant it names', () => {
    // Buenos Aires is UTC-3 year round.
    const utc = zonedWallTimeToUtc({ year: 2026, month: 3, day: 11, hour: 15, minute: 0 }, AR);
    expect(utc.toISOString()).toBe('2026-03-11T18:00:00.000Z');
  });

  it('honors the offset in force on that date, not today (DST)', () => {
    // New York: EST (-5) in January, EDT (-4) in July. A naive fixed-offset
    // conversion gets one of these wrong by an hour — and an appointment an
    // hour off is a customer at a locked door.
    const winter = zonedWallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, NY);
    const summer = zonedWallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, NY);

    expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('round-trips across a DST boundary in both directions', () => {
    for (const [month, day] of [[3, 20], [11, 20]] as const) {
      const wall = { year: 2026, month, day, hour: 14, minute: 30 };
      const utc = zonedWallTimeToUtc(wall, NY);
      const back = new Intl.DateTimeFormat('en-US', {
        timeZone: NY,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }).format(utc);
      expect(back).toBe('14:30');
    }
  });
});

describe('availableSlots', () => {
  const base = {
    schedule: WEEKDAYS_9_5,
    timezone: AR,
    slotMinutes: 60,
    horizonDays: 7,
    busy: [],
    leadMinutes: 0,
    limit: 100,
  };

  it('offers slots only inside the opening window', () => {
    // Wednesday 2026-03-11, 08:00 local (11:00Z).
    const slots = availableSlots({ ...base, from: new Date('2026-03-11T11:00:00Z'), limit: 8 });

    const localHours = slots.map((s) =>
      Number(
        new Intl.DateTimeFormat('en-US', { timeZone: AR, hour12: false, hour: '2-digit' }).format(
          s.startsAt,
        ),
      ),
    );
    for (const hour of localHours) {
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(17);
    }
  });

  it('never offers a slot in the past', () => {
    // 14:30 local on the Wednesday — 09:00 through 14:00 are already gone.
    const from = new Date('2026-03-11T17:30:00Z');
    const slots = availableSlots({ ...base, from, limit: 3 });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
  });

  it('respects the lead time so nothing is bookable a minute from now', () => {
    const from = new Date('2026-03-11T12:05:00Z'); // 09:05 local
    const slots = availableSlots({ ...base, from, leadMinutes: 120, limit: 1 });

    expect(slots[0].startsAt.getTime()).toBeGreaterThanOrEqual(from.getTime() + 120 * 60_000);
  });

  it('skips days the business is closed', () => {
    // Sunday 2026-03-15 local.
    const slots = availableSlots({ ...base, from: new Date('2026-03-15T12:00:00Z'), limit: 5 });

    const weekdays = new Set(
      slots.map((s) =>
        new Intl.DateTimeFormat('en-US', { timeZone: AR, weekday: 'short' }).format(s.startsAt),
      ),
    );
    expect(weekdays.has('Sun')).toBe(false);
  });

  it('excludes slots that collide with an existing appointment', () => {
    const from = new Date('2026-03-11T11:00:00Z');
    const taken = availableSlots({ ...base, from, limit: 1 })[0];

    const after = availableSlots({ ...base, from, busy: [taken], limit: 1 });

    expect(after[0].startsAt.getTime()).not.toBe(taken.startsAt.getTime());
  });

  it('treats a partial overlap as a collision, not just an exact match', () => {
    const from = new Date('2026-03-11T11:00:00Z');
    const first = availableSlots({ ...base, from, limit: 1 })[0];
    // Something running from halfway through the first slot into the second.
    const straddling = {
      startsAt: new Date(first.startsAt.getTime() + 30 * 60_000),
      endsAt: new Date(first.startsAt.getTime() + 90 * 60_000),
    };

    const slots = availableSlots({ ...base, from, busy: [straddling], limit: 2 });

    for (const slot of slots) {
      expect(slot.startsAt < straddling.endsAt && straddling.startsAt < slot.endsAt).toBe(false);
    }
  });

  it('keeps a whole hour available across a DST transition', () => {
    // US DST starts 2026-03-08. Slots must stay on the local 09:00-17:00 grid.
    const slots = availableSlots({
      ...base,
      timezone: NY,
      from: new Date('2026-03-06T12:00:00Z'),
      horizonDays: 5,
      limit: 40,
    });

    for (const slot of slots) {
      const hour = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: NY, hour12: false, hour: '2-digit' }).format(
          slot.startsAt,
        ),
      );
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(17);
    }
  });

  it('returns nothing for a degenerate configuration instead of looping', () => {
    const from = new Date('2026-03-11T11:00:00Z');
    expect(availableSlots({ ...base, from, slotMinutes: 0 })).toEqual([]);
    expect(availableSlots({ ...base, from, horizonDays: 0 })).toEqual([]);
    expect(availableSlots({ ...base, from, limit: 0 })).toEqual([]);
    expect(availableSlots({ ...base, from, schedule: [null, null, null, null, null, null, null] })).toEqual([]);
  });
});

describe('quiet hours', () => {
  it('knows when the business is open', () => {
    expect(isWithinSchedule(new Date('2026-03-11T13:00:00Z'), WEEKDAYS_9_5, AR)).toBe(true); // 10:00
    expect(isWithinSchedule(new Date('2026-03-11T06:00:00Z'), WEEKDAYS_9_5, AR)).toBe(false); // 03:00
    expect(isWithinSchedule(new Date('2026-03-15T13:00:00Z'), WEEKDAYS_9_5, AR)).toBe(false); // Sunday
  });

  it('defers a 3am reminder to the next opening rather than sending it', () => {
    const threeAm = new Date('2026-03-11T06:00:00Z');

    const deferred = nextTimeWithinSchedule(threeAm, WEEKDAYS_9_5, AR)!;

    expect(deferred.getTime()).toBeGreaterThan(threeAm.getTime());
    expect(isWithinSchedule(deferred, WEEKDAYS_9_5, AR)).toBe(true);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: AR, hour12: false, hour: '2-digit' }).format(deferred);
    expect(Number(hour)).toBe(9);
  });

  it('leaves an in-hours time exactly where it is', () => {
    const inHours = new Date('2026-03-11T13:00:00Z');
    expect(nextTimeWithinSchedule(inHours, WEEKDAYS_9_5, AR)).toBe(inHours);
  });

  it('skips a closed day entirely', () => {
    // Saturday 20:00 local → next opening is Monday 09:00, not Sunday.
    const satNight = new Date('2026-03-14T23:00:00Z');
    const next = nextTimeWithinSchedule(satNight, WEEKDAYS_9_5, AR)!;
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: AR, weekday: 'short' }).format(next);
    expect(weekday).toBe('Mon');
  });

  it('returns null when the schedule never opens, so the caller does not send', () => {
    const never: Schedule = [null, null, null, null, null, null, null];
    expect(nextTimeWithinSchedule(new Date('2026-03-11T06:00:00Z'), never, AR)).toBeNull();
  });
});
