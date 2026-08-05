'use client';

import { useState } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage, type SettingDto } from '@/lib/api';
import { PROVIDERS, PROVIDER_LIST, isProviderId } from '@/lib/providers';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  ProviderFields,
  buildProviderUpdates,
  initProviderValues,
  type ProviderFormValues,
} from '@/components/settings/provider-fields';
import { SecretInput } from '@/components/settings/secret-input';
import { findDto, isReadOnly } from '@/components/settings/settings-form-utils';
import { AdvancedSection } from '@/components/wizard/advanced-section';
import { ChoiceCard } from '@/components/wizard/choice-card';
import { ConnectionState, type ConnectionPhase } from '@/components/wizard/connection-state';
import { StepActions } from '@/components/wizard/wizard-shell';

export function AiStep({
  dtos,
  onNext,
  onSkip,
  onVerified,
}: {
  dtos?: SettingDto[];
  onNext: () => void;
  onSkip: () => void;
  onVerified: (label: string) => void;
}) {
  const { t } = useT();
  const [values, setValues] = useState<ProviderFormValues>(() => initProviderValues(dtos));
  const [phase, setPhase] = useState<ConnectionPhase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const meta = PROVIDERS[values.provider];
  const keyAlreadySet = findDto('llm.api_key', dtos)?.set ?? false;
  const providerLocked = isReadOnly('llm.provider', dtos);

  async function runTest() {
    setPhase('busy');
    setMessage(t.wizard.ai.verifying);
    try {
      const result = await api.testLlm({
        provider: values.provider,
        apiKey: values.apiKey,
        model: values.model || undefined,
        baseUrl: values.baseUrl || undefined,
        // Blank field plus a stored key means "check what is already saved".
        // All-or-nothing on purpose: the server refuses to mix a persisted
        // secret with client-supplied routing.
        useStored: !values.apiKey.trim() && keyAlreadySet,
      });
      if (result.ok) {
        const model = result.model ?? meta.defaultModel;
        setPhase('success');
        setMessage(
          `${interpolate(t.wizard.ai.verified, { model })}${result.vision === false ? ` ${t.wizard.ai.noVision}` : ''}`,
        );
        onVerified(`${meta.label} · ${model}`);
      } else {
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
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDER_LIST.map((provider) => (
          <ChoiceCard
            key={provider.id}
            name="llm-provider"
            value={provider.id}
            checked={values.provider === provider.id}
            disabled={saving || providerLocked}
            onSelect={(value) => isProviderId(value) && setValues({ ...values, provider: value })}
            title={provider.label}
            description={interpolate(t.settings.provider.defaultModelHint, { model: provider.defaultModel })}
            badge={
              provider.supportsVision ? undefined : (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t.settings.provider.visionNo}
                </Badge>
              )
            }
          />
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wizard-llm-key">{t.wizard.ai.keyLabel}</Label>
        <SecretInput
          id="wizard-llm-key"
          value={values.apiKey}
          onChange={(v) => setValues({ ...values, apiKey: v })}
          set={keyAlreadySet}
          readOnly={saving || isReadOnly('llm.api_key', dtos)}
        />
        <p className="text-xs text-muted-foreground">
          {t.wizard.ai.keyHint}{' '}
          <a
            href={meta.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline underline-offset-2"
          >
            {t.wizard.ai.getKeyLink}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => void runTest()}
          disabled={saving || phase === 'busy' || (!values.apiKey.trim() && !keyAlreadySet)}
        >
          {phase === 'busy' ? t.wizard.ai.verifying : t.wizard.ai.verify}
        </Button>
        <ConnectionState phase={phase} message={message} />
      </div>

      <p className="rounded-lg border bg-card p-4 text-xs text-muted-foreground text-pretty">
        {t.wizard.ai.whatIsThis} {t.wizard.ai.costNote}
      </p>

      <AdvancedSection label={t.wizard.ai.advanced}>
        <ProviderFields
          values={values}
          onChange={setValues}
          dtos={dtos}
          disabled={saving}
          hide={['llm.provider', 'llm.api_key', 'test']}
        />
      </AdvancedSection>

      <StepActions onSkip={onSkip} skipLabel={t.wizard.ai.skipLink}>
        <Button onClick={() => void saveAndContinue()} disabled={saving}>
          {saving ? t.common.saving : t.common.next}
        </Button>
      </StepActions>
    </div>
  );
}
