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

const boundedNum = (def: number, min: number, max: number, integer = true) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : Number(v)))
    .pipe(
      (integer ? z.number().int() : z.number())
        .finite()
        .min(min)
        .max(max),
    );

// Same coercion as bool()/boundedNum() above, but leaving the field genuinely unset
// (undefined) instead of applying a default — used for every setting that the
// runtime config service (server/src/config/runtime.ts) now owns the default
// for. "Unset" has to stay distinguishable from "explicitly set to the
// default value" so env > DB > schema-default precedence works.
const boolOpt = () =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? undefined : /^(1|true|yes|on)$/i.test(v)));

const numOpt = () =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? undefined : Number(v)))
    .refine((v) => v === undefined || Number.isFinite(v), { message: 'must be a finite number' });

const schema = z.object({
  // ---- Required infra --------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AUTH_JWT_SECRET: z.string().min(16, 'AUTH_JWT_SECRET must be at least 16 chars'),
  // One-shot bootstrap credential for creating the very first administrator.
  // It is intentionally env-only and must be entered in the setup wizard;
  // never expose it to the dashboard container as a runtime environment value.
  SETUP_TOKEN: z.string().min(32, 'SETUP_TOKEN must be at least 32 chars'),
  // Separate, rotatable data-encryption key. Falling back to AUTH_JWT_SECRET
  // remains supported for upgrades, but production deployments should set it.
  SETTINGS_ENCRYPTION_KEY: z.string().min(32).optional(),
  SETTINGS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),

  // ---- Runtime-config seeds (all optional — see server/src/config/runtime.ts) --
  // Every field below only SEEDS the DB-backed settings service on first boot
  // (and keeps winning while set — env > DB > default). None of them has a
  // zod default: "unset" must stay distinguishable from "the schema default".
  // A deployment with none of these set still boots — it just starts
  // unconfigured until the dashboard/setup-wizard fills them in.
  LLM_PROVIDER: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_REASONING_SPLIT: boolOpt(),
  LLM_THINKING_DISABLED: boolOpt(),

  WC_URL: z.string().url().optional(),
  WC_FRONT_URL: z.string().url().optional(),
  WC_CONSUMER_KEY: z.string().optional(),
  WC_CONSUMER_SECRET: z.string().optional(),
  WC_CURRENCY: z.string().optional(),
  WC_STATUS_AFTER_PAYMENT: z.string().optional(),
  WC_STATUS_AFTER_DISPATCH: z.string().optional(),
  PAYMENT_AMOUNT_TOLERANCE: numOpt(),

  BUSINESS_NAME: z.string().optional(),
  BUSINESS_TIMEZONE: z.string().optional(),
  AGENT_NAME: z.string().optional(),
  AGENT_LANGUAGE: z.enum(['es', 'en']).optional(),
  AGENT_DISCLOSE_BOT: boolOpt(),

  // ---- Infra with defaults (never seeds a runtime setting) -------------------
  // Postgres
  // (DATABASE_URL is above, required)
  PG_CONNECT_TIMEOUT_MS: boundedNum(10_000, 1_000, 120_000),
  PG_STATEMENT_TIMEOUT_MS: boundedNum(30_000, 1_000, 300_000),
  PG_IDLE_TIMEOUT_MS: boundedNum(30_000, 1_000, 300_000),

  // Storage (receipt images on disk)
  RECEIPTS_DIR: z.string().default('./data/receipts'),
  MAX_MEDIA_BYTES: boundedNum(10 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
  MEDIA_DOWNLOAD_TIMEOUT_MS: boundedNum(30_000, 1_000, 120_000),
  MAX_IMAGE_PIXELS: boundedNum(25_000_000, 1_000_000, 100_000_000),
  MAX_IMAGE_DIMENSION: boundedNum(12_000, 1_024, 50_000),
  MAX_PDF_BYTES: boundedNum(10 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
  PDF_TIMEOUT_MS: boundedNum(15_000, 1_000, 120_000),
  RECEIPT_RETENTION_DAYS: boundedNum(90, 0, 3_650),

  // Remote integrations are public HTTPS by default. Self-hosted/LAN stores
  // must opt in explicitly instead of silently exposing an SSRF primitive.
  ALLOW_PRIVATE_NETWORKS: bool(false),
  ALLOW_INSECURE_HTTP: bool(false),

  // Set true when serving the dashboard over HTTPS (recommended in production).
  COOKIE_SECURE: bool(false),

  // Server API
  PORT: boundedNum(3001, 1, 65_535),
  // Trust exactly one reverse-proxy hop for req.ip/X-Forwarded-For. Keep false
  // if clients can reach the API port directly.
  TRUST_PROXY: bool(false),

  // WhatsApp
  WA_ACCOUNT_ID: z.string().default('default'),
  WA_MARK_ONLINE: bool(false),
  // Pairing QR text is credential-equivalent; keep it out of retained logs by
  // default and display it only in the authenticated dashboard.
  WA_QR_TERMINAL: bool(false),

  // Agent behavior that stays env-only (not dashboard-configurable settings —
  // see server/src/config/settings-schema.ts for what IS).
  AGENT_HISTORY_LIMIT: boundedNum(30, 1, 200),
  // Wait this long after the LAST inbound message before replying, so several
  // quick messages get read together. Default 60s.
  AGENT_DEBOUNCE_MS: boundedNum(60_000, 0, 600_000),
  // Max WhatsApp bubbles the agent may split a reply into.
  AGENT_MAX_BUBBLES: boundedNum(3, 1, 10),
  AGENT_TURN_TIMEOUT_MS: boundedNum(90_000, 5_000, 300_000),
  AGENT_RECOVERY_CONCURRENCY: boundedNum(3, 1, 20),
  AGENT_RECOVERY_BATCH_SIZE: boundedNum(50, 1, 500),
  OUTBOX_RECOVERY_INTERVAL_MS: boundedNum(30_000, 5_000, 300_000),
  SHUTDOWN_TIMEOUT_MS: boundedNum(15_000, 5_000, 60_000),

  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`\n❌ Invalid environment configuration:\n${issues}\n\nSee env.example.\n`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
