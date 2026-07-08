import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './index';

/**
 * Resolves the dashboard locale for the current request (Server Components /
 * layouts only — uses next/headers). Precedence: `arix_locale` cookie (set
 * by a future language switcher / the Fase 7B setup wizard) wins if present
 * and valid; otherwise sniff Accept-Language (`es*` → es, else → en).
 */
export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;

  const acceptLanguage = (await headers()).get('accept-language') ?? '';
  return /^\s*es/i.test(acceptLanguage) ? 'es' : DEFAULT_LOCALE;
}
