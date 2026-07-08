import { es } from './es';
import { en } from './en';

export type Locale = 'es' | 'en';

/** Typed nested dictionary shape — every locale file must satisfy this exactly. */
export interface Dictionary {
  common: {
    save: string;
    cancel: string;
    retry: string;
    loading: string;
    error: string;
  };
  login: {
    title: string;
    subtitle: string;
    emailLabel: string;
    passwordLabel: string;
    submit: string;
    submitting: string;
    errorGeneric: string;
  };
  sidebar: {
    filterAll: string;
    filterHuman: string;
    filterUnread: string;
    /** e.g. "3 unread" / "3 sin leer" — used as a compact suffix, not a full sentence. */
    unread: string;
    emptyList: string;
    fetchError: string;
    muteOnTooltip: string;
    muteOffTooltip: string;
    muteOnAria: string;
    muteOffAria: string;
    agentsNav: string;
    settingsNav: string;
    signOut: string;
    modeHuman: string;
    themeToLight: string;
    themeToDark: string;
  };
  panelHome: {
    hint: string;
  };
  time: {
    now: string;
  };
}

export const dictionaries: Record<Locale, Dictionary> = { es, en };

/** Ultimate fallback when there's no cookie and no (or non-Spanish) Accept-Language. */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'arix_locale';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'es' || value === 'en';
}
