/**
 * Deterministic store / delivery-hours logic for the agent.
 *
 * The LLM is bad at time math and was promising same-day deliveries at night,
 * so we compute — in code — whether the store can still deliver RIGHT NOW and, if
 * not, when the next delivery window opens. That fact is injected into the agent's
 * system prompt (see ./prompt) so it can never promise a delivery it can't
 * make.
 *
 * SOURCE OF TRUTH for the cutoffs: edit DELIVERY_SCHEDULE below. If you change
 * it, also update the human-readable `envios` text in BOTH places so what the agent
 * *says* matches what it *enforces*: the seed default in
 * server/src/db/migrations/0001_init.sql AND the live `settings.envios` row
 * (editable from the dashboard → Configuración; the seed does not overwrite an
 * existing row).
 */

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

const H = (h: number, m = 0): number => h * 60 + m;

/**
 * Weekly delivery windows as [openMinute, closeMinute) from local midnight.
 * A closeMinute > 1440 crosses past midnight (e.g. 1620 = 03:00 AM next day).
 * `null` = no delivery that weekday. Index 0 = domingo … 6 = sábado.
 */
export type Window = readonly [open: number, close: number];
export const DELIVERY_SCHEDULE: ReadonlyArray<Window | null> = [
  null, // domingo: cerrado
  [H(11), H(17)], // lunes      11:00 → 17:00
  [H(11), H(17)], // martes     11:00 → 17:00
  [H(11), H(17)], // miércoles  11:00 → 17:00
  [H(11), H(17)], // jueves     11:00 → 17:00
  [H(11), H(24 + 3)], // viernes 11:00 → 03:00 (del sábado)
  [H(11), H(24 + 3)], // sábado  11:00 → 03:00 (del domingo)
];

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
  /** 0 = domingo … 6 = sábado */
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

/** Break a Date down into Argentina (UTC-3, no DST) wall-clock parts. */
export function argentinaNow(now: Date): ArNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: AR_TZ,
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
  /** Human label of "now", e.g. "lunes 30/06 19:30". */
  nowLabel: string;
  /** True if the store can deliver same-day right now. */
  open: boolean;
  /** When the current window closes, e.g. "17:00" / "03:00" (only if open). */
  closesAt?: string;
  /** Minutes left before the current window closes (only if open). */
  minutesUntilClose?: number;
  /** When delivery resumes, e.g. "mañana martes a las 11:00" (only if closed). */
  nextOpenLabel?: string;
}

function fmtHM(totalMin: number): string {
  const m = ((totalMin % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Compute the delivery status at `now` (defaults to the real current time). */
export function getStoreStatus(now: Date = new Date()): StoreStatus {
  const ar = argentinaNow(now);
  const mins = ar.hour * 60 + ar.minute;
  const nowLabel = `${WEEKDAYS_ES[ar.weekday]} ${String(ar.day).padStart(2, '0')}/${String(
    ar.month,
  ).padStart(2, '0')} ${fmtHM(mins)}`;

  // 1) Open right now? Check today's window…
  const today = DELIVERY_SCHEDULE[ar.weekday];
  if (today && mins >= today[0] && mins < Math.min(today[1], 1440)) {
    return {
      nowLabel,
      open: true,
      closesAt: fmtHM(today[1]),
      minutesUntilClose: today[1] - mins,
    };
  }
  // …or yesterday's overnight tail (e.g. it's 01:00 Saturday, Friday ran to 03:00).
  const yesterday = DELIVERY_SCHEDULE[(ar.weekday + 6) % 7];
  if (yesterday && yesterday[1] > 1440) {
    const tail = yesterday[1] - 1440;
    if (mins < tail) {
      return { nowLabel, open: true, closesAt: fmtHM(tail), minutesUntilClose: tail - mins };
    }
  }

  // 2) Closed → find the next opening (today later, then the coming days).
  if (today && mins < today[0]) {
    return { nowLabel, open: false, nextOpenLabel: `hoy a las ${fmtHM(today[0])}` };
  }
  for (let d = 1; d <= 7; d += 1) {
    const wd = (ar.weekday + d) % 7;
    const w = DELIVERY_SCHEDULE[wd];
    if (w) {
      const prefix = d === 1 ? 'mañana' : 'el';
      return {
        nowLabel,
        open: false,
        nextOpenLabel: `${prefix} ${WEEKDAYS_ES[wd]} a las ${fmtHM(w[0])}`,
      };
    }
  }
  return { nowLabel, open: false };
}

/** One-line delivery status for the system prompt. */
export function deliveryStatusLine(status: StoreStatus): string {
  if (status.open) {
    // A delivery itself can take up to ~60 min and the cutoff is the *end* of
    // the window, so warn early enough that we don't promise something that
    // can't physically arrive before close.
    const near = (status.minutesUntilClose ?? Infinity) <= 75;
    const base = `🟢 ENVÍOS ABIERTOS: ahora sí estamos dentro del horario de entregas (cierra a las ${status.closesAt}). Podés ofrecer entrega para hoy según la zona del cliente.`;
    return near
      ? `${base} OJO: faltan ~${status.minutesUntilClose} min para el cierre — avisale que quizás no llega a entrar hoy.`
      : base;
  }
  const next = status.nextOpenLabel ? ` El próximo horario de envíos es ${status.nextOpenLabel}.` : '';
  return `🔴 ENVÍOS CERRADOS: ahora NO estamos dentro del horario de entregas. NO prometas entrega para hoy ni "en un rato" ni "ahora".${next}`;
}
