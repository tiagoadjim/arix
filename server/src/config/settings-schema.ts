import { AR_TZ, DEFAULT_DELIVERY_SCHEDULE, type Schedule } from '../agent/hours';

/**
 * Declarative registry of every runtime-configurable setting. This is the
 * single source of truth for:
 *  - which dot-namespaced keys exist in the `settings` table,
 *  - their value type (for parsing DB text / env strings into JS values),
 *  - which env var seeds them on first boot (and keeps winning while it's set),
 *  - their default when neither env nor DB has a value,
 *  - which ones hold secrets (encrypted at rest, never sent to the browser).
 *
 * server/src/config/runtime.ts resolves these into typed getters
 * (llm(), woo(), businessProfile(), …). This file has no logic — it's data,
 * read by runtime.ts and (later) the settings API/dashboard.
 */

export type SettingType = 'string' | 'boolean' | 'number' | 'json' | 'enum';

/** Generous safety ceilings: far above normal commercial rates/tolerances,
 * but finite enough to reject accidental exponent/zero mistakes and abusive
 * API writes before they affect analytics or receipt matching. */
export const MAX_LLM_COST_PER_MILLION_USD = 10_000;
export const MAX_PAYMENT_TOLERANCE = 1_000;

/** Highest screen index the first-run wizard can park on. Keeping the bound in
 * the schema means a bogus write is rejected by the ordinary settings
 * validation rather than being able to strand the wizard on a screen that
 * doesn't exist. Must be >= the dashboard's last wizard step. */
export const MAX_SETUP_STEP = 20;

export interface SettingDefinition<T = unknown> {
  /** Dot-namespaced DB row key, e.g. "llm.api_key". */
  key: string;
  /** Namespace prefix (the part before the first dot) — used for grouping in the UI. */
  group: string;
  type: SettingType;
  /** True for values that must be encrypted at rest and never returned in plaintext. */
  secret?: true;
  /** Env var that seeds this setting. Precedence while set: env > DB > default. */
  seedEnv?: string;
  /** Value used when neither env nor a DB row supplies one. */
  default: T;
  /** Allowed values, only for type: 'enum'. */
  enumValues?: readonly string[];
  /** Inclusive numeric bounds, only meaningful for type: 'number'. */
  min?: number;
  max?: number;
  /** Human label (dashboard UI, later phases). */
  label: string;
}

