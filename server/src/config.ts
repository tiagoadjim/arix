import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env from the repo root (one level above server/) for local dev.
// In Docker the values arrive via env_file, so this is a no-op there.
const here = dirname(fileURLToPath(import.meta.url)); // server/src
const repoRoot = resolve(here, '../..'); // repo root
dotenv.config({ path: resolve(repoRoot, '.env'), override: false });
dotenv.config({ override: false }); // also pick up ./.env if present

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : /^(1|true|yes|on)$/i.test(v)));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const schema = z.object({
  // LLM (OpenAI-compatible API; MiniMax by default). A later phase adds a
  // multi-provider registry — for now this is a single provider read from env.
  LLM_API_KEY: z.string().min(1, 'LLM_API_KEY is required'),
  LLM_BASE_URL: z.string().url().default('https://api.minimax.io/v1'),
  LLM_MODEL: z.string().default('MiniMax-M3'),
  // M3 is a thinking model. With reasoning_split=true the thinking is returned in
  // separate fields (reasoning_content/reasoning_details) instead of inline
  // <think> inside content. OPT-IN, OFF by default: M3's tool-calling degrades in
  // that mode unless reasoning_details is round-tripped back in the history on
  // every turn, which the agent doesn't persist (it stores plain text only). With
  // it off, M3 inlines <think> and stripThinking() keeps it out of the reply.
  LLM_REASONING_SPLIT: bool(false),
  // Escape hatch: hard-disable thinking on M3 (faster/cheaper, zero leak risk).
  LLM_THINKING_DISABLED: bool(false),

  // WooCommerce (headless): WC_URL = WordPress/REST domain; WC_FRONT_URL = storefront.
  WC_URL: z.string().url(),
  // Optional: no default. When unset, productLink() falls back to WC_URL (a
  // later phase switches to the product's own `permalink` from the API).
  WC_FRONT_URL: z.string().url().optional(),
  WC_CONSUMER_KEY: z.string().min(1),
  WC_CONSUMER_SECRET: z.string().min(1),
  WC_CURRENCY: z.string().default('ARS'),
  PAYMENT_AMOUNT_TOLERANCE: num(1),
  WC_STATUS_AFTER_PAYMENT: z.string().default('processing'),
  // Status set when staff dispatches an order from the dashboard.
  // Must be a status registered in WooCommerce (default: a custom 'en-camino').
  WC_STATUS_AFTER_DISPATCH: z.string().default('en-camino'),

  // Postgres
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Storage (receipt images on disk)
  RECEIPTS_DIR: z.string().default('./data/receipts'),

  // Auth (dashboard staff login)
  AUTH_JWT_SECRET: z.string().min(16, 'AUTH_JWT_SECRET must be at least 16 chars'),
  // Set true when serving the dashboard over HTTPS (recommended in production).
  COOKIE_SECURE: bool(false),

  // Server API
  PORT: num(3001),

  // WhatsApp
  WA_ACCOUNT_ID: z.string().default('default'),
  WA_MARK_ONLINE: bool(false),

  // Agent identity + behavior
  AGENT_NAME: z.string().default('Arix'),
  BUSINESS_NAME: z.string().default('My Store'),
  // Persona language for the system prompt + guardrails (see agent/prompt, agent/guardrails).
  AGENT_LANGUAGE: z.enum(['es', 'en']).default('es'),
  AGENT_HISTORY_LIMIT: num(30),
  // Wait this long after the LAST inbound message before replying, so several
  // quick messages get read together. Default 60s.
  AGENT_DEBOUNCE_MS: num(60_000),
  // Max WhatsApp bubbles the agent may split a reply into.
  AGENT_MAX_BUBBLES: num(3),
  // When true, the persona openly discloses it's an AI assistant instead of
  // presenting as a human teammate (see agent/prompt).
  AGENT_DISCLOSE_BOT: bool(false),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n\nSee .env.example.\n`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
