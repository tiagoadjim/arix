import type { SettingDto, SettingsUpdate } from '@/lib/api';

/** Shared helpers for the settings Fields components (provider/store/business),
 * used identically by the settings Tabs page and the setup wizard steps that
 * render the same components. Centralizes the two correctness-critical rules:
 *  - never send an env-locked ("read-only") key in an update batch — the
 *    server rejects the WHOLE PUT /api/settings batch if ANY key is
 *    unknown/env-locked (see settings-dto.ts's validateSettingsUpdates).
 *  - a blank secret field means "keep the current value", never "clear it".
 */

export function findDto(key: string, dtos: SettingDto[] | undefined): SettingDto | undefined {
  return dtos?.find((d) => d.key === key);
}

export function isReadOnly(key: string, dtos: SettingDto[] | undefined): boolean {
  return findDto(key, dtos)?.readOnly ?? false;
}

export function stringValue(key: string, dtos: SettingDto[] | undefined, fallback = ''): string {
  const v = findDto(key, dtos)?.value;
  return typeof v === 'string' ? v : fallback;
}

export function booleanValue(key: string, dtos: SettingDto[] | undefined, fallback = false): boolean {
  const v = findDto(key, dtos)?.value;
  return typeof v === 'boolean' ? v : fallback;
}

export function numberValue(key: string, dtos: SettingDto[] | undefined, fallback = 0): number {
  const v = findDto(key, dtos)?.value;
  return typeof v === 'number' ? v : fallback;
}

/** Non-secret update — included whenever the key isn't env-locked (always
 * re-sent on save; harmless since it round-trips to the same stored value
 * when the field wasn't touched). */
export function plainUpdate(key: string, value: unknown, dtos: SettingDto[] | undefined): SettingsUpdate | null {
  if (isReadOnly(key, dtos)) return null;
  return { key, value };
}

/** Secret update — only sent when the user actually typed a new value AND
 * the key isn't env-locked. An empty input means "leave the stored secret
 * untouched", never "clear it". */
export function secretUpdate(key: string, typed: string, dtos: SettingDto[] | undefined): SettingsUpdate | null {
  if (isReadOnly(key, dtos)) return null;
  if (!typed.trim()) return null;
  return { key, value: typed };
}

export function compactUpdates(updates: Array<SettingsUpdate | null>): SettingsUpdate[] {
  return updates.filter((u): u is SettingsUpdate => u !== null);
}

/** Cheap structural-equality check for dirty-state tracking — every settings
 * form value here is a plain primitive/array/object, so JSON comparison is
 * exact and stable (keys are always constructed in the same order). */
export function isDirty(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
