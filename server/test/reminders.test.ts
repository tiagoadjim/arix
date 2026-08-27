import { describe, it, expect } from 'vitest';
import { planReminders } from '../src/reminders/schedule';
import { buildReminderMessage, DEFAULT_REMINDER_TEMPLATES } from '../src/reminders/templates';
import { reminderClientId } from '../src/reminders/dispatcher';
import { isWithinSchedule } from '../src/agent/slots';
import type { Schedule } from '../src/agent/hours';
import type { ReminderSettings } from '../src/config/runtime';

const AR = 'America/Argentina/Buenos_Aires';
const SCHEDULE: Schedule = [
  null,
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [540, 1020],
  [600, 840],
];

const SETTINGS: ReminderSettings = {
  enabled: true,
  hoursBefore: 3,
  dayBeforeHour: 18,
  kinds: ['booked', 'day_before', 'hours_before'],
  templates: { booked: '', day_before: '', hours_before: '' },
};

function plan(over: Partial<Parameters<typeof planReminders>[0]> = {}) {
  return planReminders({
    // Friday 2026-03-13, 12:00 local.
    startsAt: new Date('2026-03-13T15:00:00Z'),
    // Wednesday 2026-03-11, 10:00 local.
    now: new Date('2026-03-11T13:00:00Z'),
    settings: SETTINGS,
    schedule: SCHEDULE,
    timezone: AR,
    ...over,
  });
}

describe('planReminders', () => {
  it('plans nothing at all while the operator has reminders off', () => {
    // The kill switch has to be absolute: not "planned but not sent".
    expect(plan({ settings: { ...SETTINGS, enabled: false } })).toEqual([]);
  });

  it('plans only the kinds the operator asked for', () => {
    const planned = plan({ settings: { ...SETTINGS, kinds: ['day_before'] } });
    expect(planned.map((p) => p.kind)).toEqual(['day_before']);
  });

  it('puts the day-before reminder at the configured local hour', () => {
    // A business open into the evening, so 18:00 is a time it can actually
    // send at. Not "24 hours minus epsilon", which would fire at whatever
    // hour the appointment happens to sit at.
    const evening: Schedule = [null, [540, 1200], [540, 1200], [540, 1200], [540, 1200], [540, 1200], [600, 840]];
    const [dayBefore] = plan({
      schedule: evening,
      settings: { ...SETTINGS, kinds: ['day_before'] },
    });
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: AR,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(dayBefore.sendAt);
    expect(local).toContain('Thu');
    expect(local).toContain('18:00');
  });

  it('defers the configured hour into opening hours when the business is shut then', () => {
    // Default day_before_hour is 18:00, but this business closes at 17:00 —
    // a common combination. The reminder must move forward into hours, not
    // go out after closing.
    const [dayBefore] = plan({ settings: { ...SETTINGS, kinds: ['day_before'] } });
    expect(isWithinSchedule(dayBefore.sendAt, SCHEDULE, AR)).toBe(true);
    expect(dayBefore.sendAt.getTime()).toBeLessThan(new Date('2026-03-13T15:00:00Z').getTime());
  });

  it('never schedules a reminder after the appointment it is about', () => {
    for (const p of plan()) {
      expect(p.sendAt.getTime()).toBeLessThan(new Date('2026-03-13T15:00:00Z').getTime());
    }
  });

  it('never schedules one in the past', () => {
    const now = new Date('2026-03-11T13:00:00Z');
    for (const p of plan({ now })) {
      expect(p.sendAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
  });

  it('keeps every planned send inside opening hours', () => {
    // A reminder is not worth waking someone at 3am for.
    for (const p of plan()) {
      expect(isWithinSchedule(p.sendAt, SCHEDULE, AR)).toBe(true);
    }
  });

  it('moves a would-be small-hours reminder to the next opening', () => {
    // Appointment Monday 10:00 local; the day-before hour lands on Sunday,
    // when this business is shut.
    const planned = planReminders({
      startsAt: new Date('2026-03-16T13:00:00Z'),
      now: new Date('2026-03-13T13:00:00Z'),
      settings: { ...SETTINGS, kinds: ['day_before'] },
      schedule: SCHEDULE,
      timezone: AR,
    });

    expect(planned).toHaveLength(1);
    expect(isWithinSchedule(planned[0].sendAt, SCHEDULE, AR)).toBe(true);
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: AR, weekday: 'short' }).format(
      planned[0].sendAt,
    );
    expect(weekday).not.toBe('Sun');
  });

  it('drops a reminder with no usable moment left rather than sending it late', () => {
    // Booked for two hours from now: there is no "day before" left to use.
    const planned = planReminders({
      startsAt: new Date('2026-03-11T15:00:00Z'),
      now: new Date('2026-03-11T13:00:00Z'),
      settings: { ...SETTINGS, kinds: ['day_before'] },
      schedule: SCHEDULE,
      timezone: AR,
    });
    expect(planned).toEqual([]);
  });

  it('plans nothing when the business has no opening hours configured', () => {
    const never: Schedule = [null, null, null, null, null, null, null];
    expect(plan({ schedule: never })).toEqual([]);
  });
});

describe('reminder copy', () => {
  it('fills every placeholder', () => {
    const body = buildReminderMessage(
      '{business}: {service} el {date} a las {time}',
      { service: 'corte', date: 'jueves 12/03', time: '15:00', business: 'Peluqueria' },
    );
    expect(body).toBe('Peluqueria: corte el jueves 12/03 a las 15:00');
    expect(body).not.toContain('{');
  });

  it('leaves an unknown placeholder visible instead of blanking it', () => {
    // A typo in an operator's template should be obvious, not silent.
    expect(buildReminderMessage('hola {nombre}', {
      service: 'x', date: 'y', time: 'z', business: 'b',
    })).toBe('hola {nombre}');
  });

  it('ships defaults for every kind in both languages', () => {
    for (const lang of ['es', 'en'] as const) {
      for (const kind of ['booked', 'day_before', 'hours_before'] as const) {
        expect(DEFAULT_REMINDER_TEMPLATES[lang][kind].trim().length).toBeGreaterThan(20);
      }
    }
  });

  it('always identifies the appointment, so it can never read as a cold message', () => {
    for (const lang of ['es', 'en'] as const) {
      for (const kind of ['booked', 'day_before', 'hours_before'] as const) {
        expect(DEFAULT_REMINDER_TEMPLATES[lang][kind]).toContain('{service}');
        expect(DEFAULT_REMINDER_TEMPLATES[lang][kind]).toContain('{time}');
      }
    }
  });

  it('offers a way out in the reminder that asks for something', () => {
    // The day-before reminder asks the customer to confirm, so it must also
    // tell them how to say no.
    expect(DEFAULT_REMINDER_TEMPLATES.es.day_before.toLowerCase()).toContain('reprogram');
    expect(DEFAULT_REMINDER_TEMPLATES.en.day_before.toLowerCase()).toContain('reschedule');
  });
});

describe('reminderClientId', () => {
  it('is derived from the reminder id, which is what makes a resend a no-op', () => {
    expect(reminderClientId('abc')).toBe('reminder:abc');
    expect(reminderClientId('abc')).toBe(reminderClientId('abc'));
    expect(reminderClientId('abc')).not.toBe(reminderClientId('abd'));
  });

  it('does not collide with the agent outbox namespace', () => {
    // getRecoverableAgentOutbox matches `client_id like 'agent:%'`; a reminder
    // must stay invisible to it so the two recovery loops never fight.
    expect(reminderClientId('x').startsWith('agent:')).toBe(false);
  });
});
