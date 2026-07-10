import { describe, it, expect } from 'vitest';
import {
  toSettingDto,
  buildSettingsDto,
  normalizeSettingsUpdates,
  coerceForStorage,
  validateSettingsUpdates,
  invalidSettingsValues,
  isNoOpSecretUpdate,
  type SettingDto,
} from '../src/api/settings-dto';
import {
  MAX_LLM_COST_PER_MILLION_USD,
  MAX_PAYMENT_TOLERANCE,
  SETTINGS_BY_KEY,
  SETTINGS_SCHEMA,
} from '../src/config/settings-schema';
import type { ResolvedMeta } from '../src/config/runtime';

const entry = (key: string) => {
  const e = SETTINGS_BY_KEY.get(key);
  if (!e) throw new Error(`unknown fixture key: ${key}`);
  return e;
};

describe('toSettingDto', () => {
  it('passes through a non-secret value with source "default" and set=false, not read-only', () => {
    const dto = toSettingDto(entry('business.name'), { value: 'My Store', source: 'default' });
    expect(dto).toMatchObject({
      key: 'business.name',
      group: 'business',
      type: 'string',
      value: 'My Store',
      set: false,
      source: 'default',
      readOnly: false,
      secret: false,
    });
  });

  it('marks a non-secret DB-sourced value as set and not read-only', () => {
    const dto = toSettingDto(entry('business.name'), { value: 'Acme Vapes', source: 'db' });
    expect(dto.set).toBe(true);
    expect(dto.readOnly).toBe(false);
    expect(dto.value).toBe('Acme Vapes');
  });

  it('marks an env-sourced value as set AND read-only', () => {
    const dto = toSettingDto(entry('business.name'), { value: 'Env Store', source: 'env' });
    expect(dto.set).toBe(true);
    expect(dto.readOnly).toBe(true);
  });

  it('exposes numeric bounds without adding them to non-numeric DTOs', () => {
    expect(toSettingDto(entry('payment.tolerance'), { value: 1, source: 'default' })).toMatchObject({
      min: 0,
      max: MAX_PAYMENT_TOLERANCE,
    });
    expect(toSettingDto(entry('business.name'), { value: 'Store', source: 'default' })).not.toHaveProperty('max');
  });

  it('NEVER returns the real value for a secret key — value is always null', () => {
    const dto = toSettingDto(entry('llm.api_key'), { value: 'sk-super-secret-do-not-leak', source: 'db' });
    expect(dto.value).toBeNull();
    expect(dto.secret).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('sk-super-secret-do-not-leak');
  });

  it('a secret key with an empty resolved value (never configured) reports set=false', () => {
    const dto = toSettingDto(entry('llm.api_key'), { value: '', source: 'default' });
    expect(dto.value).toBeNull();
    expect(dto.set).toBe(false);
  });

  it('a secret key with a non-empty resolved value reports set=true regardless of source', () => {
    const dto = toSettingDto(entry('llm.api_key'), { value: 'sk-configured', source: 'env' });
    expect(dto.value).toBeNull();
    expect(dto.set).toBe(true);
    expect(dto.readOnly).toBe(true);
  });

  it('strips MCP header secret values from mcp.servers', () => {
    const dto = toSettingDto(entry('mcp.servers'), {
      value: [
        {
          id: 'github',
          name: 'GitHub',
          enabled: true,
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer ghp_secret' },
          allowedTools: ['search'],
        },
      ],
      source: 'db',
    });
    expect(JSON.stringify(dto)).not.toContain('ghp_secret');
    const servers = dto.value as Array<{ headerKeys: string[] }>;
    expect(servers[0]?.headerKeys).toEqual(['Authorization']);
  });
});

