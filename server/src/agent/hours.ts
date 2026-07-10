/**
 * Deterministic store / delivery-hours engine for the agent.
 *
 * The LLM is bad at time math and was promising same-day deliveries at night,
 * so we compute — in code — whether the store can still deliver RIGHT NOW and, if
 * not, when the next delivery window opens. That fact is injected into the agent's
 * system prompt (see ./prompt) so it can never promise a delivery it can't
 * make.
 *
 * This module is a pure engine: the schedule, timezone and language are
 * parameters, never module-level constants. The runtime config service
 * (server/src/config/runtime.ts) resolves the actual `business.hours` /
 * `business.timezone` / `agent.language` settings and passes them in here —
 * that's the single source of truth an operator edits from the dashboard.
 * `DEFAULT_DELIVERY_SCHEDULE` / `AR_TZ` below are only the seed default.
 */

/** Weekly delivery window as [openMinute, closeMinute) from local midnight.
 * A closeMinute > 1440 crosses past midnight (e.g. 1620 = 03:00 AM next day). */
export type Window = readonly [open: number, close: number];

/** `null` = no delivery that weekday. Index 0 = Sunday … 6 = Saturday (length 7). */
export type Schedule = ReadonlyArray<Window | null>;

export type Language = 'es' | 'en';

export const AR_TZ = 'America/Argentina/Buenos_Aires';

/** 0 = domingo … 6 = sábado. */
export const WEEKDAYS_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/** 0 = Sunday … 6 = Saturday — same index order as WEEKDAYS_ES. */
export const WEEKDAYS_EN = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const WEEKDAYS: Record<Language, readonly string[]> = { es: WEEKDAYS_ES, en: WEEKDAYS_EN };

const H = (h: number, m = 0): number => h * 60 + m;

/**
 * Seed default for the `business.hours` setting — a placeholder schedule
 * kept as the out-of-the-box behavior until a deployment configures its own
 * from the dashboard. Editable there; this constant is only the fallback.
 */
export const DEFAULT_DELIVERY_SCHEDULE: Schedule = [
  null, // domingo: cerrado
  [H(11), H(17)], // lunes      11:00 → 17:00
  [H(11), H(17)], // martes     11:00 → 17:00
  [H(11), H(17)], // miércoles  11:00 → 17:00
  [H(11), H(17)], // jueves     11:00 → 17:00
  [H(11), H(24 + 3)], // viernes 11:00 → 03:00 (del sábado)
  [H(11), H(24 + 3)], // sábado  11:00 → 03:00 (del domingo)
];

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function isValidSchedule(value: unknown): value is Schedule {
  if (!Array.isArray(value) || value.length !== 7) return false;
  return value.every((window) => {
    if (window === null) return true;
    if (!Array.isArray(window) || window.length !== 2) return false;
    const [open, close] = window;
    return (
      Number.isInteger(open) &&
      Number.isInteger(close) &&
      open >= 0 &&
      open < 1440 &&
      close > open &&
      close <= 2880
    );
  });
}

export interface ArNow {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WD_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Break a Date down into wall-clock parts for the given IANA timezone. */
export function nowInTimezone(now: Date, timezone: string): ArNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // some runtimes emit '24' at local midnight
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WD_INDEX[get('weekday')] ?? 0,
  };
}

export interface StoreStatus {
  /** Human label of "now", e.g. "lunes 30/06 19:30" / "Monday 06/30 19:30". */
  nowLabel: string;
  /** True if the store can deliver same-day right now. */
  open: boolean;
  /** When the current window closes, e.g. "17:00" / "03:00" (only if open). */
  closesAt?: string;
  /** Minutes left before the current window closes (only if open). */
  minutesUntilClose?: number;
  /** When delivery resumes, localized (only if closed). */
  nextOpenLabel?: string;
}

