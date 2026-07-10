'use client';

import { useT } from '@/lib/i18n/provider';
import type { SettingDto, SettingsUpdate } from '@/lib/api';
import type { SkillCatalogEntry } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { compactUpdates, findDto, isReadOnly, plainUpdate } from './settings-form-utils';

/** Built-in skill ids — must stay in sync with server/src/skills/registry.ts. */
export const SKILL_IDS = ['catalog', 'orders', 'payments', 'handoff'] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export interface SkillsFormValues {
  enabled: SkillId[];
}

export function initSkillsValues(dtos: SettingDto[] | undefined): SkillsFormValues {
  const raw = findDto('skills.enabled', dtos)?.value;
  if (Array.isArray(raw)) {
    const ids = raw.filter((v): v is SkillId => typeof v === 'string' && (SKILL_IDS as readonly string[]).includes(v));
    return { enabled: ids };
  }
  return { enabled: [...SKILL_IDS] };
}

export function buildSkillsUpdates(values: SkillsFormValues, dtos: SettingDto[] | undefined): SettingsUpdate[] {
  return compactUpdates([plainUpdate('skills.enabled', values.enabled, dtos)]);
}

interface SkillsFieldsProps {
  values: SkillsFormValues;
  onChange: (values: SkillsFormValues) => void;
  dtos?: SettingDto[];
  /** Optional live catalog from GET /api/skills (labels/descriptions). */
  catalog?: SkillCatalogEntry[];
  disabled?: boolean;
}

const FALLBACK_META: Record<SkillId, { labelKey: 'catalog' | 'orders' | 'payments' | 'handoff' }> = {
  catalog: { labelKey: 'catalog' },
  orders: { labelKey: 'orders' },
  payments: { labelKey: 'payments' },
  handoff: { labelKey: 'handoff' },
};

/** Toggle built-in agent skills — shared by settings tab and setup wizard. */
export function SkillsFields({ values, onChange, dtos, catalog, disabled }: SkillsFieldsProps) {
  const { t } = useT();
  const locked = isReadOnly('skills.enabled', dtos);
  const enabled = new Set(values.enabled);

  function toggle(id: SkillId, next: boolean) {
    if (locked || disabled) return;
    const set = new Set(values.enabled);
    if (next) set.add(id);
    else set.delete(id);
    onChange({ enabled: SKILL_IDS.filter((s) => set.has(s)) });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t.settings.skills.description}</p>
      {locked && (
        <Badge variant="secondary" className="w-fit">
          {t.settings.setByEnvBadge}
        </Badge>
      )}
      <ul className="flex flex-col gap-3">
        {SKILL_IDS.map((id) => {
          const fromCatalog = catalog?.find((s) => s.id === id);
          const meta = t.settings.skills.items[FALLBACK_META[id].labelKey];
          const label = fromCatalog?.label ? meta.label : meta.label;
          const description = meta.description;
          const tools = fromCatalog?.toolNames ?? [];
          return (
            <li
              key={id}
              className="flex items-start justify-between gap-4 border-b border-border/60 pb-3 last:border-0 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <Label htmlFor={`skill-${id}`} className="text-sm font-medium">
                  {label}
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                {tools.length > 0 && (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">{tools.join(', ')}</p>
                )}
              </div>
              <Switch
                id={`skill-${id}`}
                checked={enabled.has(id)}
                onCheckedChange={(v) => toggle(id, v)}
                disabled={disabled || locked}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
