'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * Everything technical, folded away.
 *
 * The wizard's whole premise is that a shop owner should never have to read the
 * word "endpoint" to finish setup. The fields still exist — an operator who
 * knows what a base URL is can open this and get the same dense form Settings
 * shows — they just stop being the first thing anyone sees.
 */
export function AdvancedSection({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card/40">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-accent/40">
        <span>{label}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-4 py-5">{children}</CollapsibleContent>
    </Collapsible>
  );
}
