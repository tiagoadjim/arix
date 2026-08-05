'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ExternalLinkIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/provider';
import { interpolate } from '@/lib/i18n';
import { api, type SettingDto, type SettingsUpdate } from '@/lib/api';
import { PROVIDER_LIST, PROVIDERS, isProviderId, type ProviderId } from '@/lib/providers';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SecretInput } from './secret-input';
import {
  booleanValue,
  compactUpdates,
  findDto,
  isReadOnly,
  numberBounds,
  numberValue,
  plainUpdate,
  secretUpdate,
  stringValue,
} from './settings-form-utils';

export interface ProviderFormValues {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string;
  reasoningSplit: boolean;
  thinkingDisabled: boolean;
  visionFallback: 'ask_details' | 'handoff';
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export function initProviderValues(dtos: SettingDto[] | undefined): ProviderFormValues {
  const providerRaw = stringValue('llm.provider', dtos, 'minimax');
  const visionFallbackRaw = stringValue('llm.vision_fallback', dtos, 'ask_details');
  return {
    provider: isProviderId(providerRaw) ? providerRaw : 'minimax',
    apiKey: '', // secrets never arrive in plaintext — blank means "unchanged"
    model: stringValue('llm.model', dtos),
    baseUrl: stringValue('llm.base_url', dtos),
    reasoningSplit: booleanValue('llm.reasoning_split', dtos),
    thinkingDisabled: booleanValue('llm.thinking_disabled', dtos),
    visionFallback: visionFallbackRaw === 'handoff' ? 'handoff' : 'ask_details',
    inputCostPerMillion: numberValue('llm.input_cost_per_million', dtos),
    outputCostPerMillion: numberValue('llm.output_cost_per_million', dtos),
  };
}

export function buildProviderUpdates(values: ProviderFormValues, dtos: SettingDto[] | undefined): SettingsUpdate[] {
  return compactUpdates([
    plainUpdate('llm.provider', values.provider, dtos),
    secretUpdate('llm.api_key', values.apiKey, dtos),
    plainUpdate('llm.model', values.model, dtos),
    plainUpdate('llm.base_url', values.baseUrl, dtos),
    plainUpdate('llm.reasoning_split', values.reasoningSplit, dtos),
    plainUpdate('llm.thinking_disabled', values.thinkingDisabled, dtos),
    plainUpdate('llm.vision_fallback', values.visionFallback, dtos),
    plainUpdate('llm.input_cost_per_million', values.inputCostPerMillion, dtos),
    plainUpdate('llm.output_cost_per_million', values.outputCostPerMillion, dtos),
  ]);
}

interface ProviderFieldsProps {
  values: ProviderFormValues;
  onChange: (values: ProviderFormValues) => void;
  dtos?: SettingDto[];
  disabled?: boolean;
  /**
   * Settings keys to leave out, plus the pseudo-key `'test'` for the connection
   * tester. The setup wizard owns the provider choice and the API key with its
   * own plain-language surface and renders the rest of this form inside an
   * "Advanced" disclosure; omitting nothing (the default) keeps the settings
   * page byte-identical.
   */
  hide?: readonly string[];
}

/** AI provider fields + "Test connection" — shared between the settings
 * "AI Provider" tab and the setup wizard's assistant step. */
export function ProviderFields({ values, onChange, dtos, disabled, hide }: ProviderFieldsProps) {
  const { t } = useT();
  const hidden = (key: string) => hide?.includes(key) ?? false;
  const [testState, setTestState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  const meta = PROVIDERS[values.provider];
  const inputCostBounds = numberBounds('llm.input_cost_per_million', dtos, { min: 0 });
  const outputCostBounds = numberBounds('llm.output_cost_per_million', dtos, { min: 0 });

  function set<K extends keyof ProviderFormValues>(key: K, value: ProviderFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  async function runTest() {
    setTestState('loading');
    setTestError(null);
    try {
      const useStored =
        !values.apiKey.trim() &&
        Boolean(findDto('llm.api_key', dtos)?.set) &&
        values.provider === stringValue('llm.provider', dtos, 'minimax') &&
        values.model === stringValue('llm.model', dtos) &&
        values.baseUrl === stringValue('llm.base_url', dtos);
      const result = await api.testLlm({
        provider: values.provider,
        apiKey: values.apiKey,
        model: values.model || undefined,
        baseUrl: values.baseUrl || undefined,
        useStored,
      });
      if (result.ok) {
        setTestState('success');
        toast.success(interpolate(t.settings.provider.testSuccessToast, { model: result.model ?? meta.defaultModel }), {
          description: result.vision ? t.settings.provider.visionYes : t.settings.provider.visionNo,
        });
      } else {
        setTestState('error');
        setTestError(result.error ?? t.common.error);
      }
    } catch (err) {
      setTestState('error');
      setTestError(err instanceof Error ? err.message : t.common.error);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {!hidden('llm.provider') && (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="llm-provider" className="justify-between">
          <span>{t.settings.provider.providerLabel}</span>
          {isReadOnly('llm.provider', dtos) && <Badge variant="outline">{t.common.envLockedBadge}</Badge>}
        </Label>
        <Select
          value={values.provider}
          onValueChange={(v) => isProviderId(v) && set('provider', v)}
          disabled={disabled || isReadOnly('llm.provider', dtos)}
        >
          <SelectTrigger id="llm-provider" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_LIST.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {interpolate(t.settings.provider.defaultModelHint, { model: meta.defaultModel })}
          {' · '}
          <a
            href={meta.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2"
          >
            {t.settings.provider.docsLinkLabel}
            <ExternalLinkIcon className="size-3" />
          </a>
        </p>
      </div>
      )}

      {!hidden('llm.api_key') && (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="llm-api-key" className="justify-between">
          <span>{t.settings.provider.apiKeyLabel}</span>
          {isReadOnly('llm.api_key', dtos) && <Badge variant="outline">{t.common.envLockedBadge}</Badge>}
        </Label>
        <SecretInput
          id="llm-api-key"
          value={values.apiKey}
          onChange={(v) => set('apiKey', v)}
          set={findDto('llm.api_key', dtos)?.set ?? false}
          readOnly={disabled || isReadOnly('llm.api_key', dtos)}
        />
      </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="llm-model">{t.settings.provider.modelLabel}</Label>
          <Input
            id="llm-model"
            value={values.model}
            onChange={(e) => set('model', e.target.value)}
            placeholder={interpolate(t.settings.provider.modelPlaceholderHint, { model: meta.defaultModel })}
            disabled={disabled || isReadOnly('llm.model', dtos)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="llm-vision-fallback">{t.settings.provider.visionFallbackLabel}</Label>
          <Select
            value={values.visionFallback}
            onValueChange={(v) => set('visionFallback', v === 'handoff' ? 'handoff' : 'ask_details')}
            disabled={disabled || isReadOnly('llm.vision_fallback', dtos)}
          >
            <SelectTrigger id="llm-vision-fallback" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask_details">{t.settings.provider.visionFallbackAskDetails}</SelectItem>
              <SelectItem value="handoff">{t.settings.provider.visionFallbackHandoff}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="llm-base-url">{t.settings.provider.baseUrlLabel}</Label>
        <Input
          id="llm-base-url"
          value={values.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          disabled={disabled || isReadOnly('llm.base_url', dtos)}
        />
        <p className="text-xs text-muted-foreground">{t.settings.provider.baseUrlHint}</p>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        <div>
          <p className="text-sm font-medium">{t.settings.provider.costTitle}</p>
          <p className="text-xs text-muted-foreground">{t.settings.provider.costHint}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-input-cost">{t.settings.provider.inputCostLabel}</Label>
            <Input
              id="llm-input-cost"
              type="number"
              min={inputCostBounds.min}
              max={inputCostBounds.max}
              step="any"
              value={values.inputCostPerMillion}
              onChange={(event) => set('inputCostPerMillion', Number(event.target.value))}
              disabled={disabled || isReadOnly('llm.input_cost_per_million', dtos)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="llm-output-cost">{t.settings.provider.outputCostLabel}</Label>
            <Input
              id="llm-output-cost"
              type="number"
              min={outputCostBounds.min}
              max={outputCostBounds.max}
              step="any"
              value={values.outputCostPerMillion}
              onChange={(event) => set('outputCostPerMillion', Number(event.target.value))}
              disabled={disabled || isReadOnly('llm.output_cost_per_million', dtos)}
            />
          </div>
        </div>
      </div>

      {meta.hasReasoningQuirks && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">{t.settings.provider.advancedTitle}</p>
          <Label className="flex items-center justify-between gap-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-normal">{t.settings.provider.reasoningSplitLabel}</span>
              <span className="text-xs font-normal text-muted-foreground">{t.settings.provider.reasoningSplitHint}</span>
            </span>
            <Switch
              checked={values.reasoningSplit}
              onCheckedChange={(v) => set('reasoningSplit', v)}
              disabled={disabled || isReadOnly('llm.reasoning_split', dtos)}
            />
          </Label>
          <Label className="flex items-center justify-between gap-3">
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-normal">{t.settings.provider.thinkingDisabledLabel}</span>
              <span className="text-xs font-normal text-muted-foreground">{t.settings.provider.thinkingDisabledHint}</span>
            </span>
            <Switch
              checked={values.thinkingDisabled}
              onCheckedChange={(v) => set('thinkingDisabled', v)}
              disabled={disabled || isReadOnly('llm.thinking_disabled', dtos)}
            />
          </Label>
        </div>
      )}

      {!hidden('test') && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void runTest()}
            disabled={disabled || testState === 'loading'}
            className="w-fit"
          >
            {testState === 'loading' ? t.common.testing : t.common.testConnection}
          </Button>
          {testState === 'error' && testError && (
            <Alert variant="destructive">
              <AlertDescription>{testError}</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}
