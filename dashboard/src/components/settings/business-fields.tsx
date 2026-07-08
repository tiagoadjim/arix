'use client';

import { useT } from '@/lib/i18n/provider';
import type { Locale } from '@/lib/i18n';
import type { SettingDto, SettingsUpdate } from '@/lib/api';
import { emptySchedule, type Schedule } from '@/lib/hours';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { HoursEditor } from './hours-editor';
import { booleanValue, compactUpdates, findDto, plainUpdate, stringValue } from './settings-form-utils';

export interface BusinessFormValues {
  businessName: string;
  timezone: string;
  hours: Schedule;
  agentName: string;
  agentLanguage: 'es' | 'en';
  discloseBot: boolean;
  infoPayment: string;
  infoShipping: string;
  infoGeneral: string;
  dispatchTemplate: string;
  complianceRules: string;
}

export function initBusinessValues(dtos: {
  business?: SettingDto[];
  agent?: SettingDto[];
  info?: SettingDto[];
  dispatch?: SettingDto[];
  compliance?: SettingDto[];
}): BusinessFormValues {
  const hoursRaw = findDto('business.hours', dtos.business)?.value;
  return {
    businessName: stringValue('business.name', dtos.business, 'My Store'),
    timezone: stringValue('business.timezone', dtos.business, 'America/Argentina/Buenos_Aires'),
    hours: Array.isArray(hoursRaw) && hoursRaw.length === 7 ? (hoursRaw as Schedule) : emptySchedule(),
    agentName: stringValue('agent.name', dtos.agent, 'Arix'),
    agentLanguage: stringValue('agent.language', dtos.agent, 'es') === 'en' ? 'en' : 'es',
    discloseBot: booleanValue('agent.disclose_bot', dtos.agent),
    infoPayment: stringValue('info.payment', dtos.info),
    infoShipping: stringValue('info.shipping', dtos.info),
    infoGeneral: stringValue('info.general', dtos.info),
    dispatchTemplate: stringValue('dispatch.template', dtos.dispatch),
    complianceRules: stringValue('compliance.rules', dtos.compliance),
  };
}

export function buildBusinessUpdates(
  values: BusinessFormValues,
  dtos: {
    business?: SettingDto[];
    agent?: SettingDto[];
    info?: SettingDto[];
    dispatch?: SettingDto[];
    compliance?: SettingDto[];
  },
): SettingsUpdate[] {
  return compactUpdates([
    plainUpdate('business.name', values.businessName, dtos.business),
    plainUpdate('business.timezone', values.timezone, dtos.business),
    plainUpdate('business.hours', values.hours, dtos.business),
    plainUpdate('agent.name', values.agentName, dtos.agent),
    plainUpdate('agent.language', values.agentLanguage, dtos.agent),
    plainUpdate('agent.disclose_bot', values.discloseBot, dtos.agent),
    plainUpdate('info.payment', values.infoPayment, dtos.info),
    plainUpdate('info.shipping', values.infoShipping, dtos.info),
    plainUpdate('info.general', values.infoGeneral, dtos.info),
    plainUpdate('dispatch.template', values.dispatchTemplate, dtos.dispatch),
    plainUpdate('compliance.rules', values.complianceRules, dtos.compliance),
  ]);
}