export const SETTINGS_SCHEMA: readonly SettingDefinition[] = [
  // ---- LLM provider ---------------------------------------------------------
  {
    key: 'llm.provider',
    group: 'llm',
    type: 'enum',
    enumValues: ['openai', 'anthropic', 'gemini', 'deepseek', 'minimax'],
    default: 'minimax',
    seedEnv: 'LLM_PROVIDER',
    label: 'LLM provider',
  },
  {
    key: 'llm.api_key',
    group: 'llm',
    type: 'string',
    secret: true,
    default: '',
    seedEnv: 'LLM_API_KEY',
    label: 'LLM API key',
  },
  {
    key: 'llm.model',
    group: 'llm',
    type: 'string',
    // '' means "use the provider's default model".
    default: '',
    seedEnv: 'LLM_MODEL',
    label: 'LLM model',
  },
  {
    key: 'llm.base_url',
    group: 'llm',
    type: 'string',
    // '' means "use the provider's default base URL".
    default: '',
    seedEnv: 'LLM_BASE_URL',
    label: 'LLM base URL',
  },
  {
    key: 'llm.reasoning_split',
    group: 'llm',
    type: 'boolean',
    default: false,
    seedEnv: 'LLM_REASONING_SPLIT',
    label: 'Split reasoning from the visible reply (provider-specific)',
  },
  {
    key: 'llm.thinking_disabled',
    group: 'llm',
    type: 'boolean',
    default: false,
    seedEnv: 'LLM_THINKING_DISABLED',
    label: 'Hard-disable model "thinking" (provider-specific)',
  },
  {
    key: 'llm.vision_fallback',
    group: 'llm',
    type: 'enum',
    enumValues: ['ask_details', 'handoff'],
    default: 'ask_details',
    label: 'What to do when the model/config has no vision support',
  },
  {
    key: 'llm.input_cost_per_million',
    group: 'llm',
    type: 'number',
    min: 0,
    max: MAX_LLM_COST_PER_MILLION_USD,
    default: 0,
    label: 'Input-token cost in USD per million tokens (optional estimate)',
  },
  {
    key: 'llm.output_cost_per_million',
    group: 'llm',
    type: 'number',
    min: 0,
    max: MAX_LLM_COST_PER_MILLION_USD,
    default: 0,
    label: 'Output-token cost in USD per million tokens (optional estimate)',
  },

  // ---- WooCommerce ------------------------------------------------------------
  {
    key: 'wc.url',
    group: 'wc',
    type: 'string',
    default: '',
    seedEnv: 'WC_URL',
    label: 'WooCommerce site URL (WordPress/REST domain)',
  },
  {
    key: 'wc.consumer_key',
    group: 'wc',
    type: 'string',
    secret: true,
    default: '',
    seedEnv: 'WC_CONSUMER_KEY',
    label: 'WooCommerce consumer key',
  },
  {
    key: 'wc.consumer_secret',
    group: 'wc',
    type: 'string',
    secret: true,
    default: '',
    seedEnv: 'WC_CONSUMER_SECRET',
    label: 'WooCommerce consumer secret',
  },
  {
    key: 'wc.front_url',
    group: 'wc',
    type: 'string',
    default: '',
    seedEnv: 'WC_FRONT_URL',
    label: 'Storefront URL (if different from the REST domain)',
  },
  {
    key: 'wc.currency',
    group: 'wc',
    type: 'string',
    default: 'USD',
    seedEnv: 'WC_CURRENCY',
    label: 'Store currency',
  },
  {
    key: 'wc.status_after_payment',
    group: 'wc',
    type: 'string',
    default: 'processing',
    seedEnv: 'WC_STATUS_AFTER_PAYMENT',
    label: 'Order status set once a payment is confirmed',
  },
  {
    key: 'wc.status_after_dispatch',
    group: 'wc',
    type: 'string',
    // '' = the dispatch feature sets no custom status (message still sends).
    default: '',
    seedEnv: 'WC_STATUS_AFTER_DISPATCH',
    label: 'Order status set once staff dispatches an order',
  },
  {
    key: 'wc.product_link_template',
    group: 'wc',
    type: 'string',
    // Fallback ONLY for when a product's own `permalink` is missing from the
    // Woo API response (see skills/catalog.ts's productLink()). Supports
    // {base} (wc.front_url, falling back to wc.url) and {slug} placeholders.
    default: '{base}/producto/{slug}',
    label: 'Product page URL template — fallback when the API permalink is missing ({base}, {slug})',
  },
  {
    key: 'payment.tolerance',
    group: 'payment',
    type: 'number',
    min: 0,
    max: MAX_PAYMENT_TOLERANCE,
    default: 1,
    seedEnv: 'PAYMENT_AMOUNT_TOLERANCE',
    label: 'Absolute amount tolerance when matching a transfer receipt',
  },
  {
    key: 'payment.auto_confirm',
    group: 'payment',
    type: 'boolean',
    default: false,
    seedEnv: 'PAYMENT_AUTO_CONFIRM',
    label: 'Automatically mark matched receipts as paid (unsafe unless independently reconciled)',
  },

  // ---- Business profile ---------------------------------------------------------
  {
    key: 'business.name',
    group: 'business',
    type: 'string',
    default: 'My Store',
    seedEnv: 'BUSINESS_NAME',
    label: 'Business name',
  },
  {
    key: 'business.timezone',
    group: 'business',
    type: 'string',
    default: AR_TZ,
    seedEnv: 'BUSINESS_TIMEZONE',
    label: 'Business IANA timezone',
  },
  {
    key: 'business.hours',
    group: 'business',
    type: 'json',
    default: DEFAULT_DELIVERY_SCHEDULE as unknown as Schedule,
    label: 'Weekly delivery schedule',
  },
  {
    key: 'agent.name',
    group: 'agent',
    type: 'string',
    default: 'Arix',
    seedEnv: 'AGENT_NAME',
    label: 'Agent display name',
  },
  {
    key: 'agent.language',
    group: 'agent',
    type: 'enum',
    enumValues: ['es', 'en'],
    default: 'es',
    seedEnv: 'AGENT_LANGUAGE',
    label: 'Agent persona language',
  },
  {
    key: 'agent.disclose_bot',
    group: 'agent',
    type: 'boolean',
    default: false,
    seedEnv: 'AGENT_DISCLOSE_BOT',
    label: 'Agent discloses it is an AI assistant',
  },

  // ---- Info blocks + templates (dashboard-editable text, no env seed) --------
  {
    key: 'info.payment',
    group: 'info',
    type: 'string',
    default: '',
    label: 'Payment methods info block',
  },
  {
    key: 'info.shipping',
    group: 'info',
    type: 'string',
    default: '',
    label: 'Shipping info block',
  },
  {
    key: 'info.general',
    group: 'info',
    type: 'string',
    default: '',
    label: 'General info / FAQ block',
  },
  {
    key: 'dispatch.template',
    group: 'dispatch',
    type: 'string',
    default: '',
    label: 'WhatsApp dispatch message template',
  },
  {
    key: 'compliance.rules',
    group: 'compliance',
    type: 'string',
    default: '',
    label: 'Extra compliance text injected into the system prompt',
  },

  // ---- Skills + MCP ------------------------------------------------------------
  {
    key: 'skills.enabled',
    group: 'skills',
    type: 'json',
    // Default is every built-in skill — see skills/registry.ts. Stored as a
    // JSON string array of skill ids (e.g. ["catalog","orders","payments","handoff"]).
    default: ['catalog', 'orders', 'payments', 'handoff'],
    seedEnv: 'SKILLS_ENABLED',
    label: 'Enabled built-in agent skills',
  },
  {
    key: 'mcp.servers',
    group: 'mcp',
    type: 'json',
    // Encrypt the entire blob at rest because HTTP headers commonly contain
    // bearer tokens/API keys. The dashboard receives a custom redacted DTO.
    secret: true,
    // Array of McpServerConfig (see mcp/types.ts). Empty by default — operators
    // add servers from the dashboard / setup wizard.
    default: [] as unknown[],
    seedEnv: 'MCP_SERVERS',
    label: 'MCP (Model Context Protocol) servers',
  },

  // ---- Onboarding --------------------------------------------------------------
  {
    key: 'setup.completed',
    group: 'setup',
    type: 'boolean',
    default: false,
    label: 'First-run setup wizard completed',
  },
  {
    key: 'setup.step',
    group: 'setup',
    type: 'number',
    min: 0,
    max: MAX_SETUP_STEP,
    // Resume cursor for the first-run wizard. 0 means "not started"; the wizard
    // writes the screen it is currently on so a refresh (or the round trip
    // through WooCommerce's authorization page) comes back to the same place
    // instead of restarting. Meaningless once setup.completed is true.
    default: 0,
    label: 'First-run setup wizard resume step',
  },
] as const;

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  SETTINGS_SCHEMA.map((s) => [s.key, s]),
);

/** True for a finite number inside the schema entry's inclusive bounds. */
export function isNumberWithinBounds(entry: SettingDefinition, value: number): boolean {
  return (
    Number.isFinite(value) &&
    (entry.min === undefined || value >= entry.min) &&
    (entry.max === undefined || value <= entry.max)
  );
}

/** True if `key` is registered and marked as holding a secret value. */
export function isSecretKey(key: string): boolean {
  return SETTINGS_BY_KEY.get(key)?.secret === true;
}
