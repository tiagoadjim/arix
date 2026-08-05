'use client';

import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ConnectionPhase = 'idle' | 'busy' | 'success' | 'error';

/**
 * One inline strip for every "is this connected yet?" question in the wizard.
 *
 * Deliberately inline rather than a toast: the person is looking straight at
 * the field they just filled in, and a message that disappears on its own is
 * the wrong shape for "your key does not work".
 */
export function ConnectionState({
  phase,
  message,
  className,
}: {
  phase: ConnectionPhase;
  message: string | null;
  className?: string;
}) {
  if (phase === 'idle' || !message) return null;

  const Icon = phase === 'busy' ? Loader2Icon : phase === 'success' ? CheckCircle2Icon : AlertCircleIcon;

  return (
    <p
      role={phase === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        phase === 'success' && 'border-success/40 bg-success/10 text-foreground',
        phase === 'error' && 'border-destructive/40 bg-destructive/10 text-foreground',
        phase === 'busy' && 'border-border bg-muted/50 text-muted-foreground',
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          phase === 'success' && 'text-success',
          phase === 'error' && 'text-destructive',
          phase === 'busy' && 'animate-spin',
        )}
      />
      <span className="min-w-0 text-pretty">{message}</span>
    </p>
  );
}