// A representative, non-exhaustive set of common IANA zones for the timezone
// field's <datalist> autocomplete hint — the input still accepts any string.
const COMMON_TIMEZONES = [
  'America/Argentina/Buenos_Aires',
  'America/Sao_Paulo',
  'America/Santiago',
  'America/Bogota',
  'America/Mexico_City',
  'America/Lima',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/Madrid',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Paris',
  'Africa/Casablanca',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

interface BusinessFieldsProps {
  values: BusinessFormValues;
  onChange: (values: BusinessFormValues) => void;
  uiLanguage: Locale;
  onUiLanguageChange: (locale: Locale) => void;
  business?: SettingDto[];
  agent?: SettingDto[];
  info?: SettingDto[];
  dispatch?: SettingDto[];
  compliance?: SettingDto[];
  disabled?: boolean;
}

/** Business profile fields — shared verbatim between the settings "Business"
 * tab and setup-wizard step 5. The "dashboard language" select is deliberately
 * NOT part of `values`/`onChange`: it's a client-only `arix_locale` cookie
 * preference, not a registered settings-schema key (unlike `agent.language`,
 * which the agent actually speaks and IS persisted). */
export function BusinessFields({
  values,
  onChange,
  uiLanguage,
  onUiLanguageChange,
  business,
  agent,
  info,
  dispatch,
  compliance,
  disabled,
}: BusinessFieldsProps) {
  const { t } = useT();

  function set<K extends keyof BusinessFormValues>(key: K, value: BusinessFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="business-name">{t.settings.business.businessNameLabel}</Label>
          <Input
            id="business-name"
            value={values.businessName}
            onChange={(e) => set('businessName', e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-name">{t.settings.business.agentNameLabel}</Label>
          <Input id="agent-name" value={values.agentName} onChange={(e) => set('agentName', e.target.value)} disabled={disabled} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-language">{t.settings.business.agentLanguageLabel}</Label>
          <Select value={values.agentLanguage} onValueChange={(v) => set('agentLanguage', v === 'en' ? 'en' : 'es')} disabled={disabled}>
            <SelectTrigger id="agent-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="es">Español</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ui-language">{t.settings.business.uiLanguageLabel}</Label>
          <Select value={uiLanguage} onValueChange={(v) => onUiLanguageChange(v === 'en' ? 'en' : 'es')} disabled={disabled}>
            <SelectTrigger id="ui-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="es">Español</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t.settings.business.uiLanguageHint}</p>
        </div>
      </div>

      <Label className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-normal">{t.settings.business.discloseBotLabel}</span>
          <span className="text-xs font-normal text-muted-foreground">{t.settings.business.discloseBotHint}</span>
        </span>
        <Switch checked={values.discloseBot} onCheckedChange={(v) => set('discloseBot', v)} disabled={disabled} />
      </Label>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="business-timezone">{t.settings.business.timezoneLabel}</Label>
        <Input
          id="business-timezone"
          list="common-timezones"
          value={values.timezone}
          onChange={(e) => set('timezone', e.target.value)}
          disabled={disabled}
        />
        <datalist id="common-timezones">
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">{t.settings.business.timezoneHint}</p>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <div>
          <p className="text-sm font-medium">{t.settings.business.hoursTitle}</p>
          <p className="text-xs text-muted-foreground">{t.settings.business.hoursHint}</p>
        </div>
        <HoursEditor value={values.hours} onChange={(hours) => set('hours', hours)} disabled={disabled} />
      </div>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="info-payment">{t.settings.business.infoPaymentLabel}</Label>
          <Textarea
            id="info-payment"
            rows={4}
            value={values.infoPayment}
            onChange={(e) => set('infoPayment', e.target.value)}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">{t.settings.business.infoPaymentHint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="info-shipping">{t.settings.business.infoShippingLabel}</Label>
          <Textarea
            id="info-shipping"
            rows={4}
            value={values.infoShipping}
            onChange={(e) => set('infoShipping', e.target.value)}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">{t.settings.business.infoShippingHint}</p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="info-general">{t.settings.business.infoGeneralLabel}</Label>
        <Textarea
          id="info-general"
          rows={4}
          value={values.infoGeneral}
          onChange={(e) => set('infoGeneral', e.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">{t.settings.business.infoGeneralHint}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="compliance-rules">{t.settings.business.complianceLabel}</Label>
        <Textarea
          id="compliance-rules"
          rows={4}
          value={values.complianceRules}
          onChange={(e) => set('complianceRules', e.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">{t.settings.business.complianceHint}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dispatch-template">{t.settings.business.dispatchTemplateLabel}</Label>
        <Textarea
          id="dispatch-template"
          rows={5}
          value={values.dispatchTemplate}
          onChange={(e) => set('dispatchTemplate', e.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">{t.settings.business.dispatchTemplateHint}</p>
      </div>
    </div>
  );
}
