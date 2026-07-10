'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeftIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiErrorMessage, type SettingDto } from '@/lib/api';
import { setLocaleCookie, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  SkillsFields,
  buildSkillsUpdates,
  initSkillsValues,
  type SkillsFormValues,
} from '@/components/settings/skills-fields';
import {
  McpFields,
  buildMcpUpdates,
  initMcpValues,
  type McpFormValues,
} from '@/components/settings/mcp-fields';
import { WhatsAppPanel } from '@/components/settings/whatsapp-panel';
import { StaffPanel } from '@/components/settings/staff-panel';
import { isDirty } from '@/components/settings/settings-form-utils';

type Grouped = Record<string, SettingDto[]>;

export default function SettingsPage() {
  const { t } = useT();
  const router = useRouter();
  const [grouped, setGrouped] = useState<Grouped | null>(null);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await api.settingsGrouped();
      setGrouped(data);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void api
      .me()
      .then((user) => {
        if (user.role !== 'admin') router.replace('/');
        else void reload();
      })
      .catch(() => router.replace('/login'));
  }, [reload, router]);

  if (!grouped) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-72 w-full" />
        {loadError && (
          <Alert variant="destructive">
            <AlertDescription>{t.common.error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <div className="flex items-start gap-2">
        <Button variant="ghost" size="icon-sm" asChild className="mt-0.5 shrink-0 md:hidden">
          <Link href="/" aria-label={t.sidebar.backToInbox} title={t.sidebar.backToInbox}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold">{t.settings.pageTitle}</h1>
          <p className="text-sm text-muted-foreground">{t.settings.pageDescription}</p>
        </div>
      </div>

      <Tabs defaultValue="provider">
        <div className="max-w-full overflow-x-auto pb-1">
          <TabsList className="min-w-max">
            <TabsTrigger value="provider">{t.settings.tabProvider}</TabsTrigger>
            <TabsTrigger value="store">{t.settings.tabStore}</TabsTrigger>
            <TabsTrigger value="skills">{t.settings.tabSkills}</TabsTrigger>
            <TabsTrigger value="mcp">{t.settings.tabMcp}</TabsTrigger>
            <TabsTrigger value="business">{t.settings.tabBusiness}</TabsTrigger>
            <TabsTrigger value="whatsapp">{t.settings.tabWhatsapp}</TabsTrigger>
            <TabsTrigger value="staff">{t.settings.tabStaff}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="provider" className="pt-4">
          <ProviderTab dtos={grouped.llm} onSaved={reload} />
        </TabsContent>
        <TabsContent value="store" className="pt-4">
          <StoreTab wc={grouped.wc} payment={grouped.payment} onSaved={reload} />
        </TabsContent>
        <TabsContent value="skills" className="pt-4">
          <SkillsTab dtos={grouped.skills} onSaved={reload} />
        </TabsContent>
        <TabsContent value="mcp" className="pt-4">
          <McpTab dtos={grouped.mcp} onSaved={reload} />
        </TabsContent>
        <TabsContent value="business" className="pt-4">
          <BusinessTab
            business={grouped.business}
            agent={grouped.agent}
            info={grouped.info}
            dispatch={grouped.dispatch}
            compliance={grouped.compliance}
            onSaved={reload}
          />
        </TabsContent>
        <TabsContent value="whatsapp" className="pt-4">
          <WhatsAppPanel />
        </TabsContent>
        <TabsContent value="staff" className="pt-4">
          <StaffPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProviderTab({ dtos, onSaved }: { dtos?: SettingDto[]; onSaved: () => void | Promise<void> }) {
  const { t } = useT();
  const [initial, setInitial] = useState<ProviderFormValues>(() => initProviderValues(dtos));
  const [values, setValues] = useState<ProviderFormValues>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = initProviderValues(dtos);
    setInitial(next);
    setValues(next);
  }, [dtos]);

  const dirty = isDirty(values, initial);

  async function handleSave() {
    const updates = buildProviderUpdates(values, dtos);
    if (updates.length === 0) {
      toast.info(t.common.noChanges);
      return;
    }
    setSaving(true);
    try {
      await api.saveSettings(updates);
      toast.success(t.settings.savedToast);
      await onSaved();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ProviderFields values={values} onChange={setValues} dtos={dtos} disabled={saving} />
      <Button onClick={() => void handleSave()} disabled={saving || !dirty} className="w-fit">
        {saving ? t.common.saving : t.settings.saveButton}
      </Button>
    </div>
  );
}

function StoreTab({
  wc,
  payment,
  onSaved,
}: {
  wc?: SettingDto[];
  payment?: SettingDto[];
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [initial, setInitial] = useState<StoreFormValues>(() => initStoreValues(wc, payment));
  const [values, setValues] = useState<StoreFormValues>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = initStoreValues(wc, payment);
    setInitial(next);
    setValues(next);
  }, [wc, payment]);

  const dirty = isDirty(values, initial);

  async function handleSave() {
    const updates = buildStoreUpdates(values, wc, payment);
    if (updates.length === 0) {
      toast.info(t.common.noChanges);
      return;
    }
    setSaving(true);
    try {
      await api.saveSettings(updates);
      toast.success(t.settings.savedToast);
      await onSaved();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <StoreFields values={values} onChange={setValues} wc={wc} payment={payment} disabled={saving} />
      <Button onClick={() => void handleSave()} disabled={saving || !dirty} className="w-fit">
        {saving ? t.common.saving : t.settings.saveButton}
      </Button>
    </div>
  );
}

function SkillsTab({ dtos, onSaved }: { dtos?: SettingDto[]; onSaved: () => void | Promise<void> }) {
  const { t } = useT();
  const [initial, setInitial] = useState<SkillsFormValues>(() => initSkillsValues(dtos));
  const [values, setValues] = useState<SkillsFormValues>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = initSkillsValues(dtos);
    setInitial(next);
    setValues(next);
  }, [dtos]);

  const dirty = isDirty(values, initial);

  async function handleSave() {
    const updates = buildSkillsUpdates(values, dtos);
    if (updates.length === 0) {
      toast.info(t.common.noChanges);
      return;
    }
    setSaving(true);
    try {
      await api.saveSettings(updates);
      toast.success(t.settings.savedToast);
      await onSaved();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SkillsFields values={values} onChange={setValues} dtos={dtos} disabled={saving} />
      <Button onClick={() => void handleSave()} disabled={saving || !dirty} className="w-fit">
        {saving ? t.common.saving : t.settings.saveButton}
      </Button>
    </div>
  );
}

function McpTab({ dtos, onSaved }: { dtos?: SettingDto[]; onSaved: () => void | Promise<void> }) {
  const { t } = useT();
  const [initial, setInitial] = useState<McpFormValues>(() => initMcpValues(dtos));
  const [values, setValues] = useState<McpFormValues>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = initMcpValues(dtos);
    setInitial(next);
    setValues(next);
  }, [dtos]);

  const dirty = isDirty(values, initial);

  async function handleSave() {
    const updates = buildMcpUpdates(values, dtos);
    if (updates.length === 0) {
      toast.info(t.common.noChanges);
      return;
    }
    setSaving(true);
    try {
      await api.saveSettings(updates);
      toast.success(t.settings.savedToast);
      await onSaved();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <McpFields values={values} onChange={setValues} dtos={dtos} disabled={saving} />
      <Button onClick={() => void handleSave()} disabled={saving || !dirty} className="w-fit">
        {saving ? t.common.saving : t.settings.saveButton}
      </Button>
    </div>
  );
}

