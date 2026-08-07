'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n/provider';
import { useAppHeight } from '@/hooks/useAppHeight';
import { InboxList } from './inbox-list';

/**
 * Master/detail shell: phones show either the inbox or the active route,
 * while tablets and desktops retain the two-pane workflow. `minmax(0, 1fr)`
 * is essential here so long messages cannot force the detail pane offscreen.
 *
 * The sidebar widens in steps rather than jumping straight to its desktop
 * size: a tablet in portrait is only 768px across, and a 300px rail there
 * would leave the conversation itself too narrow to read comfortably.
 */
export function PanelShell({
  children,
  canManageSettings,
  setupUnfinished,
}: {
  children: React.ReactNode;
  canManageSettings: boolean;
  setupUnfinished?: boolean;
}) {
  const pathname = usePathname();
  const { t } = useT();
  const hasDetail = pathname !== '/';

  useAppHeight();

  // A column rather than a two-row grid: the resume banner is conditional, and
  // a fixed `auto minmax(0,1fr)` template put the whole console in the `auto`
  // row whenever the banner was absent, leaving it sized to its own content
  // with dead space underneath instead of filling the screen.
  //
  // The safe-area padding lives on the shell rather than on each pane, so a
  // notched phone held sideways insets the whole console at once.
  return (
    <div className="flex h-[var(--app-height)] min-h-0 flex-col bg-background pt-[var(--safe-top)] pr-[var(--safe-right)] pl-[var(--safe-left)]">
      {/* An administrator who postponed the wizard still needs a way back into
          it — the auto-launch redirect only fires on the root path. */}
      {setupUnfinished && (
        <Link
          href="/setup"
          className="flex shrink-0 items-center justify-center gap-x-2 gap-y-0.5 bg-primary px-4 py-2 text-center text-xs font-medium text-primary-foreground max-sm:flex-col hover:brightness-110"
        >
          {t.wizard.resumeBanner}
          <span className="inline-flex items-center gap-1 underline underline-offset-2">
            {t.wizard.resumeBannerCta}
            <ArrowRightIcon aria-hidden className="size-3" />
          </span>
        </Link>
      )}
      {/* The single-column phone case needs `minmax(0, …)` just as much as the
          two-pane one: a grid item defaults to `min-width: auto`, so without it
          the settings tab strip widens the column and scrolls the whole
          console sideways instead of scrolling within itself. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
        <div
          id={hasDetail ? undefined : 'main-content'}
          tabIndex={hasDetail ? undefined : -1}
          className={cn('min-h-0 outline-none md:block', hasDetail ? 'hidden' : 'block')}
        >
          <InboxList canManageSettings={canManageSettings} />
        </div>
        <main
          id={hasDetail ? 'main-content' : undefined}
          tabIndex={hasDetail ? -1 : undefined}
          className={cn('min-h-0 flex-col outline-none md:flex', hasDetail ? 'flex' : 'hidden')}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
