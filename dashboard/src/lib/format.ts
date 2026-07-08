import type { Locale } from './i18n';

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * Locale-aware relative time ("5m ago" / "hace 5 min"…), replacing the old
 * hardcoded-Spanish `timeAgo()`. Anything under 10s renders as `nowLabel`
 * (the caller's already-localized `t.time.now`) instead of "0m"/"in 0 seconds".
 */
export function timeAgo(iso: string | null, locale: Locale, nowLabel: string): string {
  if (!iso) return '';
  let duration = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Math.abs(duration) < 10) return nowLabel;

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(-duration), division.unit);
    }
    duration /= division.amount;
  }
  return '';
}

const DATE_LOCALE: Record<Locale, string> = { es: 'es-AR', en: 'en-US' };

export function formatClockTime(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(DATE_LOCALE[locale], { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(DATE_LOCALE[locale]);
}
