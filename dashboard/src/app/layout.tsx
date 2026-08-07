import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { I18nProvider } from '@/lib/i18n/provider';
import { dictionaries } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import './globals.css';

export const metadata: Metadata = {
  title: 'Arix',
  description: 'Operations console for the Arix WhatsApp AI sales agent.',
};

/**
 * `viewportFit: 'cover'` is what makes every `env(safe-area-inset-*)` in the
 * stylesheet resolve to a real number — without it iOS reports zero and the
 * composer sits under the home indicator.
 *
 * `interactiveWidget: 'resizes-content'` asks Android to shrink the layout
 * viewport when the software keyboard opens, so `dvh` units stay honest.
 * iOS ignores it, which is why `useAppHeight` mirrors VisualViewport instead.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'oklch(0.985 0.003 260)' },
    { media: '(prefers-color-scheme: dark)', color: 'oklch(0.145 0.006 260)' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    <html lang={locale} className={GeistSans.variable} suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
          <I18nProvider locale={locale}>
            <a href="#main-content" className="skip-link">
              {dictionaries[locale].common.skipToContent}
            </a>
            {children}
            <Toaster richColors position="top-right" />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
