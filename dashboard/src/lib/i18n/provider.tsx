'use client';

import * as React from 'react';
import { dictionaries, DEFAULT_LOCALE, type Dictionary, type Locale } from './index';

interface I18nContextValue {
  locale: Locale;
  t: Dictionary;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

/** Provides the server-resolved locale + its dictionary to the whole client tree. */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = React.useMemo<I18nContextValue>(
    () => ({ locale, t: dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE] }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const { t, locale } = useT();` — `t` is the active nested dictionary. */
export function useT(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error('useT() must be used within <I18nProvider>');
  return ctx;
}
