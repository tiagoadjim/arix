import type { ReminderKind } from '../config/runtime';

/**
 * Default reminder copy, per language and kind.
 *
 * Deliberately short, transactional and un-salesy: a reminder that reads like
 * marketing is exactly what gets a number reported, and the whole feature
 * depends on not looking like a blast. Every one of them names the business
 * and the appointment so it can never read as an unsolicited message.
 */
export const DEFAULT_REMINDER_TEMPLATES: Record<'es' | 'en', Record<ReminderKind, string>> = {
  es: {
    booked:
      '¡Listo! Te agendé {service} para el {date} a las {time} 🙌\n\nSi no podés venir, avisame por acá y lo cambiamos.',
    day_before:
      '¡Hola! Te recuerdo tu turno de {service} mañana {date} a las {time} en {business} 🙂\n\n¿Confirmás que venís? Si no podés, decime y lo reprogramamos.',
    hours_before:
      'Te espero hoy a las {time} para tu turno de {service} 👋\n\nSi surgió algo, avisame por acá.',
  },
  en: {
    booked:
      "You're booked: {service} on {date} at {time} 🙌\n\nIf you can't make it, just message me here and we'll move it.",
    day_before:
      'Hi! Reminder about your {service} appointment tomorrow, {date} at {time} at {business} 🙂\n\nCan you confirm? If not, tell me and we can reschedule.',
    hours_before:
      "See you today at {time} for your {service} appointment 👋\n\nIf something came up, just message me here.",
  },
};

/** Fill a reminder template. Unknown placeholders are left alone rather than
 * blanked, so a typo in an operator's template is visible instead of silent. */
export function buildReminderMessage(
  template: string,
  vars: { service: string; date: string; time: string; business: string },
): string {
  return template
    .replace(/\{service\}/g, vars.service)
    .replace(/\{date\}/g, vars.date)
    .replace(/\{time\}/g, vars.time)
    .replace(/\{business\}/g, vars.business);
}
