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

/**
 * Candidate migrations directories, tried in order until one actually reads.
 *
 * `import.meta.url` resolves to this source file in dev (tsx runs each
 * module from its real path on disk), but to the tsup bundle's OWN path in
 * production — bundling inlines every module into a single dist/index.js, so
 * there's no separate file for pool.ts anymore, and `here` becomes dist/'s
 * directory regardless of where this code originally lived. MIGRATIONS_DIR is
 * an explicit override; the Dockerfile copies server/src/db/migrations to
 * <app>/db/migrations to satisfy the last candidate.
 */
function migrationsDirCandidates(): string[] {
  const candidates = [
    join(here, 'migrations'), // dev (tsx): server/src/db/migrations
    join(here, '../db/migrations'), // bundled: <app>/db/migrations, sibling of dist/
  ];
  return process.env.MIGRATIONS_DIR ? [process.env.MIGRATIONS_DIR, ...candidates] : candidates;
}

/** Migration filenames sorted lexically (0001_*, 0002_*, …), read from the
 * first candidate directory that exists. */
function listMigrationFiles(): { dir: string; files: string[] } {
  const tried: string[] = [];
  for (const dir of migrationsDirCandidates()) {
    tried.push(dir);
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      return { dir, files };
    } catch {
      // Not this one — try the next candidate.
    }
  }
  throw new Error(
    `Could not find the migrations directory. Tried: ${tried.join(', ')}. Set MIGRATIONS_DIR to override.`,
  );
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

    const { dir, files } = listMigrationFiles();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;

      const sql = readFileSync(join(dir, file), 'utf8');
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