describe('buildSettingsDto', () => {
  function fullMeta(overrides: Record<string, { value: unknown; source: 'env' | 'db' | 'default' }>): ResolvedMeta {
    const meta: ResolvedMeta = {};
    for (const e of SETTINGS_SCHEMA) {
      meta[e.key] = overrides[e.key] ?? { value: e.default, source: 'default' };
    }
    return meta;
  }

  it('groups every schema key by its declared group', () => {
    const dto = buildSettingsDto(fullMeta({}));
    expect(Object.keys(dto)).toEqual(
      expect.arrayContaining([
        'llm',
        'wc',
        'payment',
        'business',
        'agent',
        'info',
        'dispatch',
        'compliance',
        'skills',
        'mcp',
        'setup',
      ]),
    );
    const llmKeys = dto.llm?.map((d: SettingDto) => d.key) ?? [];
    expect(llmKeys).toContain('llm.provider');
    expect(llmKeys).toContain('llm.api_key');
  });

  it('NEVER leaks a secret value anywhere in the serialized DTO (the no-plaintext-leak proof)', () => {
    const SECRET = 'sk-should-never-appear-anywhere-1234567890';
    const meta = fullMeta({
      'llm.api_key': { value: SECRET, source: 'db' },
      'wc.consumer_key': { value: 'ck_' + SECRET, source: 'db' },
      'wc.consumer_secret': { value: 'cs_' + SECRET, source: 'env' },
    });
    const dto = buildSettingsDto(meta);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(SECRET);

    const apiKeyDto = dto.llm?.find((d: SettingDto) => d.key === 'llm.api_key');
    expect(apiKeyDto?.value).toBeNull();
    expect(apiKeyDto?.set).toBe(true);
    const wcKeyDto = dto.wc?.find((d: SettingDto) => d.key === 'wc.consumer_key');
    expect(wcKeyDto?.value).toBeNull();
    expect(wcKeyDto?.set).toBe(true);
  });

  it('skips a schema key with no corresponding resolved entry instead of throwing', () => {
    const meta = fullMeta({});
    delete meta['setup.completed'];
    expect(() => buildSettingsDto(meta)).not.toThrow();
    const setupKeys = buildSettingsDto(meta).setup?.map((d: SettingDto) => d.key) ?? [];
    expect(setupKeys).not.toContain('setup.completed');
  });
});

describe('normalizeSettingsUpdates', () => {
  it('normalizes the new batch shape ({ updates: [...] })', () => {
    const out = normalizeSettingsUpdates({
      updates: [
        { key: 'business.name', value: 'Acme' },
        { key: 'agent.language', value: 'en' },
      ],
    });
    expect(out).toEqual([
      { key: 'business.name', value: 'Acme' },
      { key: 'agent.language', value: 'en' },
    ]);
  });

  it('normalizes the legacy single shape ({ key, value }) for backward compat with the pre-Phase-7 dashboard', () => {
    const out = normalizeSettingsUpdates({ key: 'info.payment', value: 'Transfer only' });
    expect(out).toEqual([{ key: 'info.payment', value: 'Transfer only' }]);
  });

  it('returns an empty array for an empty or malformed body', () => {
    expect(normalizeSettingsUpdates({})).toEqual([]);
    expect(normalizeSettingsUpdates(null)).toEqual([]);
    expect(normalizeSettingsUpdates({ updates: 'not-an-array' })).toEqual([]);
  });

  it('drops non-object entries inside an updates array', () => {
    const out = normalizeSettingsUpdates({ updates: [{ key: 'business.name', value: 'Acme' }, null, 'oops'] });
    expect(out).toEqual([{ key: 'business.name', value: 'Acme' }]);
  });
});

describe('coerceForStorage', () => {
  it('stores a boolean as "true"/"false"', () => {
    expect(coerceForStorage(entry('agent.disclose_bot'), true)).toBe('true');
    expect(coerceForStorage(entry('agent.disclose_bot'), false)).toBe('false');
    expect(coerceForStorage(entry('agent.disclose_bot'), 'yes')).toBe('true');
    expect(coerceForStorage(entry('agent.disclose_bot'), 'nope')).toBe('false');
  });

  it('stores a finite number as a numeric string, falling back to the default when not finite', () => {
    expect(coerceForStorage(entry('payment.tolerance'), 2.5)).toBe('2.5');
    expect(coerceForStorage(entry('payment.tolerance'), 'abc')).toBe(String(entry('payment.tolerance').default));
    expect(coerceForStorage(entry('payment.tolerance'), MAX_PAYMENT_TOLERANCE + 1)).toBe(
      String(entry('payment.tolerance').default),
    );
  });

  it('stores json by stringifying non-string values and passing strings through', () => {
    const custom = [null, [600, 900], null, null, null, null, null];
    expect(coerceForStorage(entry('business.hours'), custom)).toBe(JSON.stringify(custom));
    expect(coerceForStorage(entry('business.hours'), JSON.stringify(custom))).toBe(JSON.stringify(custom));
  });

  it('stores a valid enum value as-is, falling back to the default when invalid', () => {
    expect(coerceForStorage(entry('llm.provider'), 'openai')).toBe('openai');
    expect(coerceForStorage(entry('llm.provider'), 'not-a-real-provider')).toBe(String(entry('llm.provider').default));
  });

  it('stores a plain string as-is', () => {
    expect(coerceForStorage(entry('business.name'), 'Acme Vapes')).toBe('Acme Vapes');
  });
});

