'use client';

import type { ReactNode } from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A selectable card. Used for the assistant picker, where a `<select>` would
 * hide exactly the information that makes the choice possible — what each
 * option costs you and whether it can read a photo of a bank transfer.
 *
 * Built on a native radio input so keyboard and screen-reader behaviour is the
 * platform's, not ours.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onSelect,
  title,
  description,
  badge,
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: (value: string) => void;
  title: string;
  description?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'relative flex cursor-pointer flex-col gap-1 rounded-lg border p-4 transition-colors',
        checked ? 'border-primary bg-accent/40 ring-1 ring-primary/40' : 'hover:border-foreground/25 hover:bg-accent/20',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="sr-only"
      />
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {checked ? (
          <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
        ) : (
          badge
        )}
      </span>
      {description && <span className="text-xs text-muted-foreground text-pretty">{description}</span>}
    </label>
  );
}
