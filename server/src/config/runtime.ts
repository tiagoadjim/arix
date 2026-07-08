import { logger } from '../logger';
import { getSettings, upsertSetting } from '../db/repo';
import { decryptSecret, encryptSecret } from './secret';
import { SETTINGS_SCHEMA, type SettingDefinition } from './settings-schema';
import type { Schedule } from '../agent/hours';

/**
 * Runtime config service — the backbone the rest of the app reads operable
 * settings through (LLM provider/creds, WooCommerce creds, business profile,
 * delivery hours, info blocks). Precedence per key: env seed > DB row >
 * schema default.
 *
 * Resolution is cached in-process after the first call and only refreshed
 * when invalidate() is called (every settings write must call it — see
 * PUT /api/settings). If the DB is unreachable when resolving (e.g. a
 * transient blip, or no `settings` rows yet), we degrade to env/defaults
 * instead of throwing: a lazily-resolved LLM/Woo client failing open to
 * "unconfigured" is much safer than crashing message handling.
 */

export type SettingSource = 'env' | 'db' | 'default';

export interface ResolvedEntry {
  value: unknown;
  source: SettingSource;
}

/** Full resolved snapshot, keyed by settings-schema key, with provenance. */
export type ResolvedMeta = Record<string, ResolvedEntry>;

/** Same snapshot, values only (no provenance) — a plain settings map. */
export type ResolvedSettings = Record<string, unknown>;

let resolvedCache: ResolvedMeta | null = null;
let inflight: Promise<ResolvedMeta> | null = null;
let version = 0;

/** Drop the cached resolution so the next read reflects fresh DB/env state.
 * MUST be called after every settings write (dashboard PUT, setup wizard). */
export function invalidate(): void {
  resolvedCache = null;
  inflight = null;
  version += 1;
}

/** Monotonically bumped by invalidate() — lets lazy clients (LLM/Woo) know
 * their memoized snapshot is stale without re-resolving settings themselves. */
export function settingsVersion(): number {
  return version;
}

async function loadDbRows(): Promise<Record<string, string>> {
  try {
    return await getSettings();
  } catch (err) {
    logger.warn({ err }, 'settings: could not read from the database — falling back to env/defaults');
    return {};
  }
}

/** Raw env string for a seedEnv name, or undefined when unset/empty. Reads
 * `process.env` directly (NOT config.ts's parsed snapshot) so a settings
 * write followed by invalidate() — or a test stubbing process.env — is
 * always reflected on the next resolution, with no import-order caveat. */
function rawEnv(seedEnv: string): string | undefined {
  const v = process.env[seedEnv];
  return v === undefined || v === '' ? undefined : v;
}

function envIsSet(entry: SettingDefinition): boolean {
  return Boolean(entry.seedEnv && rawEnv(entry.seedEnv) !== undefined);
}

/** Parse a raw TEXT value — from an env var or a `settings` DB row — into its
 * schema type. The same parser handles both sources: they're both just
 * strings on the wire, only the schema entry says how to interpret them. */
function parseRawValue(entry: SettingDefinition, raw: string): unknown {
  switch (entry.type) {
    case 'boolean':
      return /^(1|true|yes|on)$/i.test(raw);
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : entry.default;
    }
    case 'json':
      try {
        return JSON.parse(raw);
      } catch (err) {
        logger.warn({ err, key: entry.key }, 'settings: malformed JSON in DB row — using default');
        return entry.default;
      }
    case 'enum':
      return entry.enumValues?.includes(raw) ? raw : entry.default;
    case 'string':
    default:
      return raw;
  }
}

/** Decrypt a secret DB value, degrading to '' (== unconfigured) instead of
 * throwing when AUTH_JWT_SECRET was rotated or the ciphertext is corrupt. */
function decryptSecretSafe(raw: string, key: string): string {
  try {
    return decryptSecret(raw);
  } catch (err) {
    logger.warn(
      { err, key },
      'settings: failed to decrypt a stored secret (AUTH_JWT_SECRET rotated?) — treating as unset',
    );
    return '';
  }
}

async function resolveAll(): Promise<ResolvedMeta> {
  const dbRows = await loadDbRows();
  const out: ResolvedMeta = {};
  for (const entry of SETTINGS_SCHEMA) {
    const envRaw = entry.seedEnv ? rawEnv(entry.seedEnv) : undefined;
    if (envRaw !== undefined) {
      out[entry.key] = { value: parseRawValue(entry, envRaw), source: 'env' };
      continue;
    }
    const dbRaw = dbRows[entry.key];
    if (dbRaw !== undefined) {
      const raw = entry.secret ? decryptSecretSafe(dbRaw, entry.key) : dbRaw;
      out[entry.key] = { value: parseRawValue(entry, raw), source: 'db' };
      continue;
    }
    out[entry.key] = { value: entry.default, source: 'default' };
  }
  return out;
}

async function resolve(): Promise<ResolvedMeta> {
  if (resolvedCache) return resolvedCache;
  if (!inflight) {
    inflight = resolveAll().then((r) => {
      resolvedCache = r;
      inflight = null;
      return r;
    });
  }
  return inflight;
}

/** Full resolved snapshot with provenance (env/db/default) per key — the
 * shape Phase 6's sanitized settings DTO reads from. */
export async function getResolvedWithMeta(): Promise<ResolvedMeta> {
  return resolve();
}

/** Full resolved snapshot, values only. */
export async function getResolved(): Promise<ResolvedSettings> {
  const meta = await resolve();
  const out: ResolvedSettings = {};
  for (const [k, v] of Object.entries(meta)) out[k] = v.value;
  return out;
}