describe('isNoOpSecretUpdate', () => {
  it('is true for a secret key with an empty string, null, or undefined value', () => {
    expect(isNoOpSecretUpdate(entry('llm.api_key'), '')).toBe(true);
    expect(isNoOpSecretUpdate(entry('llm.api_key'), null)).toBe(true);
    expect(isNoOpSecretUpdate(entry('llm.api_key'), undefined)).toBe(true);
  });

  it('is false for a secret key with a non-empty value', () => {
    expect(isNoOpSecretUpdate(entry('llm.api_key'), 'sk-new-value')).toBe(false);
  });

  it('is false for a non-secret key even with an empty value (explicit clear is legitimate)', () => {
    expect(isNoOpSecretUpdate(entry('business.name'), '')).toBe(false);
    expect(isNoOpSecretUpdate(entry('business.name'), null)).toBe(false);
  });
});

describe('validateSettingsUpdates', () => {
  it('accepts every key that exists in the schema and is not env-locked', () => {
    const result = validateSettingsUpdates(
      [{ key: 'business.name', value: 'Acme' }, { key: 'info.payment', value: 'Transfer' }],
      new Set(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates.map((u) => u.entry.key)).toEqual(['business.name', 'info.payment']);
      expect(result.updates.map((u) => u.raw)).toEqual(['Acme', 'Transfer']);
    }
  });

  it('rejects an unknown key, listing it as an offender', () => {
    const result = validateSettingsUpdates([{ key: 'not.a.real.key', value: 'x' }], new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offenders).toEqual(['not.a.real.key']);
  });

  it('rejects an env-locked key, listing it as an offender', () => {
    const result = validateSettingsUpdates(
      [{ key: 'business.name', value: 'Acme' }],
      new Set(['business.name']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offenders).toEqual(['business.name']);
  });

  it('rejects the WHOLE batch (all-or-nothing) and lists every offender when mixed with valid keys', () => {
    const result = validateSettingsUpdates(
      [
        { key: 'business.name', value: 'Acme' },
        { key: 'unknown.key', value: 'x' },
        { key: 'wc.url', value: 'https://evil.example.com' }, // env-locked in this scenario
      ],
      new Set(['wc.url']),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offenders).toEqual(['unknown.key', 'wc.url']);
  });
});

describe('invalidSettingsValues numeric bounds', () => {
  it('accepts inclusive minimum and maximum boundary values', () => {
    expect(
      invalidSettingsValues([
        { entry: entry('llm.input_cost_per_million'), raw: 0 },
        { entry: entry('llm.output_cost_per_million'), raw: MAX_LLM_COST_PER_MILLION_USD },
        { entry: entry('payment.tolerance'), raw: MAX_PAYMENT_TOLERANCE },
      ]),
    ).toEqual([]);
  });

  it('rejects finite values below min or above max', () => {
    expect(
      invalidSettingsValues([
        { entry: entry('llm.input_cost_per_million'), raw: -0.01 },
        { entry: entry('llm.output_cost_per_million'), raw: MAX_LLM_COST_PER_MILLION_USD + 0.01 },
        { entry: entry('payment.tolerance'), raw: MAX_PAYMENT_TOLERANCE + 1 },
      ]),
    ).toEqual(['llm.input_cost_per_million', 'llm.output_cost_per_million', 'payment.tolerance']);
  });
});
