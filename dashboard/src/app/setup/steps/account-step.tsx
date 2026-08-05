'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { api, apiErrorMessage, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const TOKEN_COMMAND = 'docker compose exec -T server printenv SETUP_TOKEN';

export function AccountStep({ onCreated }: { onCreated: () => void }) {
  const { t } = useT();
  const [setupToken, setSetupToken] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [insecure, setInsecure] = useState(false);

  useEffect(() => {
    // Worth saying out loud on the one screen where a password is chosen: an
    // install reachable over plain HTTP from anywhere but this machine is one
    // sniffed cookie away from being someone else's.
    const { protocol, hostname } = window.location;
    setInsecure(protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1');
  }, []);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(TOKEN_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be denied; the command is visible and selectable.
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAlreadyDone(false);
    if (!setupToken) {
      setError(t.wizard.admin.setupTokenRequired);
      return;
    }
    if (password.length < 8) {
      setError(t.wizard.admin.passwordTooShort);
      return;
    }
    if (password !== confirmPassword) {
      setError(t.wizard.admin.passwordMismatch);
      return;
    }
    setSubmitting(true);
    try {
      await api.setupAdmin({ setupToken, name: name.trim(), email: email.trim(), password });
      setSetupToken('');
      onCreated();
    } catch (err) {
      // Coupled to the exact stable code server/src/api/server.ts's POST
      // /api/setup/admin returns on a 409 (setup already completed).
      if (err instanceof ApiError && err.code === 'setup_already_completed') setAlreadyDone(true);
      else setError(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSubmitting(false);
    }
  }

  if (alreadyDone) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">{t.wizard.admin.alreadyDone}</p>
        <Button asChild>
          <Link href="/login">{t.wizard.admin.loginLink}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6" noValidate>
      {insecure && (
        <Alert variant="destructive">
          <AlertDescription>{t.wizard.admin.insecureWarning}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <Label htmlFor="admin-setup-token">{t.wizard.admin.setupTokenLabel}</Label>
        <Input
          id="admin-setup-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
          autoFocus
          required
        />
        <p className="text-xs text-muted-foreground">{t.wizard.admin.setupTokenHint}</p>

        <div className="mt-2 flex flex-col gap-2 border-t pt-3">
          <p className="text-xs font-medium">{t.wizard.admin.whereIsToken}</p>
          <p className="text-xs text-muted-foreground">{t.wizard.admin.tokenDockerHint}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">
              {TOKEN_COMMAND}
            </code>
            <Button type="button" variant="outline" size="icon-sm" onClick={() => void copyCommand()} aria-label={TOKEN_COMMAND}>
              {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.wizard.admin.tokenFileHint}</p>
          <p className="text-xs text-muted-foreground">{t.wizard.admin.tokenOnceHint}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-name">{t.wizard.admin.nameLabel}</Label>
          <Input id="admin-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-email">{t.wizard.admin.emailLabel}</Label>
          <Input
            id="admin-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-password">{t.wizard.admin.passwordLabel}</Label>
          <Input
            id="admin-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">{t.wizard.admin.passwordHint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="admin-confirm">{t.wizard.admin.confirmPasswordLabel}</Label>
          <Input
            id="admin-confirm"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" size="lg" disabled={submitting} className="w-fit">
        {submitting ? t.wizard.admin.submitting : t.wizard.admin.submit}
      </Button>
    </form>
  );
}
