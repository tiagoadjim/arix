'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/provider';
import { interpolate } from '@/lib/i18n';
import { api, type SettingDto, type SettingsUpdate } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SecretInput } from './secret-input';
import { compactUpdates, findDto, isReadOnly, numberValue, plainUpdate, secretUpdate, stringValue } from './settings-form-utils';

export interface StoreFormValues {
  url: string;
  consumerKey: string;
  consumerSecret: string;
  frontUrl: string;
  currency: string;
  statusAfterPayment: string;
  statusAfterDispatch: string;
  productLinkTemplate: string;
  tolerance: number;
}

export function initStoreValues(wc: SettingDto[] | undefined, payment: SettingDto[] | undefined): StoreFormValues {
  return {
    url: stringValue('wc.url', wc),
    consumerKey: '',
    consumerSecret: '',
    frontUrl: stringValue('wc.front_url', wc),
    currency: stringValue('wc.currency', wc, 'USD'),
    statusAfterPayment: stringValue('wc.status_after_payment', wc, 'processing'),
    statusAfterDispatch: stringValue('wc.status_after_dispatch', wc),
    productLinkTemplate: stringValue('wc.product_link_template', wc, '{base}/producto/{slug}'),
    tolerance: numberValue('payment.tolerance', payment, 1),
  };
}

export function buildStoreUpdates(
  values: StoreFormValues,
  wc: SettingDto[] | undefined,
  payment: SettingDto[] | undefined,
): SettingsUpdate[] {
  return compactUpdates([
    plainUpdate('wc.url', values.url, wc),
    secretUpdate('wc.consumer_key', values.consumerKey, wc),
    secretUpdate('wc.consumer_secret', values.consumerSecret, wc),
    plainUpdate('wc.front_url', values.frontUrl, wc),
    plainUpdate('wc.currency', values.currency, wc),
    plainUpdate('wc.status_after_payment', values.statusAfterPayment, wc),
    plainUpdate('wc.status_after_dispatch', values.statusAfterDispatch, wc),
    plainUpdate('wc.product_link_template', values.productLinkTemplate, wc),
    plainUpdate('payment.tolerance', values.tolerance, payment),
  ]);
}

interface StoreFieldsProps {
  values: StoreFormValues;
  onChange: (values: StoreFormValues) => void;
  wc?: SettingDto[];
  disabled?: boolean;
}

/** WooCommerce connection fields + "Test connection" — shared verbatim
 * between the settings "Store" tab and setup-wizard step 4. */
export function StoreFields({ values, onChange, wc, disabled }: StoreFieldsProps) {
  const { t } = useT();
  const [testState, setTestState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  function set<K extends keyof StoreFormValues>(key: K, value: StoreFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  async function runTest() {
    setTestState('loading');
    setTestError(null);
    try {
      const result = await api.testWoo({
        url: values.url,
        consumerKey: values.consumerKey,
        consumerSecret: values.consumerSecret,
      });
      if (result.ok) {
        setTestState('success');
        toast.success(
          result.sampleProductName
            ? interpolate(t.settings.store.testSuccessWithProductToast, { name: result.sampleProductName })
            : t.settings.store.testSuccessToast,
        );
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wc-url" className="justify-between">
          <span>{t.settings.store.urlLabel}</span>
          {isReadOnly('wc.url', wc) && <Badge variant="outline">{t.common.envLockedBadge}</Badge>}
        </Label>
        <Input
          id="wc-url"
          value={values.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder={t.settings.store.urlPlaceholder}
          disabled={disabled || isReadOnly('wc.url', wc)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-consumer-key" className="justify-between">
            <span>{t.settings.store.consumerKeyLabel}</span>
            {isReadOnly('wc.consumer_key', wc) && <Badge variant="outline">{t.common.envLockedBadge}</Badge>}
          </Label>
          <SecretInput
            id="wc-consumer-key"
            value={values.consumerKey}
            onChange={(v) => set('consumerKey', v)}
            set={findDto('wc.consumer_key', wc)?.set ?? false}
            readOnly={disabled || isReadOnly('wc.consumer_key', wc)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-consumer-secret" className="justify-between">
            <span>{t.settings.store.consumerSecretLabel}</span>
            {isReadOnly('wc.consumer_secret', wc) && <Badge variant="outline">{t.common.envLockedBadge}</Badge>}
          </Label>
          <SecretInput
            id="wc-consumer-secret"
            value={values.consumerSecret}
            onChange={(v) => set('consumerSecret', v)}
            set={findDto('wc.consumer_secret', wc)?.set ?? false}
            readOnly={disabled || isReadOnly('wc.consumer_secret', wc)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wc-front-url">{t.settings.store.frontUrlLabel}</Label>
        <Input
          id="wc-front-url"
          value={values.frontUrl}
          onChange={(e) => set('frontUrl', e.target.value)}
          disabled={disabled || isReadOnly('wc.front_url', wc)}
        />
        <p className="text-xs text-muted-foreground">{t.settings.store.frontUrlHint}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-currency">{t.settings.store.currencyLabel}</Label>
          <Input
            id="wc-currency"
            value={values.currency}
            onChange={(e) => set('currency', e.target.value)}
            disabled={disabled || isReadOnly('wc.currency', wc)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-status-payment">{t.settings.store.statusAfterPaymentLabel}</Label>
          <Input
            id="wc-status-payment"
            value={values.statusAfterPayment}
            onChange={(e) => set('statusAfterPayment', e.target.value)}
            disabled={disabled || isReadOnly('wc.status_after_payment', wc)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-status-dispatch">{t.settings.store.statusAfterDispatchLabel}</Label>
          <Input
            id="wc-status-dispatch"
            value={values.statusAfterDispatch}
            onChange={(e) => set('statusAfterDispatch', e.target.value)}
            disabled={disabled || isReadOnly('wc.status_after_dispatch', wc)}
          />
          <p className="text-xs text-muted-foreground">{t.settings.store.statusAfterDispatchHint}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-product-link">{t.settings.store.productLinkTemplateLabel}</Label>
          <Input
            id="wc-product-link"
            value={values.productLinkTemplate}
            onChange={(e) => set('productLinkTemplate', e.target.value)}
            disabled={disabled || isReadOnly('wc.product_link_template', wc)}
          />
          <p className="text-xs text-muted-foreground">{t.settings.store.productLinkTemplateHint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wc-tolerance">{t.settings.store.toleranceLabel}</Label>
          <Input
            id="wc-tolerance"
            type="number"
            min={0}
            step="any"
            value={values.tolerance}
            onChange={(e) => set('tolerance', Number(e.target.value))}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">{t.settings.store.toleranceHint}</p>
        </div>
      </div>

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
    </div>
  );
}
