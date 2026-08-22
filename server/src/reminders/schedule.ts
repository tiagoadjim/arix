import type { ReminderKind, ReminderSettings } from '../config/runtime';
import type { Schedule } from '../agent/hours';
import { nextTimeWithinSchedule, zonedWallTimeToUtc } from '../agent/slots';
import { nowInTimezone } from '../agent/hours';

/**
 * When each reminder for an appointment should go out.
 *
 * Pure, so the awkward cases — an appointment booked for tomorrow morning at
 * 11pm tonight, a day-before reminder that would land while the business is
 * shut — are testable without a clock or a database.
 */

export interface PlannedReminder {
  kind: ReminderKind;
  sendAt: Date;
}

export interface PlanOptions {
  startsAt: Date;
  now: Date;
  settings: ReminderSettings;
  schedule: Schedule;
  timezone: string;
}

export function planReminders(options: PlanOptions): PlannedReminder[] {
  const { startsAt, now, settings, schedule, timezone } = options;
  if (!settings.enabled) return [];

  const planned: PlannedReminder[] = [];

  for (const kind of settings.kinds) {
    const at = sendTimeFor(kind, options);
    if (!at) continue;

    // Never after the appointment it is reminding about — a "reminder"
    // arriving afterwards is just spam.
    if (at >= startsAt) continue;

    // 'booked' means "now" by definition. Every other kind names a moment
    // relative to the appointment, and once that moment is gone there is
    // nothing useful left to say: pulling a day-before reminder forward to
    // today would send "see you tomorrow" about an appointment that is in two
    // hours. Drop it instead.
    if (kind !== 'booked' && at < now) continue;

    // A reminder that lands while the business is closed is deferred to the
    // next opening, not sent at 3am. Deferral only ever moves it FORWARD; if
    // that pushes it past the appointment, no useful moment is left.
    const quietSafe = nextTimeWithinSchedule(at, schedule, timezone);
    if (!quietSafe || quietSafe >= startsAt) continue;

    planned.push({ kind, sendAt: quietSafe });
  }

  return planned;
}

function sendTimeFor(kind: ReminderKind, options: PlanOptions): Date | null {
  const { startsAt, now, settings, timezone } = options;

  switch (kind) {
    case 'booked':
      return now;
    case 'hours_before':
      return new Date(startsAt.getTime() - settings.hoursBefore * 3_600_000);
    case 'day_before': {
      // The day before, at the configured local hour — not "24 hours minus
      // epsilon", which would fire at whatever time of night the appointment
      // happens to be at.
      const local = nowInTimezone(startsAt, timezone);
      const previousDay = new Date(
        Date.UTC(local.year, local.month - 1, local.day) - 86_400_000,
      );
      return zonedWallTimeToUtc(
        {
          year: previousDay.getUTCFullYear(),
          month: previousDay.getUTCMonth() + 1,
          day: previousDay.getUTCDate(),
          hour: settings.dayBeforeHour,
          minute: 0,
        },
        timezone,
      );
    }
    default:
      return null;
  }
}
