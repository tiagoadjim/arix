'use client';

import type { ReactNode } from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Logo } from '@/components/logo';
import { Progress } from '@/components/ui/progress';

export interface WizardStepMeta {
  id: string;
  label: string;
  /** One line of live state, e.g. "MiniMax · verified" or "Skipped". */
  status?: string | undefined;
}

interface WizardShellProps {
  steps: WizardStepMeta[];
  /** Index into `steps`, or -1 for screens outside the numbered flow. */
  currentIndex: number;
  /** Furthest step reached — everything up to here is navigable. */
  furthestIndex: number;
  onNavigate?: (index: number) => void;
  onContinueLater?: (() => void) | undefined;
  title: string;
  subtitle?: string;
  /** Optional right-hand column explaining why this screen asks what it asks. */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * Chrome for the first-run wizard: a step rail on the left, the work in the
 * middle, and an optional context column on the right.
 *
 * The rail is the point. A shop owner needs to see how much is left, what is
 * already done, and that nothing here is a one-way door — a progress bar alone
 * communicates none of that.
 */
export function WizardShell({
  steps,
  currentIndex,
  furthestIndex,
  onNavigate,
  onContinueLater,
  title,
  subtitle,
  aside,
  children,
}: WizardShellProps) {
  const { t } = useT();
  const numbered = currentIndex >= 0;

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="hidden border-r bg-card/40 p-6 lg:flex lg:flex-col lg:gap-8">
        <Logo markClassName="h-7 w-7 text-primary" />
        <nav aria-label={title}>
          <ol className="flex flex-col gap-1">
            {steps.map((step, index) => {
              const done = index < furthestIndex;
              const active = index === currentIndex;
              const reachable = index <= furthestIndex;
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => reachable && onNavigate?.(index)}
                    disabled={!reachable}
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors',
                      reachable ? 'hover:bg-accent/50' : 'cursor-default opacity-45',
                      active && 'bg-accent/60',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold',
                        done && 'border-success bg-success text-success-foreground',
                        active && !done && 'border-primary bg-primary text-primary-foreground',
                        !done && !active && 'border-border text-muted-foreground',
                      )}
                    >
                      {done ? <CheckIcon className="size-3" /> : index + 1}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className={cn('text-sm', active ? 'font-medium' : 'text-muted-foreground')}>
                        {step.label}
                      </span>
                      {step.status && (
                        <span className="truncate text-xs text-muted-foreground">{step.status}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        {onContinueLater && (
          <button
            type="button"
            onClick={onContinueLater}
            className="mt-auto self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t.wizard.continueLater}
          </button>
        )}
      </aside>

      <div className="flex min-h-dvh flex-col">
        {/* Compact rail replacement below lg — same information, one line. */}
        <div className="flex items-center gap-3 border-b px-4 py-3 lg:hidden">
          <Logo markClassName="h-6 w-6 text-primary" />
          {numbered && (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Progress value={((currentIndex + 1) / steps.length) * 100} />
              <p className="truncate text-xs text-muted-foreground">
                {interpolate(t.wizard.stepProgress, { n: currentIndex + 1, total: steps.length })} ·{' '}
                {steps[currentIndex]?.label}
              </p>
            </div>
          )}
        </div>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 outline-none xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-10 xl:px-10"
        >
          <div className="mx-auto w-full max-w-2xl px-5 py-10 xl:px-0">
            <header className="mb-8 flex flex-col gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
              {subtitle && <p className="text-sm text-muted-foreground text-pretty">{subtitle}</p>}
            </header>
            {children}
          </div>
          {aside && (
            <div className="hidden py-10 xl:block">
              <div className="sticky top-10 flex flex-col gap-4 rounded-xl border bg-card/50 p-5 text-sm">
                {aside}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/** Bottom action row shared by every step: skip on the left, primary on the right. */
export function StepActions({
  onSkip,
  skipLabel,
  children,
}: {
  onSkip?: (() => void) | undefined;
  skipLabel?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t pt-6">
      {onSkip && skipLabel ? (
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {skipLabel}
        </button>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
