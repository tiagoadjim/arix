'use client';

import { Logo } from '@/components/logo';
import { useT } from '@/lib/i18n/provider';

export default function PanelHome() {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <Logo markClassName="h-10 w-10 text-muted-foreground/40" className="text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{t.panelHome.hint}</p>
    </div>
  );
}
