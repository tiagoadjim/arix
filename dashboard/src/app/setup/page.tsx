'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2Icon } from 'lucide-react';
import { api, apiErrorMessage, type SettingDto } from '@/lib/api';
import { setLocaleCookie, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { WhatsAppPanel } from '@/components/settings/whatsapp-panel';
import { findDto, stringValue } from '@/components/settings/settings-form-utils';
import { StepActions, WizardShell, type WizardStepMeta } from '@/components/wizard/wizard-shell';
import { WelcomeStep } from './steps/welcome-step';
import { AccountStep } from './steps/account-step';
import { StoreStep } from './steps/store-step';
import { AiStep } from './steps/ai-step';
import { LearnStep } from './steps/learn-step';
import { ReviewStep, type ReviewSummary } from './steps/review-step';

type Grouped = Record<string, SettingDto[]>;

/** Screens that appear in the rail and are persisted as `setup.step`. Anything
 * outside this list (welcome, done) is not a resumable position. */
const STEPS = ['account', 'store', 'ai', 'learn', 'whatsapp', 'review'] as const;
type StepId = (typeof STEPS)[number];
type Screen = 'welcome' | StepId | 'done';

/** Cookie the "continue later" link sets, read by middleware.ts so postponing
 * the wizard is not immediately undone by the auto-launch redirect. */
const SNOOZE_COOKIE = 'arix_setup_snooze';

export default function SetupPage() {
  return (
    <Suspense fallback={<WizardSkeleton />}>
      <SetupWizard />
    </Suspense>
  );
}

function WizardSkeleton() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="flex w-full max-w-md flex-col gap-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-32 w-full" />
      </div>
    </main>
  );
}

function SetupWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, locale } = useT();

  const [screen, setScreen] = useState<Screen | null>(null);
  const [grouped, setGrouped] = useState<Grouped | null>(null);
  const [uiLanguage, setUiLanguage] = useState<Locale>(locale);
  const [furthest, setFurthest] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [storeSummary, setStoreSummary] = useState<string | null>(null);
  const [knowledgeSummary, setKnowledgeSummary] = useState<string | null>(null);
  const finishedRef = useRef(false);

  // WooCommerce sends the browser back here after the owner approves.
  const wooRequestId = searchParams.get('woo');
  const wooSuccess = searchParams.get('success');

  const loadSettings = useCallback(async (): Promise<Grouped | null> => {
    try {
      const next = await api.settingsGrouped();
      setGrouped(next);
      return next;
    } catch {
      // Non-fatal — every step falls back to schema defaults.
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const status = await api.setupStatus();
        if (!alive) return;
        if (!status.needsSetup && status.setupCompleted) {
          router.replace('/');
          return;
        }
        setWhatsappConnected(status.whatsapp.connected);
        if (status.needsSetup) {
          setScreen('welcome');
          return;
        }
        const settings = await loadSettings();
        if (!alive) return;
        // Resume where they left off. A returning WooCommerce redirect always
        // wins, so the approval round trip lands back on the store screen.
        const resumeIndex = wooRequestId
          ? STEPS.indexOf('store')
          : Math.min(Math.max(status.step - 1, 0), STEPS.length - 1);
        setFurthest(Math.max(resumeIndex, deriveFurthest(settings)));
        setScreen(STEPS[resumeIndex] ?? 'account');
      } catch {
        if (alive) setScreen('welcome'); // fail open into the wizard
      }
    })();
    return () => {
      alive = false;
    };
  }, [router, loadSettings, wooRequestId]);

  /** Persist the resume cursor. Best-effort: losing it costs one extra click,
   * so it must never block navigation or surface an error. */
  const persistStep = useCallback((index: number) => {
    void api.saveSettings([{ key: 'setup.step', value: index + 1 }]).catch(() => {});
  }, []);

  const goTo = useCallback(
    (next: Screen, persist = true) => {
      const index = STEPS.indexOf(next as StepId);
      if (index >= 0) {
        setFurthest((current) => Math.max(current, index));
        if (persist) persistStep(index);
      }
      setScreen(next);
      window.scrollTo({ top: 0 });
    },
    [persistStep],
  );

  const advance = useCallback(
    (from: StepId) => {
      const next = STEPS[STEPS.indexOf(from) + 1];
      goTo(next ?? 'review');
    },
    [goTo],
  );

  function pickLanguage(next: Locale) {
    setUiLanguage(next);
    setLocaleCookie(next);
    router.refresh();
  }

  function continueLater() {
    document.cookie = `${SNOOZE_COOKIE}=1; path=/; max-age=${60 * 60 * 24}; samesite=lax`;
    router.push('/');
  }

  async function finishSetup() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFinishing(true);
    try {
      await api.setupComplete();
      setScreen('done');
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.wizard.finishError));
      finishedRef.current = false;
    } finally {
      setFinishing(false);
    }
  }

  if (screen === null) return <WizardSkeleton />;

  if (screen === 'welcome') {
    return (
      <main id="main-content" tabIndex={-1} className="grid min-h-dvh place-items-center bg-background p-5 pt-[max(1.25rem,var(--safe-top))] pr-[max(1.25rem,var(--safe-right))] pb-[max(1.25rem,var(--safe-bottom))] pl-[max(1.25rem,var(--safe-left))] outline-none">
        <div className="flex w-full max-w-lg flex-col gap-8">
          <Logo markClassName="h-8 w-8 text-primary" />
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-balance">{t.wizard.welcome.title}</h1>
            <p className="text-sm text-muted-foreground text-pretty">{t.wizard.welcome.subtitle}</p>
          </div>
          <WelcomeStep
            uiLanguage={uiLanguage}
            onPickLanguage={pickLanguage}
            // No administrator exists yet, so persisting the resume cursor here
            // would call the protected settings API and misread its 401 as an
            // expired staff session. Persistence starts after account creation.
            onStart={() => goTo('account', false)}
          />
        </div>
      </main>
    );
  }

  if (screen === 'done') {
    return (
      <main id="main-content" tabIndex={-1} className="grid min-h-dvh place-items-center bg-background p-5 pt-[max(1.25rem,var(--safe-top))] pr-[max(1.25rem,var(--safe-right))] pb-[max(1.25rem,var(--safe-bottom))] pl-[max(1.25rem,var(--safe-left))] outline-none">
        <div className="flex max-w-md flex-col items-center gap-5 text-center">
          <CheckCircle2Icon aria-hidden className="size-12 text-success" />
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{t.wizard.done.title}</h1>
            <p className="text-sm text-muted-foreground text-pretty">{t.wizard.done.subtitle}</p>
          </div>
          <Button size="lg" onClick={() => router.push('/')}>
            {t.wizard.done.goToDashboard}
          </Button>
        </div>
      </main>
    );
  }

  const currentIndex = STEPS.indexOf(screen);
  const storeConfigured =
    storeSummary ?? (findDto('wc.consumer_key', grouped?.wc)?.set ? stringValue('wc.url', grouped?.wc) : null);
  const aiConfigured =
    aiSummary ?? (findDto('llm.api_key', grouped?.llm)?.set ? stringValue('llm.provider', grouped?.llm) : null);

  const steps: WizardStepMeta[] = [
    { id: 'account', label: t.wizard.nav.account, status: undefined },
    { id: 'store', label: t.wizard.nav.store, status: storeConfigured ?? undefined },
    { id: 'ai', label: t.wizard.nav.ai, status: aiConfigured ?? undefined },
    { id: 'learn', label: t.wizard.nav.learn, status: knowledgeSummary ?? undefined },
    { id: 'whatsapp', label: t.wizard.nav.whatsapp, status: whatsappConnected ? t.wizard.review.configured : undefined },
    { id: 'review', label: t.wizard.nav.review, status: undefined },
  ];

  const summary: ReviewSummary = {
    store: storeConfigured,
    ai: aiConfigured,
    knowledge: knowledgeSummary,
    whatsapp: whatsappConnected,
  };

  const titles: Record<StepId, { title: string; subtitle: string }> = {
    account: { title: t.wizard.admin.title, subtitle: t.wizard.admin.subtitle },
    store: { title: t.wizard.store.title, subtitle: t.wizard.store.subtitle },
    ai: { title: t.wizard.ai.title, subtitle: t.wizard.ai.subtitle },
    learn: { title: t.wizard.learn.title, subtitle: t.wizard.learn.subtitle },
    whatsapp: { title: t.wizard.whatsapp.title, subtitle: t.wizard.whatsapp.subtitle },
    review: { title: t.wizard.review.title, subtitle: t.wizard.review.subtitle },
  };

  return (
    <WizardShell
      steps={steps}
      currentIndex={currentIndex}
      furthestIndex={furthest}
      onNavigate={(index) => {
        const target = STEPS[index];
        if (target) goTo(target);
      }}
      onContinueLater={screen === 'account' ? undefined : continueLater}
      title={titles[screen].title}
      subtitle={titles[screen].subtitle}
    >
      {screen === 'account' && (
        <AccountStep
          onCreated={() => {
            void loadSettings();
            goTo('store');
          }}
        />
      )}

      {screen === 'store' && (
        <StoreStep
          wc={grouped?.wc}
          payment={grouped?.payment}
          returnedRequestId={wooRequestId ?? undefined}
          returnedSuccess={wooSuccess === null ? undefined : wooSuccess === '1'}
          onConnected={(base) => {
            setStoreSummary(base);
            void loadSettings();
          }}
          onNext={() => advance('store')}
          onSkip={() => advance('store')}
        />
      )}

      {screen === 'ai' && (
        <AiStep
          dtos={grouped?.llm}
          onVerified={setAiSummary}
          onNext={() => advance('ai')}
          onSkip={() => advance('ai')}
        />
      )}

      {screen === 'learn' && (
        <LearnStep
          grouped={grouped}
          storeUrl={storeConfigured ?? stringValue('wc.url', grouped?.wc)}
          llmConfigured={Boolean(aiSummary) || (findDto('llm.api_key', grouped?.llm)?.set ?? false)}
          onApplied={(count) => setKnowledgeSummary(count > 0 ? String(count) : null)}
          onSettingsChanged={() => void loadSettings()}
          onNext={() => advance('learn')}
          onSkip={() => advance('learn')}
        />
      )}

      {screen === 'whatsapp' && (
        <div className="flex flex-col gap-6">
          <WhatsAppPanel
            onConnected={() => {
              setWhatsappConnected(true);
              advance('whatsapp');
            }}
          />
          <StepActions onSkip={() => advance('whatsapp')} skipLabel={t.wizard.whatsapp.skipLink}>
            <Button onClick={() => advance('whatsapp')}>{t.common.next}</Button>
          </StepActions>
        </div>
      )}

      {screen === 'review' && (
        <ReviewStep summary={summary} finishing={finishing} onFinish={() => void finishSetup()} />
      )}
    </WizardShell>
  );
}

/**
 * Where an install that predates the resume cursor should pick up.
 *
 * Without this an upgrade mid-onboarding would always restart at the first
 * screen, asking someone to redo work the settings already show as done.
 */
function deriveFurthest(settings: Grouped | null): number {
  if (!settings) return 0;
  let index = 0;
  if (findDto('wc.consumer_key', settings.wc)?.set) index = Math.max(index, STEPS.indexOf('ai'));
  if (findDto('llm.api_key', settings.llm)?.set) index = Math.max(index, STEPS.indexOf('learn'));
  return index;
}
