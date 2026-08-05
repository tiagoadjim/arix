'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  apiErrorMessage,
  type SettingDto,
  type WooConnectResult,
} from '@/lib/api';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { StoreFields, buildStoreUpdates, initStoreValues, type StoreFormValues } from '@/components/settings/store-fields';
import { stringValue } from '@/components/settings/settings-form-utils';
import { AdvancedSection } from '@/components/wizard/advanced-section';
import { ConnectionState, type ConnectionPhase } from '@/components/wizard/connection-state';
import { StepActions } from '@/components/wizard/wizard-shell';

/** WooCommerce shows both halves of a key on one screen and people copy the
 * whole block, so parse rather than demand two precisely-separated fields. */
export function extractWooKeys(pasted: string): { consumerKey?: string; consumerSecret?: string } {
  const text = pasted.slice(0, 8_192);
  const consumerKey = /\bck_[A-Za-z0-9]{20,128}\b/.exec(text)?.[0];
  const consumerSecret = /\bcs_[A-Za-z0-9]{20,128}\b/.exec(text)?.[0];
  return {
    ...(consumerKey ? { consumerKey } : {}),
    ...(consumerSecret ? { consumerSecret } : {}),
  };
}

/** How long to wait for the store to deliver the keys after the owner approves. */
const DELIVERY_POLL_MS = 2_000;
const DELIVERY_TIMEOUT_MS = 45_000;

type Panel = 'url' | 'oauth' | 'manual' | 'env_locked';