function fmtHM(totalMin: number): string {
  const m = ((totalMin % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function nextOpenLabel(language: Language, daysAhead: number, weekday: number, openMinute: number): string {
  const wd = WEEKDAYS[language][weekday];
  const at = fmtHM(openMinute);
  if (daysAhead === 0) return language === 'en' ? `today at ${at}` : `hoy a las ${at}`;
  if (daysAhead === 1) return language === 'en' ? `tomorrow ${wd} at ${at}` : `mañana ${wd} a las ${at}`;
  return language === 'en' ? `on ${wd} at ${at}` : `el ${wd} a las ${at}`;
}

/** Compute the delivery status at `now`, given the store's schedule/timezone/language. */
export function getStoreStatus(
  now: Date,
  schedule: Schedule,
  timezone: string,
  language: Language = 'es',
): StoreStatus {
  const ar = nowInTimezone(now, timezone);
  const mins = ar.hour * 60 + ar.minute;
  const wd = WEEKDAYS[language];
  const nowLabel = `${wd[ar.weekday]} ${String(ar.day).padStart(2, '0')}/${String(
    ar.month,
  ).padStart(2, '0')} ${fmtHM(mins)}`;

  // 1) Open right now? Check today's window…
  const today = schedule[ar.weekday];
  if (today && mins >= today[0] && mins < Math.min(today[1], 1440)) {
    return {
      nowLabel,
      open: true,
      closesAt: fmtHM(today[1]),
      minutesUntilClose: today[1] - mins,
    };
  }
  // …or yesterday's overnight tail (e.g. it's 01:00 Saturday, Friday ran to 03:00).
  const yesterday = schedule[(ar.weekday + 6) % 7];
  if (yesterday && yesterday[1] > 1440) {
    const tail = yesterday[1] - 1440;
    if (mins < tail) {
      return { nowLabel, open: true, closesAt: fmtHM(tail), minutesUntilClose: tail - mins };
    }
  }

  // 2) Closed → find the next opening (today later, then the coming days).
  if (today && mins < today[0]) {
    return { nowLabel, open: false, nextOpenLabel: nextOpenLabel(language, 0, ar.weekday, today[0]) };
  }
  for (let d = 1; d <= 7; d += 1) {
    const wdIdx = (ar.weekday + d) % 7;
    const w = schedule[wdIdx];
    if (w) {
      return { nowLabel, open: false, nextOpenLabel: nextOpenLabel(language, d, wdIdx, w[0]) };
    }
  }
  return { nowLabel, open: false };
}

const LINES = {
  es: {
    open: (closesAt: string) =>
      `🟢 ENVÍOS ABIERTOS: ahora sí estamos dentro del horario de entregas (cierra a las ${closesAt}). Podés ofrecer entrega para hoy según la zona del cliente.`,
    nearClose: (min: number) =>
      ` OJO: faltan ~${min} min para el cierre — avisale que quizás no llega a entrar hoy.`,
    closed:
      '🔴 ENVÍOS CERRADOS: ahora NO estamos dentro del horario de entregas. NO prometas entrega para hoy ni "en un rato" ni "ahora".',
    nextWindow: (label: string) => ` El próximo horario de envíos es ${label}.`,
  },
  en: {
    open: (closesAt: string) =>
      `🟢 DELIVERIES OPEN: we're inside the delivery window right now (closes at ${closesAt}). You can offer same-day delivery depending on the customer's area.`,
    nearClose: (min: number) =>
      ` HEADS UP: only ~${min} min left before closing — let the customer know it might not make it in today.`,
    closed:
      "🔴 DELIVERIES CLOSED: we're NOT inside the delivery window right now. Do NOT promise delivery today, \"shortly\", or \"now\".",
    nextWindow: (label: string) => ` The next delivery window is ${label}.`,
  },
} as const satisfies Record<Language, unknown>;

/** One-line delivery status for the system prompt, localized. */
export function deliveryStatusLine(status: StoreStatus, language: Language = 'es'): string {
  const copy = LINES[language];
  if (status.open) {
    // A delivery itself can take up to ~60 min and the cutoff is the *end* of
    // the window, so warn early enough that we don't promise something that
    // can't physically arrive before close.
    const near = (status.minutesUntilClose ?? Infinity) <= 75;
    const base = copy.open(status.closesAt ?? '');
    return near ? `${base}${copy.nearClose(status.minutesUntilClose ?? 0)}` : base;
  }
  const next = status.nextOpenLabel ? copy.nextWindow(status.nextOpenLabel) : '';
  return `${copy.closed}${next}`;
}
