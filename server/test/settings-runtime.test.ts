import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock at the repo boundary (same style as confirm-payment.test.ts) so no real
// Postgres connection is attempted — runtime.ts calls db/repo's getSettings/
// upsertSetting, never `pg` directly.
const { getSettings, upsertSetting } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  upsertSetting: vi.fn(),
}));
vi.mock('../src/db/repo', () => ({ getSettings, upsertSetting }));

import {
  invalidate,
  settingsVersion,
  llm,
  woo,
  businessProfile,
  hoursConfig,
  infoBlocks,
  envLockedKeys,
  seedFromEnvOnFirstBoot,
  rotateStoredSecrets,
} from '../src/config/runtime';
import { decryptSecret, encryptSecret } from '../src/config/secret';
import { config } from '../src/config';
import { DEFAULT_DELIVERY_SCHEDULE } from '../src/agent/hours';

type MutableEncryptionConfig = {
  SETTINGS_ENCRYPTION_KEY?: string;
  SETTINGS_ENCRYPTION_KEY_PREVIOUS?: string;
};

async function withEncryptionKeys<T>(
  overrides: MutableEncryptionConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const mutable = config as MutableEncryptionConfig;
  const previous = {
    SETTINGS_ENCRYPTION_KEY: mutable.SETTINGS_ENCRYPTION_KEY,
    SETTINGS_ENCRYPTION_KEY_PREVIOUS: mutable.SETTINGS_ENCRYPTION_KEY_PREVIOUS,
  };
  Object.assign(mutable, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(mutable, previous);
  }
}

