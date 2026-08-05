'use client';

import { useState } from 'react';
import { AlertTriangleIcon, PencilIcon } from 'lucide-react';
import type { ProposedField } from '@/lib/api';
import type { Dictionary } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { minutesToHHMM, type Schedule } from '@/lib/hours';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';

/** Settings key → the plain-language name a shop owner would use for it. */
export function proposalLabel(key: string, t: Dictionary): string {
  const labels: Record<string, string> = {
    'business.name': t.wizard.learn.fields.businessName,
    'business.timezone': t.wizard.learn.fields.timezone,
    'business.hours': t.wizard.learn.fields.hours,
    'wc.currency': t.wizard.learn.fields.currency,
    'info.payment': t.wizard.learn.fields.payment,
    'info.shipping': t.wizard.learn.fields.shipping,
    'info.general': t.wizard.learn.fields.general,
    'compliance.rules': t.wizard.learn.fields.compliance,
  };
  return labels[key] ?? key;
}

/** `business.hours` is the one non-text proposal — render it as a week, not JSON. */
export function formatValue(value: ProposedField['value'], weekdays: readonly string[]): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  const schedule = value as unknown as Schedule;
  return schedule
    .map((window, index) =>
      window ? `${weekdays[index]} ${minutesToHHMM(window[0])}–${minutesToHHMM(window[1])}` : null,
    )
    .filter(Boolean)
    .join('\n');
}

export interface ProposalDecision {
  accepted: boolean;
  /** Present only when the reviewer edited the suggestion. */
  editedValue?: string;
}

/**
 * One suggestion, beside what is configured today.
 *
 * The checkbox starts unchecked, always. This row is the containment boundary
 * for everything the scan read off an untrusted website: a person has to look
 * at the text and decide, and warnings are shown next to the value rather than
 * used to silently drop it — the reviewer needs to see what the site actually
 * said in order to judge it.
 */
export function ProposalRow({
  field,
  currentValue,
  decision,
  onChange,
}: {
  field: ProposedField;
  currentValue: string;
  decision: ProposalDecision;
  onChange: (decision: ProposalDecision) => void;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const isText = typeof field.value === 'string';
  const suggested = decision.editedValue ?? formatValue(field.value, t.time.weekdays);
  const inputId = `proposal-${field.key.replace(/\./g, '-')}`;

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex items-start gap-3 p-4">
        <Checkbox
          id={inputId}
          checked={decision.accepted}
          onCheckedChange={(checked) => onChange({ ...decision, accepted: checked === true })}
          className="mt-1"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label htmlFor={inputId} className="cursor-pointer text-sm font-medium">
            {proposalLabel(field.key, t)}
          </label>

          {field.warnings.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
              {field.warnings.map((warning) => (
                <p key={warning} className="flex items-start gap-2 text-xs text-pretty">
                  <AlertTriangleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  {warning === 'looks_like_instructions'
                    ? t.wizard.learn.warningInstructions
                    : t.wizard.learn.warningUngrounded}
                </p>
              ))}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t.wizard.learn.current}</span>
              <p className="max-h-32 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap text-muted-foreground">
                {currentValue.trim() || t.wizard.learn.empty}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-primary">{t.wizard.learn.suggested}</span>
              {editing && isText ? (
                <Textarea
                  rows={6}
                  value={suggested}
                  onChange={(e) => onChange({ ...decision, editedValue: e.target.value })}
                  className="text-xs"
                />
              ) : (
                <p
                  className={cn(
                    'max-h-32 overflow-y-auto rounded-md border-l-2 border-primary bg-accent/30 px-3 py-2 text-xs whitespace-pre-wrap',
                  )}
                >
                  {suggested}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {isText && (
              <Button type="button" variant="ghost" size="xs" onClick={() => setEditing((v) => !v)}>
                <PencilIcon aria-hidden className="size-3" />
                {editing ? t.wizard.learn.doneEditing : t.wizard.learn.edit}
              </Button>
            )}
            {field.sources.length > 0 && (
              <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t.wizard.learn.sources}</span>
                {field.sources.map((source) => (
                  <a
                    key={source}
                    href={source}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="max-w-52 truncate underline underline-offset-2 hover:text-foreground"
                  >
                    {sourcePath(source)}
                  </a>
                ))}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function sourcePath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.hostname : parsed.pathname;
  } catch {
    return url;
  }
}
