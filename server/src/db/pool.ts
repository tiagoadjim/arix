import { readFileSync } from 'node:fs';
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

/** Apply the idempotent schema (CREATE TABLE IF NOT EXISTS …). */
export async function migrate(): Promise<void> {
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
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