/** Temporarily set/unset env vars for the duration of `fn`, then restore. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    const next = overrides[k];
    if (next === undefined) delete process.env[k];
    else process.env[k] = next;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      const restore = prev[k];
      if (restore === undefined) delete process.env[k];
      else process.env[k] = restore;
    }
  }
}

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({});
  upsertSetting.mockReset().mockResolvedValue(undefined);
  invalidate();
});

afterEach(() => {
  invalidate();
});

describe('precedence: env seed > DB > default', () => {
  it('falls back to the schema default when neither env nor DB has a value', async () => {
    getSettings.mockResolvedValue({});
    const profile = await businessProfile();
    expect(profile.agentName).toBe('Arix'); // default
    expect(profile.businessName).toBe('My Store'); // default
  });

  it('a DB row wins over the default when env is unset', async () => {
    await withEnv({ AGENT_NAME: undefined }, async () => {
      getSettings.mockResolvedValue({ 'agent.name': 'FromDatabase' });
      invalidate();
      const profile = await businessProfile();
      expect(profile.agentName).toBe('FromDatabase');
    });
  });

  it('an env seed wins over a DB value', async () => {
    await withEnv({ AGENT_NAME: 'FromEnv' }, async () => {
      getSettings.mockResolvedValue({ 'agent.name': 'FromDatabase' });
      invalidate();
      const profile = await businessProfile();
      expect(profile.agentName).toBe('FromEnv');
    });
  });

  it('resolves booleans and enums from the DB, not just strings', async () => {
    await withEnv({ AGENT_LANGUAGE: undefined }, async () => {
      getSettings.mockResolvedValue({ 'agent.language': 'en', 'agent.disclose_bot': 'true' });
      invalidate();
      const profile = await businessProfile();
      expect(profile.language).toBe('en');
      expect(profile.discloseBot).toBe(true);
    });
  });

  it('an invalid enum value in the DB falls back to the default rather than crashing', async () => {
    await withEnv({ AGENT_LANGUAGE: undefined }, async () => {
      getSettings.mockResolvedValue({ 'agent.language': 'not-a-real-language' });
      invalidate();
      const profile = await businessProfile();
      expect(profile.language).toBe('es');
    });
  });

  it('parses business.hours JSON from the DB', async () => {
    const custom = [null, [600, 900], null, null, null, null, null];
    getSettings.mockResolvedValue({ 'business.hours': JSON.stringify(custom) });
    const schedule = await hoursConfig();
    expect(schedule).toEqual(custom);
  });

  it('falls back to the default schedule on malformed business.hours JSON', async () => {
    getSettings.mockResolvedValue({ 'business.hours': 'not json' });
    const schedule = await hoursConfig();
    expect(schedule).toEqual(DEFAULT_DELIVERY_SCHEDULE);
  });
});

describe('secrets are decrypted when read from the DB', () => {
  it('decrypts an encrypted llm.api_key row (env unset)', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      getSettings.mockResolvedValue({ 'llm.api_key': encryptSecret('sk-from-db-real-key') });
      invalidate();
      const cfg = await llm();
      expect(cfg.apiKey).toBe('sk-from-db-real-key');
      expect(cfg.configured).toBe(true);
    });
  });

  it('tolerates a hand-edited plaintext secret in the DB (no enc: prefix)', async () => {
    await withEnv({ WC_CONSUMER_KEY: undefined, WC_CONSUMER_SECRET: undefined }, async () => {
      getSettings.mockResolvedValue({ 'wc.consumer_key': 'ck_plain', 'wc.consumer_secret': 'cs_plain' });
      invalidate();
      const cfg = await woo();
      expect(cfg.consumerKey).toBe('ck_plain');
      expect(cfg.consumerSecret).toBe('cs_plain');
    });
  });

  it('never leaks a raw ciphertext blob as the resolved value', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      const enc = encryptSecret('sk-should-be-decrypted');
      getSettings.mockResolvedValue({ 'llm.api_key': enc });
      invalidate();
      const cfg = await llm();
      expect(cfg.apiKey).not.toContain('enc:v2:');
      expect(cfg.apiKey).toBe('sk-should-be-decrypted');
    });
  });
});

describe('caching + invalidate()', () => {
  it('a second call hits the cache (no repeated DB read)', async () => {
    getSettings.mockResolvedValue({});
    await businessProfile();
    await businessProfile();
    await woo();
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next call to refetch', async () => {
    getSettings.mockResolvedValue({});
    await businessProfile();
    invalidate();
    await businessProfile();
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('invalidate() bumps settingsVersion()', () => {
    const before = settingsVersion();
    invalidate();
    expect(settingsVersion()).toBe(before + 1);
  });

  it('concurrent calls before the first resolution share one DB read', async () => {
    getSettings.mockResolvedValue({});
    await Promise.all([businessProfile(), woo(), llm(), infoBlocks()]);
    expect(getSettings).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale in-flight read repopulate the cache after invalidate()', async () => {
    let releaseOld!: (rows: Record<string, string>) => void;
    const oldRead = new Promise<Record<string, string>>((resolve) => {
      releaseOld = resolve;
    });
    getSettings
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce({ 'agent.name': 'Fresh generation' });

    const staleCall = businessProfile();
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));
    invalidate();
    const fresh = await businessProfile();
    expect(fresh.agentName).toBe('Fresh generation');

    releaseOld({ 'agent.name': 'Stale generation' });
    expect((await staleCall).agentName).toBe('Stale generation');
    expect((await businessProfile()).agentName).toBe('Fresh generation');
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});

describe('unconfigured detection', () => {
  it('llm().configured is false when no API key is set anywhere', async () => {
    await withEnv({ LLM_API_KEY: undefined }, async () => {
      getSettings.mockResolvedValue({});
      invalidate();
      const cfg = await llm();
      expect(cfg.configured).toBe(false);
      expect(cfg.apiKey).toBe('');
    });
  });

  it('llm().configured is true once an API key is set (env)', async () => {
    await withEnv({ LLM_API_KEY: 'sk-present' }, async () => {
      invalidate();
      const cfg = await llm();
      expect(cfg.configured).toBe(true);
    });
  });

  it('woo().configured is false unless url + both keys are all present', async () => {
    await withEnv({ WC_URL: undefined, WC_CONSUMER_KEY: undefined, WC_CONSUMER_SECRET: undefined }, async () => {
      getSettings.mockResolvedValue({ 'wc.url': 'https://shop.example.com' }); // missing keys
      invalidate();
      const cfg = await woo();
      expect(cfg.configured).toBe(false);
    });
  });
});

describe('envLockedKeys', () => {
  it('lists exactly the settings keys whose seedEnv is currently set', () => {
    expect(envLockedKeys()).toEqual(expect.arrayContaining(['llm.api_key', 'wc.url']));
  });

  it('excludes a key once its env var is unset', async () => {
    await withEnv({ AGENT_NAME: undefined }, async () => {
      expect(envLockedKeys()).not.toContain('agent.name');
    });
  });

  it('includes a key once its env var is set', async () => {
    await withEnv({ AGENT_NAME: 'Something' }, async () => {
      expect(envLockedKeys()).toContain('agent.name');
    });
  });
});

describe('seedFromEnvOnFirstBoot', () => {
  it('inserts a DB row for an env-seeded key with no existing row', async () => {
    await withEnv({ AGENT_NAME: 'SeedMe' }, async () => {
      getSettings.mockResolvedValue({});
      await seedFromEnvOnFirstBoot();
      expect(upsertSetting).toHaveBeenCalledWith('agent.name', 'SeedMe');
    });
  });

  it('encrypts secret keys before seeding them', async () => {
    await withEnv({ LLM_API_KEY: 'sk-seed-me' }, async () => {
      getSettings.mockResolvedValue({});
      await seedFromEnvOnFirstBoot();
      const call = upsertSetting.mock.calls.find((c) => c[0] === 'llm.api_key');
      expect(call?.[1]).toMatch(/^enc:v2:[A-Za-z0-9_-]{12}:/);
      expect(decryptSecret(call?.[1] as string)).toBe('sk-seed-me');
    });
  });

  it('does not overwrite a key that already has a DB row', async () => {
    await withEnv({ AGENT_NAME: 'SeedMe' }, async () => {
      getSettings.mockResolvedValue({ 'agent.name': 'AlreadyThere' });
      await seedFromEnvOnFirstBoot();
      expect(upsertSetting).not.toHaveBeenCalledWith('agent.name', expect.anything());
    });
  });

  it('skips keys with no seedEnv or whose env var is unset', async () => {
    await withEnv({ AGENT_NAME: undefined }, async () => {
      getSettings.mockResolvedValue({});
      await seedFromEnvOnFirstBoot();
      expect(upsertSetting).not.toHaveBeenCalledWith('agent.name', expect.anything());
      expect(upsertSetting).not.toHaveBeenCalledWith('info.payment', expect.anything());
    });
  });
});

describe('rotateStoredSecrets', () => {
  const oldKey = 'settings-old-key-0123456789abcdef-0123456789';
  const newKey = 'settings-new-key-0123456789abcdef-0123456789';

  it('rewrites plaintext and previous-key secret rows under the active v2 key in one boot pass', async () => {
    let previousKeyEnvelope = '';
    await withEncryptionKeys(
      { SETTINGS_ENCRYPTION_KEY: oldKey, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined },
      async () => {
        previousKeyEnvelope = encryptSecret('sk-on-old-key');
      },
    );

    await withEncryptionKeys(
      { SETTINGS_ENCRYPTION_KEY: newKey, SETTINGS_ENCRYPTION_KEY_PREVIOUS: oldKey },
      async () => {
        getSettings.mockResolvedValue({
          'llm.api_key': previousKeyEnvelope,
          'wc.consumer_secret': 'cs-hand-edited-plaintext',
          'business.name': 'not-a-secret',
        });
        const versionBefore = settingsVersion();

        await rotateStoredSecrets();

        expect(upsertSetting).toHaveBeenCalledTimes(2);
        const replacements = Object.fromEntries(upsertSetting.mock.calls);
        expect(replacements['llm.api_key']).toMatch(/^enc:v2:[A-Za-z0-9_-]{12}:/);
        expect(replacements['wc.consumer_secret']).toMatch(/^enc:v2:[A-Za-z0-9_-]{12}:/);
        expect(decryptSecret(replacements['llm.api_key'] as string)).toBe('sk-on-old-key');
        expect(decryptSecret(replacements['wc.consumer_secret'] as string)).toBe(
          'cs-hand-edited-plaintext',
        );
        expect(upsertSetting).not.toHaveBeenCalledWith('business.name', expect.anything());
        expect(settingsVersion()).toBe(versionBefore + 1);
      },
    );
  });

  it('does not rewrite active-key rows and leaves an undecryptable old envelope untouched', async () => {
    await withEncryptionKeys(
      { SETTINGS_ENCRYPTION_KEY: newKey, SETTINGS_ENCRYPTION_KEY_PREVIOUS: undefined },
      async () => {
        const current = encryptSecret('already-current');
        getSettings.mockResolvedValue({
          'llm.api_key': current,
          'wc.consumer_secret': 'enc:v2:missing-key-id:valid:looking:parts',
        });
        const versionBefore = settingsVersion();

        await rotateStoredSecrets();

        expect(upsertSetting).not.toHaveBeenCalled();
        expect(settingsVersion()).toBe(versionBefore);
      },
    );
  });
});
