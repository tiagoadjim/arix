'use client';

import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { InboxList } from './inbox-list';

/**
 * Master/detail shell: phones show either the inbox or the active route,
 * while tablets and desktops retain the two-pane workflow. `minmax(0, 1fr)`
 * is essential here so long messages cannot force the detail pane offscreen.
 */
export function PanelShell({ children, canManageSettings }: { children: React.ReactNode; canManageSettings: boolean }) {
  const pathname = usePathname();
  const hasDetail = pathname !== '/';

  return (
    <div className="grid h-dvh min-h-0 bg-background md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
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
  );
}
