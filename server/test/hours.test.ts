import { describe, it, expect } from 'vitest';
import {
  argentinaNow,
  deliveryStatusLine,
  getStoreStatus,
} from '../src/agent/hours';

/**
 * Argentina is UTC-3 (no DST), so an Argentina wall-clock time T corresponds to
 * UTC T+3. Helper builds a Date for a given AR local time.
 *
 * Calendar reference (2026): 2026-06-29 is a Monday, so:
 *   Mon 2026-06-29, Tue 06-30, Wed 07-01, Thu 07-02, Fri 07-03, Sat 07-04, Sun 07-05.
 */
function arDate(isoLocal: string): Date {
  // isoLocal like '2026-06-29T19:30' (AR local). Add 3h to get UTC.
  return new Date(`${isoLocal}:00-03:00`);
}

describe('argentinaNow', () => {
  it('reads AR wall-clock parts from a UTC instant', () => {
    const ar = argentinaNow(new Date('2026-06-29T22:30:00Z')); // = 19:30 AR Monday
    expect(ar).toMatchObject({
      year: 2026,
      month: 6,
      day: 29,
      hour: 19,
      minute: 30,
      weekday: 1, // Monday
    });
  });

  it('rolls the date back to the previous AR day late at night (UTC vs AR)', () => {
    // 2026-06-30T01:00Z is still 2026-06-29 22:00 in Argentina.
    const ar = argentinaNow(new Date('2026-06-30T01:00:00Z'));
    expect(ar.day).toBe(29);
    expect(ar.hour).toBe(22);
    expect(ar.weekday).toBe(1); // still Monday
  });
});

describe('getStoreStatus — the reported bug (Monday 19:30)', () => {
  it('reports CLOSED and points to tomorrow', () => {
    const s = getStoreStatus(arDate('2026-06-29T19:30'));
    expect(s.open).toBe(false);
    expect(s.nextOpenLabel).toBe('mañana martes a las 11:00');
    expect(s.nowLabel).toContain('lunes');
    expect(s.nowLabel).toContain('19:30');
  });

  it('the prompt line forbids same-day promises', () => {
    const line = deliveryStatusLine(getStoreStatus(arDate('2026-06-29T19:30')));
    expect(line).toContain('CERRADOS');
    expect(line).toContain('NO prometas');
    expect(line).toContain('mañana martes a las 11:00');
  });
});

describe('getStoreStatus — weekday windows (Mon–Thu, 11:00–17:00)', () => {
  it('open mid-afternoon', () => {
    const s = getStoreStatus(arDate('2026-06-29T14:00')); // Monday
    expect(s.open).toBe(true);
    expect(s.closesAt).toBe('17:00');
    expect(s.minutesUntilClose).toBe(180);
  });

  it('warns when close to the cutoff', () => {
    const s = getStoreStatus(arDate('2026-06-29T16:40')); // 20 min to close
    expect(s.open).toBe(true);
    expect(s.minutesUntilClose).toBe(20);
    expect(deliveryStatusLine(s)).toContain('quizás no llega a entrar hoy');
  });

  it('warns within ~75 min (delivery can take up to ~60 min)', () => {
    const s = getStoreStatus(arDate('2026-06-29T15:50')); // 70 min to close
    expect(s.minutesUntilClose).toBe(70);
    expect(deliveryStatusLine(s)).toContain('quizás no llega a entrar hoy');
  });

  it('does NOT warn when there is plenty of time left', () => {
    const s = getStoreStatus(arDate('2026-06-29T14:00')); // 180 min to close
    expect(deliveryStatusLine(s)).not.toContain('quizás no llega');
  });

  it('closed exactly at the cutoff (17:00)', () => {
    const s = getStoreStatus(arDate('2026-06-29T17:00'));
    expect(s.open).toBe(false);
    expect(s.nextOpenLabel).toBe('mañana martes a las 11:00');
  });

  it('before opening points to today', () => {
    const s = getStoreStatus(arDate('2026-06-29T10:00'));
    expect(s.open).toBe(false);
    expect(s.nextOpenLabel).toBe('hoy a las 11:00');
  });

  it('open exactly at opening (11:00)', () => {
    const s = getStoreStatus(arDate('2026-06-29T11:00'));
    expect(s.open).toBe(true);
    expect(s.minutesUntilClose).toBe(360);
  });
});

describe('getStoreStatus — Friday & Saturday extended to 03:00', () => {
  it('Friday late night is still open, closes at 03:00', () => {
    const s = getStoreStatus(arDate('2026-07-03T23:00')); // Friday 23:00
    expect(s.open).toBe(true);
    expect(s.closesAt).toBe('03:00');
    expect(s.minutesUntilClose).toBe(240);
  });

  it('Saturday 02:00 is still inside Friday night (overnight tail)', () => {
    const s = getStoreStatus(arDate('2026-07-04T02:00')); // Saturday 02:00
    expect(s.open).toBe(true);
    expect(s.closesAt).toBe('03:00');
    expect(s.minutesUntilClose).toBe(60);
  });

  it('Saturday 04:00 is closed until Saturday 11:00', () => {
    const s = getStoreStatus(arDate('2026-07-04T04:00'));
    expect(s.open).toBe(false);
    expect(s.nextOpenLabel).toBe('hoy a las 11:00');
  });

  it('Sunday 01:00 is still inside Saturday night', () => {
    const s = getStoreStatus(arDate('2026-07-05T01:00')); // Sunday 01:00
    expect(s.open).toBe(true);
    expect(s.closesAt).toBe('03:00');
  });
});

describe('getStoreStatus — Sunday closed', () => {
  it('Sunday midday is closed until Monday', () => {
    const s = getStoreStatus(arDate('2026-07-05T13:00'));
    expect(s.open).toBe(false);
    expect(s.nextOpenLabel).toBe('mañana lunes a las 11:00');
  });

  it('Monday 02:00 has no Sunday tail (closed until 11:00)', () => {
    const s = getStoreStatus(arDate('2026-06-29T02:00'));
    expect(s.open).toBe(false);
    expect(s.nextOpenLabel).toBe('hoy a las 11:00');
  });
});
