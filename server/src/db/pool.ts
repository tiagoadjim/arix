import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config';
import { logger } from '../logger';

// numeric(12,2) comes back as a string by default — parse to JS number.
pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
pool.on('error', (err) => logger.error({ err }, 'pg pool error'));

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

/** Migration filenames sorted lexically (0001_*, 0002_*, …). */
function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Apply pending migrations from server/src/db/migrations/*.sql.
 *
 * Tracks applied versions in a `schema_migrations` table (created on first
 * run). Each migration file runs inside its own transaction — its SQL plus the
 * bookkeeping insert commit together, or neither does. Safe to call on every
 * boot: already-applied versions are skipped, so this is idempotent.
 */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `create table if not exists schema_migrations (
         version text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const { rows } = await client.query<{ version: string }>(
      'select version from schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.version));

    for (const file of listMigrationFiles()) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (version) values ($1)', [version]);
        await client.query('commit');
        logger.info({ version }, 'migration applied');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    client.release();
  }
  logger.info('database schema ready');
}

export async function many<T>(text: string, params?: unknown[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await many<T>(text, params);
  return rows[0] ?? null;
}