function valueOf<T>(meta: ResolvedMeta, key: string): T {
  const entry = meta[key];
  if (!entry) throw new Error(`settings: unknown key "${key}" (not in SETTINGS_SCHEMA)`);
  return entry.value as T;
}

// ---- Typed getters ------------------------------------------------------------

export interface LlmSettings {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  reasoningSplit: boolean;
  thinkingDisabled: boolean;
  visionFallback: 'ask_details' | 'handoff';
  /** True once an API key is set (env or DB) — the agent can actually call out. */
  configured: boolean;
}

export async function llm(): Promise<LlmSettings> {
  const meta = await resolve();
  const apiKey = valueOf<string>(meta, 'llm.api_key');
  return {
    provider: valueOf<string>(meta, 'llm.provider'),
    apiKey,
    model: valueOf<string>(meta, 'llm.model'),
    baseUrl: valueOf<string>(meta, 'llm.base_url'),
    reasoningSplit: valueOf<boolean>(meta, 'llm.reasoning_split'),
    thinkingDisabled: valueOf<boolean>(meta, 'llm.thinking_disabled'),
    visionFallback: valueOf<'ask_details' | 'handoff'>(meta, 'llm.vision_fallback'),
    configured: apiKey.trim().length > 0,
  };
}

export interface WooSettings {
  url: string;
  consumerKey: string;
  consumerSecret: string;
  frontUrl: string;
  currency: string;
  statusAfterPayment: string;
  statusAfterDispatch: string;
  /** Fallback template for a product's page URL, only used when the Woo API
   * response has no usable `permalink` — see skills/catalog.ts's productLink(). */
  productLinkTemplate: string;
  tolerance: number;
  /** True once url + consumer key + consumer secret are all set. */
  configured: boolean;
}

export async function woo(): Promise<WooSettings> {
  const meta = await resolve();
  const url = valueOf<string>(meta, 'wc.url');
  const consumerKey = valueOf<string>(meta, 'wc.consumer_key');
  const consumerSecret = valueOf<string>(meta, 'wc.consumer_secret');
  return {
    url,
    consumerKey,
    consumerSecret,
    frontUrl: valueOf<string>(meta, 'wc.front_url'),
    currency: valueOf<string>(meta, 'wc.currency'),
    statusAfterPayment: valueOf<string>(meta, 'wc.status_after_payment'),
    statusAfterDispatch: valueOf<string>(meta, 'wc.status_after_dispatch'),
    productLinkTemplate: valueOf<string>(meta, 'wc.product_link_template'),
    tolerance: valueOf<number>(meta, 'payment.tolerance'),
    configured: Boolean(url.trim() && consumerKey.trim() && consumerSecret.trim()),
  };
}

export interface BusinessProfile {
  businessName: string;
  agentName: string;
  language: 'es' | 'en';
  discloseBot: boolean;
  timezone: string;
}

export async function businessProfile(): Promise<BusinessProfile> {
  const meta = await resolve();
  return {
    businessName: valueOf<string>(meta, 'business.name'),
    agentName: valueOf<string>(meta, 'agent.name'),
    language: valueOf<'es' | 'en'>(meta, 'agent.language'),
    discloseBot: valueOf<boolean>(meta, 'agent.disclose_bot'),
    timezone: valueOf<string>(meta, 'business.timezone'),
  };
}

/** The weekly delivery schedule (see agent/hours.ts's Schedule shape). */
export async function hoursConfig(): Promise<Schedule> {
  const meta = await resolve();
  return valueOf<Schedule>(meta, 'business.hours');
}

export interface InfoBlocks {
  payment: string;
  shipping: string;
  general: string;
}

export async function infoBlocks(): Promise<InfoBlocks> {
  const meta = await resolve();
  return {
    payment: valueOf<string>(meta, 'info.payment'),
    shipping: valueOf<string>(meta, 'info.shipping'),
    general: valueOf<string>(meta, 'info.general'),
  };
}

export async function dispatchTemplate(): Promise<string> {
  const meta = await resolve();
  return valueOf<string>(meta, 'dispatch.template');
}

export async function complianceRules(): Promise<string> {
  const meta = await resolve();
  return valueOf<string>(meta, 'compliance.rules');
}

/** Whether the first-run setup wizard has been completed (setup.completed). */
export async function setupCompleted(): Promise<boolean> {
  const meta = await resolve();
  return valueOf<boolean>(meta, 'setup.completed');
}

// ---- First-boot env seeding + introspection ------------------------------------

/**
 * For every schema entry with a seedEnv that's currently set AND has no
 * existing DB row, insert one (secrets encrypted). Keeps env-driven deploys
 * working exactly as before while giving the dashboard a DB row to take over
 * once the env var is eventually removed. Call once, after migrate().
 */
export async function seedFromEnvOnFirstBoot(): Promise<void> {
  const dbRows = await loadDbRows();
  for (const entry of SETTINGS_SCHEMA) {
    if (!entry.seedEnv) continue;
    const raw = rawEnv(entry.seedEnv);
    if (raw === undefined) continue;
    if (dbRows[entry.key] !== undefined) continue; // already has a DB row — never overwrite

    const stored = entry.secret ? encryptSecret(raw) : raw;
    try {
      await upsertSetting(entry.key, stored);
      logger.info({ key: entry.key }, 'settings: seeded from env on first boot');
    } catch (err) {
      logger.warn({ err, key: entry.key }, 'settings: failed to seed from env');
    }
  }
}

/** Keys whose seedEnv is currently set in the environment — later phases
 * (the settings dashboard) render these fields read-only. */
export function envLockedKeys(): string[] {
  return SETTINGS_SCHEMA.filter((e) => envIsSet(e)).map((e) => e.key);
}
