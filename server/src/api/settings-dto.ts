import {
  SETTINGS_SCHEMA,
  SETTINGS_BY_KEY,
  type SettingDefinition,
  type SettingType,
} from '../config/settings-schema';
import type { ResolvedEntry, ResolvedMeta, SettingSource } from '../config/runtime';

/**
 * Sanitized, dashboard-facing view of one settings-schema entry. This is the
 * single choke point between the runtime config service (which holds
 * decrypted secrets in memory once resolved) and anything sent to the
 * browser: for `secret: true` keys, `value` is ALWAYS null — `set` is the
 * only signal the dashboard gets for whether one is configured. See
 * settings-dto.test.ts for the no-plaintext-leak proof.
 */
export interface SettingDto {
  key: string;
  group: string;
  type: SettingType;
  label: string;
  value: unknown;
  /** True once the setting has a real, non-default value configured
   * (env or DB) — for secret keys specifically, true once a non-empty
   * value is actually resolved (independent of `source`). */
  set: boolean;
  source: SettingSource;
  /** True when an env var is currently seeding this key — the dashboard
   * renders it read-only, since a write would be silently overridden by
   * the env value on the very next resolution. */
  readOnly: boolean;
  secret: boolean;
}

export function toSettingDto(entry: SettingDefinition, resolved: ResolvedEntry): SettingDto {
  const secret = entry.secret === true;
  return {
    key: entry.key,
    group: entry.group,
    type: entry.type,
    label: entry.label,
    value: secret ? null : resolved.value,
    set: secret ? Boolean(String(resolved.value ?? '').trim()) : resolved.source !== 'default',
    source: resolved.source,
    readOnly: resolved.source === 'env',
    secret,
  };
}

/**
 * Groups every schema key's DTO by its `group` (e.g. "llm", "wc", "business")
 * — the shape the dashboard's per-tab settings pages consume directly.
 * Iterates SETTINGS_SCHEMA in its declared order, so both group order and
 * per-group key order are deterministic and match the schema file.
 */
export function buildSettingsDto(meta: ResolvedMeta): Record<string, SettingDto[]> {
  const out: Record<string, SettingDto[]> = {};
  for (const entry of SETTINGS_SCHEMA) {
    const resolved = meta[entry.key];
    if (!resolved) continue; // defensive — every schema key should be present
    (out[entry.group] ??= []).push(toSettingDto(entry, resolved));
  }
  return out;
}

// ---- PUT /api/settings: body normalization + validation + storage coercion ----

export interface SettingsUpdateInput {
  key: string;
  value: unknown;
}

/**
 * Accepts both the new batch body `{ updates: [{key, value}, ...] }` and the
 * legacy single body `{ key, value }` (kept for backward compat with the
 * pre-Phase-7 dashboard config page). Returns [] for anything else.
 */
export function normalizeSettingsUpdates(body: unknown): SettingsUpdateInput[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as { updates?: unknown; key?: unknown; value?: unknown };

  if (Array.isArray(b.updates)) {
    const out: SettingsUpdateInput[] = [];
    for (const u of b.updates) {
      if (!u || typeof u !== 'object') continue;
      const { key, value } = u as { key?: unknown; value?: unknown };
      if (typeof key !== 'string' || !key) continue;
      out.push({ key, value });
    }
    return out;
  }

  if (typeof b.key === 'string' && b.key) {
    return [{ key: b.key, value: b.value }];
  }

  return [];
}

/** Inverse of runtime.ts's parseRawValue(): coerce an incoming JS value (from
 * a PUT request body) into the TEXT representation stored in the `settings`
 * table. Mirrors parseRawValue's own fallback rules (bad enum/number falls
 * back to the schema default) so a bad write can never store an unparseable
 * value that would otherwise silently misbehave on the next read. */
export function coerceForStorage(entry: SettingDefinition, value: unknown): string {
  switch (entry.type) {
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : /^(1|true|yes|on)$/i.test(String(value ?? '')) ? 'true' : 'false';
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? String(n) : String(entry.default);
    }
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'enum':
      return entry.enumValues?.includes(String(value)) ? String(value) : String(entry.default);
    case 'string':
    default:
      return String(value ?? '');
  }
}

export type ValidateUpdatesResult =
  | { ok: true; updates: Array<{ entry: SettingDefinition; raw: unknown }> }
  | { ok: false; offenders: string[] };

/**
 * Validates every requested update against the schema: unknown keys and
 * env-locked keys (writing one would be silently overridden by the env var
 * anyway) are collected as offenders. All-or-nothing — if ANY key is
 * invalid, the whole batch is rejected (no partial apply) so the caller
 * always gets a complete, unambiguous list of what to fix.
 */
export function validateSettingsUpdates(
  updates: SettingsUpdateInput[],
  envLocked: ReadonlySet<string>,
): ValidateUpdatesResult {
  const offenders: string[] = [];
  const resolved: Array<{ entry: SettingDefinition; raw: unknown }> = [];
  for (const u of updates) {
    const entry = SETTINGS_BY_KEY.get(u.key);
    if (!entry || envLocked.has(u.key)) {
      offenders.push(u.key);
      continue;
    }
    resolved.push({ entry, raw: u.value });
  }
  if (offenders.length > 0) return { ok: false, offenders };
  return { ok: true, updates: resolved };
}