function BusinessTab({
  business,
  agent,
  info,
  dispatch,
  compliance,
  onSaved,
}: {
  business?: SettingDto[];
  agent?: SettingDto[];
  info?: SettingDto[];
  dispatch?: SettingDto[];
  compliance?: SettingDto[];
  onSaved: () => void | Promise<void>;
}) {
  const { t, locale } = useT();
  const [initial, setInitial] = useState<BusinessFormValues>(() => initBusinessValues({ business, agent, info, dispatch, compliance }));
  const [values, setValues] = useState<BusinessFormValues>(initial);
  const [uiLanguage, setUiLanguage] = useState<Locale>(locale);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = initBusinessValues({ business, agent, info, dispatch, compliance });
    setInitial(next);
    setValues(next);
  }, [business, agent, info, dispatch, compliance]);

  const dirty = isDirty(values, initial) || uiLanguage !== locale;

  async function handleSave() {
    const updates = buildBusinessUpdates(values, { business, agent, info, dispatch, compliance });
    setSaving(true);
    try {
      if (updates.length > 0) await api.saveSettings(updates);
      if (uiLanguage !== locale) {
        // The dashboard's display language lives purely in the arix_locale
        // cookie (not a settings-schema key) — a full reload is the simplest
        // way to make every server-resolved string switch immediately.
        setLocaleCookie(uiLanguage);
        toast.success(t.settings.savedToast);
        window.location.reload();
        return;
      }
      toast.success(t.settings.savedToast);
      await onSaved();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <BusinessFields
        values={values}
        onChange={setValues}
        uiLanguage={uiLanguage}
        onUiLanguageChange={setUiLanguage}
        dtos={{ business, agent, info, dispatch, compliance }}
        disabled={saving}
      />
      <Button onClick={() => void handleSave()} disabled={saving || !dirty} className="w-fit">
        {saving ? t.common.saving : t.settings.saveButton}
      </Button>
    </div>
  );
}
