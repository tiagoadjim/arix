'use client';

import { CheckCircle2Icon, CircleDashedIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ReviewSummary {
  store: string | null;
  ai: string | null;
  knowledge: string | null;
  whatsapp: boolean;
}

/**
 * The last screen before Arix goes live. Its job is to tell the truth about
 * what is and is not set up — a shop owner who skipped WhatsApp should leave
 * this screen knowing it, not discover it when nobody answers.
 */
export function ReviewStep({
  summary,
  finishing,
  onFinish,
}: {
  summary: ReviewSummary;
  finishing: boolean;
  onFinish: () => void;
}) {
  const { t } = useT();

  const rows: Array<{ label: string; value: string | null }> = [
    { label: t.wizard.review.storeRow, value: summary.store },
    { label: t.wizard.review.aiRow, value: summary.ai },
    { label: t.wizard.review.knowledgeRow, value: summary.knowledge },
    { label: t.wizard.review.whatsappRow, value: summary.whatsapp ? t.wizard.review.configured : null },
    { label: t.wizard.review.abilitiesRow, value: t.wizard.review.abilitiesValue },
  ];

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const done = Boolean(row.value);
          return (
            <li key={row.label} className="flex items-start gap-3 rounded-lg border bg-card p-4">
              {done ? (
                <CheckCircle2Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
              ) : (
                <CircleDashedIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{row.label}</span>
                <span className={cn('text-xs text-pretty', done ? 'text-muted-foreground' : 'text-warning')}>
                  {row.value ?? t.wizard.review.pending}
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">{t.wizard.review.settingsHint}</p>

      <Button size="lg" className="w-fit" onClick={onFinish} disabled={finishing}>
        {finishing ? t.wizard.review.finishing : t.wizard.review.finish}
      </Button>
    </div>
  );
}
