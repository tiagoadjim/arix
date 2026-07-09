'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCircle2Icon } from 'lucide-react';
import { api, apiErrorMessage, ApiError, type SettingDto } from '@/lib/api';
import { interpolate, setLocaleCookie, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Logo } from '@/components/logo';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ProviderFields,
  buildProviderUpdates,
  initProviderValues,
  type ProviderFormValues,
} from '@/components/settings/provider-fields';
import { StoreFields, buildStoreUpdates, initStoreValues, type StoreFormValues } from '@/components/settings/store-fields';
import {
  BusinessFields,
  buildBusinessUpdates,
  initBusinessValues,
  type BusinessFormValues,
} from '@/components/settings/business-fields';
import { WhatsAppPanel } from '@/components/settings/whatsapp-panel';

type Grouped = Record<string, SettingDto[]>;
type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const TOTAL_STEPS = 6;

/** Full-screen onboarding wizard, outside the `(panel)` route group (no
 * sidebar). Re-entry: if a session already exists (`needsSetup === false`)
 * we resume at step 3 with a fresh settingsGrouped() fetch — steps 1-2 are
 * done, and steps 3-6 are otherwise client-state-only (a mid-wizard refresh
 * drops back to step 3, matching middleware.ts's gating contract). */
export default function SetupPage() {
  const router = useRouter();
  const { t, locale } = useT();
  const [step, setStep] = useState<Step | null>(null);
  const [grouped, setGrouped] = useState<Grouped | null>(null);
  const [uiLanguage, setUiLanguage] = useState<Locale>(locale);
  const finishedRef = useRef(false);

  async function enterConfigSteps() {
    try {
      setGrouped(await api.settingsGrouped());
    } catch {
      // Non-fatal — every Fields component falls back to schema defaults.
    }
    setStep(3);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await api.setupStatus();
        if (!alive) return;
        if (!status.needsSetup && status.setupCompleted) {
          router.replace('/');
          return;
        }
        if (!status.needsSetup) {
          await enterConfigSteps();
        } else {
          setStep(1);
        }
      } catch {
        if (alive) setStep(1); // fail open to the start of the wizard
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  function pickLanguage(next: Locale) {
    setUiLanguage(next);
    setLocaleCookie(next);
    router.refresh();
    setStep(2);
  }

  async function finishSetup() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    try {
      await api.setupComplete();
      setStep(7);
    } catch {
      toast.error(t.wizard.finishError);
      finishedRef.current = false;
    }
  }

  if (step === null) {
    return (
      <WizardChrome>
        <div className="flex flex-col items-center gap-3 py-6">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
      </WizardChrome>
    );
  }

  if (step === 7) {
    return (
      <WizardChrome>
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <CheckCircle2Icon className="size-12 text-success" />
          <div>
            <h1 className="text-lg font-semibold">{t.wizard.done.title}</h1>
            <p className="text-sm text-muted-foreground">{t.wizard.done.subtitle}</p>
          </div>
          <Button onClick={() => router.push('/')}>{t.wizard.done.goToDashboard}</Button>
        </div>
      </WizardChrome>
    );
  }

  const titles: Record<Exclude<Step, 7>, { title: string; subtitle?: string }> = {
    1: { title: t.wizard.welcome.title, subtitle: t.wizard.welcome.subtitle },
    2: { title: t.wizard.admin.title, subtitle: t.wizard.admin.subtitle },
    3: { title: t.wizard.provider.title, subtitle: t.wizard.provider.subtitle },
    4: { title: t.wizard.store.title, subtitle: t.wizard.store.subtitle },
    5: { title: t.wizard.business.title, subtitle: t.wizard.business.subtitle },
    6: { title: t.wizard.whatsapp.title, subtitle: t.wizard.whatsapp.subtitle },
  };

  return (
    <WizardChrome step={step} title={titles[step].title} subtitle={titles[step].subtitle}>
      {step === 1 && <WelcomeStep uiLanguage={uiLanguage} onPick={pickLanguage} />}
      {step === 2 && <AdminStep onCreated={() => void enterConfigSteps()} />}
      {step === 3 && (
        <ProviderStep dtos={grouped?.llm} onNext={() => setStep(4)} onSkip={() => setStep(4)} />
      )}
      {step === 4 && (
        <StoreStep wc={grouped?.wc} payment={grouped?.payment} onNext={() => setStep(5)} onSkip={() => setStep(5)} />
      )}
      {step === 5 && (
        <BusinessStep
          grouped={grouped}
          uiLanguage={uiLanguage}
          onUiLanguageChange={setUiLanguage}
          onNext={() => setStep(6)}
        />
      )}
      {step === 6 && <WhatsAppStep onConnected={() => void finishSetup()} onSkip={() => void finishSetup()} />}
    </WizardChrome>
  );
}

