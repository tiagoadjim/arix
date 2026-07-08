'use client';

import { useState } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n/provider';

interface SecretInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Whether the server already has a non-empty value stored for this key
   * (independent of `value`, which is always blank until the user types a
   * replacement — secrets never arrive in plaintext from the API). */
  set: boolean;
  readOnly?: boolean;
  autoComplete?: string;
}

/** Masked input for a secret setting (API keys, consumer secrets…). Typing a
 * new value replaces the stored secret on save; leaving it blank keeps the
 * current one — the placeholder communicates which state you're in. */
export function SecretInput({ id, value, onChange, set, readOnly, autoComplete }: SecretInputProps) {
  const { t } = useT();
  const [reveal, setReveal] = useState(false);

  return (
    <div className="flex gap-1.5">
      <Input
        id={id}
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={set ? t.settings.secretSetPlaceholder : t.settings.secretUnsetPlaceholder}
        disabled={readOnly}
        autoComplete={autoComplete ?? 'off'}
        spellCheck={false}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setReveal((r) => !r)}
        disabled={readOnly}
        aria-label={reveal ? t.settings.hideSecretAria : t.settings.showSecretAria}
      >
        {reveal ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </Button>
    </div>
  );
}