export function StoreStep({
  wc,
  payment,
  returnedRequestId,
  returnedSuccess,
  onNext,
  onSkip,
  onConnected,
}: {
  wc?: SettingDto[];
  payment?: SettingDto[];
  /** Set when WooCommerce just redirected the browser back to the wizard. */
  returnedRequestId?: string | undefined;
  returnedSuccess?: boolean | undefined;
  onNext: () => void;
  onSkip: () => void;
  onConnected: (storeBase: string) => void;
}) {
  const { t } = useT();
  const [url, setUrl] = useState(() => stringValue('wc.url', wc));
  const [panel, setPanel] = useState<Panel>('url');
  const [connect, setConnect] = useState<WooConnectResult | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [values, setValues] = useState<StoreFormValues>(() => initStoreValues(wc, payment));
  const [pasted, setPasted] = useState('');
  const [saving, setSaving] = useState(false);
  const claimedRef = useRef(false);

  const storeBase = connect?.storeBase ?? url;

  const finishConnected = useCallback(
    (base: string, sampleProductName?: string | null) => {
      setPhase('success');
      setMessage(
        sampleProductName
          ? interpolate(t.wizard.store.connectedWithProduct, { name: sampleProductName })
          : t.wizard.store.connected,
      );
      onConnected(base);
    },
    [onConnected, t],
  );

  // The polling loop below must survive re-renders, and its own first action is
  // to set state. Reading the changing values through a ref keeps the effect's
  // dependency list down to the redirect itself — depend on `finishConnected`
  // (whose identity changes every render, since the parent passes an inline
  // callback) and the cleanup would tear the loop down the moment it started.
  const latest = useRef({ finishConnected, url, t });
  latest.current = { finishConnected, url, t };

  // Coming back from the store's approval screen. WooCommerce delivers the
  // credentials to the server before redirecting the browser, but that delivery
  // can fail silently — a store that cannot reach us — so this polls for a
  // bounded window and then falls back to the manual flow.
  useEffect(() => {
    if (!returnedRequestId || claimedRef.current) return;
    claimedRef.current = true;

    if (returnedSuccess === false) {
      setPanel('manual');
      setPhase('error');
      setMessage(latest.current.t.wizard.store.oauthDeclined);
      return;
    }

    let alive = true;
    const startedAt = Date.now();
    setPanel('oauth');
    setPhase('busy');
    setMessage(latest.current.t.wizard.store.oauthWaiting);

    const giveUp = (message: string) => {
      setPanel('manual');
      setPhase('error');
      setMessage(message);
    };

    const tick = async (): Promise<void> => {
      if (!alive) return;
      const { t: copy, url: currentUrl, finishConnected: finish } = latest.current;
      try {
        const { status } = await api.wooAuthStatus(returnedRequestId);
        if (!alive) return;
        if (status === 'delivered') {
          const claim = await api.wooClaim(returnedRequestId);
          if (!alive) return;
          if (claim.ok) finish(claim.storeBase ?? currentUrl, claim.sampleProductName);
          else giveUp(claim.error ?? copy.common.error);
          return;
        }
        if (status === 'connected') {
          finish(currentUrl);
          return;
        }
        if (status === 'expired' || Date.now() - startedAt > DELIVERY_TIMEOUT_MS) {
          giveUp(copy.wizard.store.oauthTimeout);
          return;
        }
      } catch {
        giveUp(copy.wizard.store.oauthTimeout);
        return;
      }
      setTimeout(() => void tick(), DELIVERY_POLL_MS);
    };
    void tick();

    return () => {
      alive = false;
    };
  }, [returnedRequestId, returnedSuccess]);

  async function runConnect() {
    setPhase('busy');
    setMessage(t.wizard.store.checking);
    try {
      const result = await api.wooConnect(url);
      setConnect(result);
      setUrl(result.storeBase);
      if (result.mode === 'env_locked') {
        setPanel('env_locked');
        setPhase('idle');
        setMessage(null);
        return;
      }
      if (result.probe && !result.probe.reachable) {
        setPhase('error');
        setMessage(t.wizard.store.notFound);
        return;
      }
      if (result.probe && result.probe.wordpress && !result.probe.woocommerce) {
        setPhase('error');
        setMessage(t.wizard.store.noWoo);
        return;
      }
      if (result.mode === 'oauth') {
        setPanel('oauth');
        setPhase('success');
        setMessage(
          result.probe?.name ? interpolate(t.wizard.store.foundStore, { name: result.probe.name }) : null,
        );
        return;
      }
      setPanel('manual');
      setPhase('idle');
      setMessage(null);
    } catch (err) {
      setPhase('error');
      setMessage(apiErrorMessage(err, t, t.common.error));
    }
  }

  async function runTest() {
    setPhase('busy');
    setMessage(null);
    try {
      const result = await api.testWoo({
        url: storeBase,
        consumerKey: values.consumerKey,
        consumerSecret: values.consumerSecret,
      });
      if (result.ok) finishConnected(storeBase, result.sampleProductName);
      else {
        setPhase('error');
        setMessage(result.error ?? t.common.error);
      }
    } catch (err) {
      setPhase('error');
      setMessage(apiErrorMessage(err, t, t.common.error));
    }
  }

  async function saveAndContinue() {
    setSaving(true);
    try {
      const updates = buildStoreUpdates({ ...values, url: storeBase }, wc, payment);
      if (updates.length > 0) await api.saveSettings(updates);
      onNext();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  function applyPaste(text: string) {
    setPasted(text);
    const found = extractWooKeys(text);
    if (found.consumerKey || found.consumerSecret) {
      setValues((current) => ({ ...current, ...found }));
    }
  }

  const pasteFeedback = pasted.trim()
    ? values.consumerKey && values.consumerSecret
      ? t.wizard.store.pasteDetected
      : t.wizard.store.pasteMissing
    : null;

  return (
    <div className="flex flex-col gap-6">
      {panel !== 'env_locked' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="store-url">{t.wizard.store.urlLabel}</Label>
          <div className="flex gap-2">
            <Input
              id="store-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t.wizard.store.urlPlaceholder}
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              disabled={phase === 'busy'}
            />
            <Button type="button" onClick={() => void runConnect()} disabled={!url.trim() || phase === 'busy'}>
              {t.wizard.store.connect}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t.wizard.store.urlHint}</p>
        </div>
      )}

      <ConnectionState phase={phase} message={message} />

      {panel === 'env_locked' && (
        <Alert>
          <AlertDescription>{t.wizard.store.envLocked}</AlertDescription>
        </Alert>
      )}

      {panel === 'oauth' && connect?.authorizeUrl && phase !== 'busy' && (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold">{t.wizard.store.oauthTitle}</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            {interpolate(t.wizard.store.oauthBody, { store: hostOf(connect.storeBase) })}
          </p>
          <Button
            type="button"
            size="lg"
            className="w-fit"
            /* Top-level navigation, never a cross-origin <form>: next.config.mjs
               sets form-action 'self', which would block the submit outright. */
            onClick={() => window.location.assign(connect.authorizeUrl!)}
          >
            {t.wizard.store.oauthCta}
          </Button>
          <button
            type="button"
            onClick={() => setPanel('manual')}
            className="w-fit text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t.wizard.store.manualPreferred}
          </button>
        </div>
      )}

      {panel === 'manual' && connect && (
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-sm font-semibold">{t.wizard.store.manualTitle}</h2>
            {connect.reason === 'plain_permalinks' ? (
              <p className="text-sm text-muted-foreground text-pretty">{t.wizard.store.manualPlainPermalinks}</p>
            ) : (
              <p className="text-sm text-muted-foreground text-pretty">{t.wizard.store.manualNoPublicHttps}</p>
            )}
          </div>

          <Button asChild variant="outline" className="w-fit">
            <a href={connect.createKeyUrl} target="_blank" rel="noreferrer noopener">
              {t.wizard.store.openKeysPage}
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          </Button>

          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
            <li>{t.wizard.store.manualStep1}</li>
            <li>{t.wizard.store.manualStep2}</li>
            <li className="text-foreground">{t.wizard.store.manualStep3}</li>
            <li>{t.wizard.store.manualStep4}</li>
          </ol>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="store-paste">{t.wizard.store.pasteLabel}</Label>
            <Textarea
              id="store-paste"
              rows={4}
              value={pasted}
              spellCheck={false}
              placeholder={t.wizard.store.pastePlaceholder}
              onChange={(e) => applyPaste(e.target.value)}
            />
            {pasteFeedback && <p className="text-xs text-muted-foreground">{pasteFeedback}</p>}
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-fit"
            onClick={() => void runTest()}
            disabled={!values.consumerKey || !values.consumerSecret || phase === 'busy'}
          >
            {phase === 'busy' ? t.common.testing : t.wizard.store.testCta}
          </Button>
        </div>
      )}

      <AdvancedSection label={t.wizard.store.advanced}>
        <StoreFields
          values={values}
          onChange={setValues}
          wc={wc}
          payment={payment}
          disabled={saving}
          hide={['wc.url', 'wc.consumer_key', 'wc.consumer_secret', 'test']}
        />
      </AdvancedSection>

      <StepActions onSkip={onSkip} skipLabel={t.wizard.store.skipLink}>
        <Button onClick={() => void saveAndContinue()} disabled={saving}>
          {saving ? t.common.saving : t.common.next}
        </Button>
      </StepActions>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