function WizardChrome({
  step,
  title,
  subtitle,
  children,
}: {
  step?: Step;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-xl">
        <CardHeader className="flex flex-col items-center gap-3 text-center">
          <Logo markClassName="h-8 w-8 text-primary" />
          {step && step <= TOTAL_STEPS && (
            <div className="flex w-full flex-col gap-1.5">
              <Progress value={(step / TOTAL_STEPS) * 100} />
              <p className="text-xs text-muted-foreground">{interpolate(t.wizard.stepProgress, { n: step, total: TOTAL_STEPS })}</p>
            </div>
          )}
          {title && (
            <div>
              <h1 className="text-lg font-semibold">{title}</h1>
              {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
            </div>
          )}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

function WelcomeStep({ uiLanguage, onPick }: { uiLanguage: Locale; onPick: (locale: Locale) => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm font-medium">{t.wizard.welcome.languagePrompt}</p>
      <div className="flex gap-3">
        <Button variant={uiLanguage === 'es' ? 'default' : 'outline'} onClick={() => onPick('es')}>
          Español
        </Button>
        <Button variant={uiLanguage === 'en' ? 'default' : 'outline'} onClick={() => onPick('en')}>
          English
        </Button>
      </div>
    </div>
  );
}

function AdminStep({ onCreated }: { onCreated: () => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAlreadyDone(false);
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
      await api.setupAdmin({ name: name.trim(), email: email.trim(), password });
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
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">{t.wizard.admin.alreadyDone}</p>
        <Button asChild>
          <Link href="/login">{t.wizard.admin.loginLink}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="admin-name">{t.wizard.admin.nameLabel}</Label>
        <Input id="admin-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="admin-email">{t.wizard.admin.emailLabel}</Label>
        <Input id="admin-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
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
      <p className="-mt-2 text-xs text-muted-foreground">{t.wizard.admin.passwordHint}</p>
      <Button type="submit" disabled={submitting}>
        {submitting ? t.wizard.admin.submitting : t.wizard.admin.submit}
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}

function SkipLink({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function ProviderStep({ dtos, onNext, onSkip }: { dtos?: SettingDto[]; onNext: () => void; onSkip: () => void }) {
  const { t } = useT();
  const [values, setValues] = useState<ProviderFormValues>(() => initProviderValues(dtos));
  const [saving, setSaving] = useState(false);

  async function handleNext() {
    setSaving(true);
    try {
      const updates = buildProviderUpdates(values, dtos);
      if (updates.length > 0) await api.saveSettings(updates);
      onNext();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <ProviderFields values={values} onChange={setValues} dtos={dtos} disabled={saving} />
      <div className="flex items-center justify-between">
        <SkipLink onClick={onSkip} disabled={saving}>
          {t.wizard.provider.skipLink}
        </SkipLink>
        <Button onClick={() => void handleNext()} disabled={saving}>
          {saving ? t.common.saving : t.common.next}
        </Button>
      </div>
    </div>
  );
}

function StoreStep({
  wc,
  payment,
  onNext,
  onSkip,
}: {
  wc?: SettingDto[];
  payment?: SettingDto[];
  onNext: () => void;
  onSkip: () => void;
}) {
  const { t } = useT();
  const [values, setValues] = useState<StoreFormValues>(() => initStoreValues(wc, payment));
  const [saving, setSaving] = useState(false);

  async function handleNext() {
    setSaving(true);
    try {
      const updates = buildStoreUpdates(values, wc, payment);
      if (updates.length > 0) await api.saveSettings(updates);
      onNext();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <StoreFields values={values} onChange={setValues} wc={wc} disabled={saving} />
      <div className="flex items-center justify-between">
        <SkipLink onClick={onSkip} disabled={saving}>
          {t.wizard.store.skipLink}
        </SkipLink>
        <Button onClick={() => void handleNext()} disabled={saving}>
          {saving ? t.common.saving : t.common.next}
        </Button>
      </div>
    </div>
  );
}

function BusinessStep({
  grouped,
  uiLanguage,
  onUiLanguageChange,
  onNext,
}: {
  grouped: Grouped | null;
  uiLanguage: Locale;
  onUiLanguageChange: (locale: Locale) => void;
  onNext: () => void;
}) {
  const { t, locale } = useT();
  const router = useRouter();
  const dtos = {
    business: grouped?.business,
    agent: grouped?.agent,
    info: grouped?.info,
    dispatch: grouped?.dispatch,
    compliance: grouped?.compliance,
  };
  const [values, setValues] = useState<BusinessFormValues>(() => initBusinessValues(dtos));
  const [saving, setSaving] = useState(false);

  async function handleNext() {
    setSaving(true);
    try {
      const updates = buildBusinessUpdates(values, dtos);
      if (updates.length > 0) await api.saveSettings(updates);
      if (uiLanguage !== locale) {
        // Soft refresh (not a hard reload) — keeps the wizard's step state so
        // step 6 renders immediately in the newly-picked language.
        setLocaleCookie(uiLanguage);
        router.refresh();
      }
      onNext();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <BusinessFields
        values={values}
        onChange={setValues}
        uiLanguage={uiLanguage}
        onUiLanguageChange={onUiLanguageChange}
        disabled={saving}
      />
      <Button onClick={() => void handleNext()} disabled={saving} className="w-fit self-end">
        {saving ? t.common.saving : t.common.next}
      </Button>
    </div>
  );
}

function WhatsAppStep({ onConnected, onSkip }: { onConnected: () => void; onSkip: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center gap-4">
      <WhatsAppPanel onConnected={onConnected} />
      <SkipLink onClick={onSkip}>{t.wizard.whatsapp.skipLink}</SkipLink>
    </div>
  );
}
