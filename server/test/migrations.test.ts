import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock fs + pg so the runner can be exercised with no real Postgres: we
// inspect exactly which SQL statements it issues and in what order/wrapping.
const { readdirSync, readFileSync, connect, poolOn } = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  connect: vi.fn(),
  poolOn: vi.fn(),
}));

vi.mock('node:fs', () => ({ readdirSync, readFileSync }));
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn().mockImplementation(() => ({ connect, on: poolOn })),
    types: { setTypeParser: vi.fn() },
  },
}));

import { migrate } from '../src/db/pool';

const FILES: Record<string, string> = {
  '0001_init.sql': 'create table foo (id int);',
  '0002_sender_agent.sql': 'alter table foo add column bar text;',
};

interface Call {
  text: string;
  params?: unknown[];
}

/** A fake pg PoolClient whose `query` records every call and answers just
 * enough to drive the runner: SELECT returns `applied`, INSERT appends to it. */
function makeClient(applied: string[]) {
  const calls: Call[] = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const t = text.trim().toLowerCase();
    if (t.startsWith('select version from schema_migrations')) {
      return { rows: applied.map((version) => ({ version })) };
    }
    if (t.startsWith('insert into schema_migrations')) {
      applied.push(params?.[0] as string);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { query, release: vi.fn(), calls };
}

let applied: string[];
let client: ReturnType<typeof makeClient>;

beforeEach(() => {
  readdirSync.mockReset().mockReturnValue(Object.keys(FILES));
  readFileSync.mockReset().mockImplementation((path: string) => {
    const name = Object.keys(FILES).find((f) => String(path).endsWith(f));
    if (!name) throw new Error(`unexpected migration read: ${String(path)}`);
    return FILES[name]!;
  });
  applied = [];
  client = makeClient(applied);
  connect.mockReset().mockResolvedValue(client);
  poolOn.mockReset();
});

describe('migrate', () => {
  it('bootstraps schema_migrations, then applies every pending migration once, in order, each in its own transaction', async () => {
    await migrate();

    const texts = client.calls.map((c) => c.text.trim().toLowerCase());
    expect(texts[0]).toMatch(/^create table if not exists schema_migrations/);
    expect(texts[1]).toBe('select version from schema_migrations');

    const firstBegin = texts.indexOf('begin');
    expect(firstBegin).toBeGreaterThan(-1);
    expect(texts[firstBegin + 1]).toBe('create table foo (id int);');
    expect(texts[firstBegin + 2]).toMatch(/^insert into schema_migrations/);
    expect(texts[firstBegin + 3]).toBe('commit');

    const secondBegin = texts.indexOf('begin', firstBegin + 1);
    expect(secondBegin).toBeGreaterThan(firstBegin);
    expect(texts[secondBegin + 1]).toBe('alter table foo add column bar text;');
    expect(texts[secondBegin + 2]).toMatch(/^insert into schema_migrations/);
    expect(texts[secondBegin + 3]).toBe('commit');

    expect(applied).toEqual(['0001_init', '0002_sender_agent']);
    expect(client.release).toHaveBeenCalled();
  });

  it('is idempotent: re-running once everything is applied issues no migration SQL', async () => {
    await migrate();
    client.calls.length = 0;
    client.query.mockClear();

    await migrate();

    const texts = client.calls.map((c) => c.text.trim().toLowerCase());
    expect(texts).not.toContain('begin');
    expect(texts.some((t) => t.startsWith('insert into schema_migrations'))).toBe(false);
    expect(applied).toEqual(['0001_init', '0002_sender_agent']);
  });

  it('skips already-applied versions and only runs newly pending ones', async () => {
    applied.push('0001_init');

    await migrate();

    const texts = client.calls.map((c) => c.text.trim().toLowerCase());
    expect(texts).not.toContain('create table foo (id int);');
    expect(texts).toContain('alter table foo add column bar text;');
    expect(applied).toEqual(['0001_init', '0002_sender_agent']);
  });

  it('rolls back and rethrows when a migration fails, without recording it as applied', async () => {
    client.query.mockImplementation(async (text: string, params?: unknown[]) => {
      client.calls.push({ text, params });
      const t = text.trim().toLowerCase();
      if (t === 'create table foo (id int);') throw new Error('boom');
      if (t.startsWith('select version from schema_migrations')) return { rows: [] };
      return { rows: [] };
    });

    await expect(migrate()).rejects.toThrow('boom');

    const texts = client.calls.map((c) => c.text.trim().toLowerCase());
    expect(texts).toContain('rollback');
    expect(texts.some((t) => t.startsWith('insert into schema_migrations'))).toBe(false);
    expect(applied).toEqual([]);
    expect(client.release).toHaveBeenCalled();
  });
});
