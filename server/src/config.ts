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
  // Minimax
  MINIMAX_API_KEY: z.string().min(1, 'MINIMAX_API_KEY is required'),
  MINIMAX_BASE_URL: z.string().url().default('https://api.minimax.io/v1'),
  MINIMAX_MODEL: z.string().default('MiniMax-M3'),
  MINIMAX_MODEL_FAST: z.string().default('MiniMax-M3'),
  // M3 is a thinking model. With reasoning_split=true the thinking is returned in
  // separate fields (reasoning_content/reasoning_details) instead of inline
  // <think> inside content. OPT-IN, OFF by default: M3's tool-calling degrades in
  // that mode unless reasoning_details is round-tripped back in the history on
  // every turn, which Nico doesn't persist (it stores plain text only). With it
  // off, M3 inlines <think> and stripThinking() keeps it out of the reply.
  MINIMAX_REASONING_SPLIT: bool(false),
  // Escape hatch: hard-disable thinking on M3 (faster/cheaper, zero leak risk).
  MINIMAX_THINKING_DISABLED: bool(false),

  // WooCommerce (headless): WC_URL = WordPress/REST domain; WC_FRONT_URL = storefront.
  WC_URL: z.string().url(),
  WC_FRONT_URL: z.string().url().default('https://shop.vapenic.com.ar'),
  WC_CONSUMER_KEY: z.string().min(1),
  WC_CONSUMER_SECRET: z.string().min(1),
  WC_CURRENCY: z.string().default('ARS'),
  PAYMENT_AMOUNT_TOLERANCE: num(1),
  WC_STATUS_AFTER_PAYMENT: z.string().default('processing'),
  // Status set when staff dispatches an order via Uber Moto from the dashboard.
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
  WA_ACCOUNT_ID: z.string().default('vapenic-main'),
  WA_MARK_ONLINE: bool(false),

  // Nico
  NICO_NAME: z.string().default('Nico'),
  NICO_BUSINESS: z.string().default('Vapenic'),
  NICO_HISTORY_LIMIT: num(30),
  // Wait this long after the LAST inbound message before replying, so several
  // quick messages get read together. Default 60s.
  NICO_DEBOUNCE_MS: num(60_000),
  // Max WhatsApp bubbles Nico may split a reply into.
  NICO_MAX_BUBBLES: num(3),
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
