import { BufferJSON } from 'baileys';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  connect: vi.fn(),
  one: vi.fn(),
  many: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({
  pool: { connect: db.connect },
  one: db.one,
  many: db.many,
}));

import { decryptSecret, isEncrypted } from '../src/config/secret';
import {
  rotateWhatsAppAuthState,
  usePostgresAuthState,
} from '../src/whatsapp/auth-postgres';

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function normalizedSql(value: unknown): string {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function rotationClient(rows: Array<{ id: string; data: unknown }> = []): FakeClient {
  return {
    query: vi.fn(async (text: unknown) => {
      if (normalizedSql(text).startsWith('select id, data from wa_auth_state')) {
        return { rows };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

let accountSequence = 0;
function accountId(label: string): string {
  accountSequence += 1;
  return `auth-test-${label}-${accountSequence}`;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  db.connect.mockReset();
  db.one.mockReset().mockResolvedValue(null);
  db.many.mockReset().mockResolvedValue([]);
});

describe('rotateWhatsAppAuthState()', () => {
  it('rotates every legacy row to the current encrypted envelope in one transaction', async () => {
    const account = accountId('legacy-rotation');
    const legacyRows = [
      { id: 'creds', data: { registrationId: 7, signedIdentityKey: { public: 'legacy' } } },
      { id: 'session-peer', data: { chainKey: 'old-key', counter: 3 } },
    ];
    const client = rotationClient(legacyRows);
    db.connect.mockResolvedValueOnce(client);

    await expect(rotateWhatsAppAuthState(account)).resolves.toBe(2);

    const calls = client.query.mock.calls as Array<[string, unknown[]?]>;
    expect(normalizedSql(calls[0]?.[0])).toBe('begin');
    expect(normalizedSql(calls[1]?.[0])).toContain('for update');
    expect(normalizedSql(calls.at(-1)?.[0])).toBe('commit');

    const updates = calls.filter(([sql]) => normalizedSql(sql).startsWith('update wa_auth_state'));
    expect(updates).toHaveLength(2);
    for (const [index, [, params]] of updates.entries()) {
      expect(params?.slice(0, 2)).toEqual([account, legacyRows[index]!.id]);
      const envelope = JSON.parse(params?.[2] as string) as string;
      expect(isEncrypted(envelope)).toBe(true);
      const decoded = JSON.parse(decryptSecret(envelope), BufferJSON.reviver) as unknown;
      expect(decoded).toEqual(legacyRows[index]!.data);
    }
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back a partial rotation and does not memoize the account as rotated', async () => {
    const account = accountId('rollback');
    const first = rotationClient([
      { id: 'creds', data: { version: 1 } },
      { id: 'session-peer', data: { version: 1 } },
    ]);
    let updateCount = 0;
    first.query.mockImplementation(async (text: unknown) => {
      const sql = normalizedSql(text);
      if (sql.startsWith('select id, data from wa_auth_state')) {
        return {
          rows: [
            { id: 'creds', data: { version: 1 } },
            { id: 'session-peer', data: { version: 1 } },
          ],
        };
      }
      if (sql.startsWith('update wa_auth_state') && ++updateCount === 2) {
        throw new Error('write failed');
      }
      return { rows: [] };
    });
    const retry = rotationClient();
    db.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(retry);

    await expect(rotateWhatsAppAuthState(account)).rejects.toThrow('write failed');
    expect(first.query).toHaveBeenCalledWith('rollback');
    expect(first.query.mock.calls.some(([sql]) => normalizedSql(sql) === 'commit')).toBe(false);
    expect(first.release).toHaveBeenCalledTimes(1);

    // The failed transaction must not poison the process-local fast path.
    await expect(rotateWhatsAppAuthState(account)).resolves.toBe(0);
    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(retry.query).toHaveBeenCalledWith('commit');
  });
});

describe('usePostgresAuthState() mutation ordering', () => {
  it('does not expose a keys.set cache change before a successful commit', async () => {
    const account = accountId('cache-after-commit');
    const rotation = rotationClient();
    const commit = deferred<{ rows: never[] }>();
    const transaction: FakeClient = {
      query: vi.fn(async (text: unknown) => {
        if (normalizedSql(text) === 'commit') return commit.promise;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    db.connect.mockResolvedValueOnce(rotation).mockResolvedValueOnce(transaction);

    const oldValue = { chainKey: 'old' };
    db.one.mockImplementation(async (_text: unknown, params?: unknown[]) =>
      params?.[1] === 'session-peer' ? { data: oldValue } : null,
    );
    const auth = await usePostgresAuthState(account);
    await expect(auth.state.keys.get('session', ['peer'])).resolves.toEqual({ peer: oldValue });

    const set = auth.state.keys.set({ session: { peer: { chainKey: 'new' } } } as never);
    const setRejection = expect(set).rejects.toThrow('commit failed');
    await vi.waitFor(() => {
      expect(transaction.query.mock.calls.some(([sql]) => normalizedSql(sql) === 'commit')).toBe(true);
    });

    let readSettled = false;
    const readDuringCommit = auth.state.keys.get('session', ['peer']).then((value) => {
      readSettled = true;
      return value;
    });
    await flushPromises();
    expect(readSettled).toBe(false);

    commit.reject(new Error('commit failed'));
    await setRejection;
    await expect(readDuringCommit).resolves.toEqual({ peer: oldValue });
    expect(transaction.query).toHaveBeenCalledWith('rollback');
    // creds + the initial key read; the second key read came from the unchanged cache.
    expect(db.one).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent keys.set transactions and publishes them in call order', async () => {
    const account = accountId('serialized-sets');
    const events: string[] = [];
    const rotation = rotationClient();
    const firstCommit = deferred<{ rows: never[] }>();
    const first: FakeClient = {
      query: vi.fn(async (text: unknown) => {
        const sql = normalizedSql(text);
        events.push(`first:${sql.split(' ')[0]}`);
        if (sql === 'commit') return firstCommit.promise;
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const second: FakeClient = {
      query: vi.fn(async (text: unknown) => {
        const sql = normalizedSql(text);
        events.push(`second:${sql.split(' ')[0]}`);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    db.connect
      .mockResolvedValueOnce(rotation)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const auth = await usePostgresAuthState(account);
    const firstSet = auth.state.keys.set({ session: { peer: { revision: 1 } } } as never);
    const secondSet = auth.state.keys.set({ session: { peer: { revision: 2 } } } as never);

    await vi.waitFor(() => {
      expect(first.query.mock.calls.some(([sql]) => normalizedSql(sql) === 'commit')).toBe(true);
    });
    // Rotation + first transaction only: the second mutation is still queued.
    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(second.query).not.toHaveBeenCalled();

    firstCommit.resolve({ rows: [] });
    await Promise.all([firstSet, secondSet]);

    expect(db.connect).toHaveBeenCalledTimes(3);
    expect(events.indexOf('first:commit')).toBeLessThan(events.indexOf('second:begin'));
    await expect(auth.state.keys.get('session', ['peer'])).resolves.toEqual({
      peer: { revision: 2 },
    });
    // The final read is served by the cache committed by the second transaction.
    expect(db.one).toHaveBeenCalledTimes(1);
  });

  it('orders clearState after an already-admitted delayed write so credentials cannot resurrect', async () => {
    const account = accountId('clear-after-write');
    const rotation = rotationClient();
    db.connect.mockResolvedValueOnce(rotation);

    const writeGate = deferred<void>();
    const events: string[] = [];
    let persistedCredentials = false;
    db.one.mockImplementation(async (text: unknown) => {
      if (normalizedSql(text).startsWith('select data from wa_auth_state')) return null;
      events.push('write-started');
      await writeGate.promise;
      persistedCredentials = true;
      events.push('write-committed');
      return null;
    });
    db.many.mockImplementation(async () => {
      persistedCredentials = false;
      events.push('clear-deleted');
      return [];
    });

    const auth = await usePostgresAuthState(account);
    const delayedWrite = auth.saveCreds();
    await vi.waitFor(() => expect(events).toContain('write-started'));
    const clear = auth.clearState();
    await flushPromises();
    expect(db.many).not.toHaveBeenCalled();

    writeGate.resolve();
    await Promise.all([delayedWrite, clear]);

    expect(events).toEqual(['write-started', 'write-committed', 'clear-deleted']);
    expect(persistedCredentials).toBe(false);
    expect(db.many).toHaveBeenCalledWith(
      'delete from wa_auth_state where account_id = $1',
      [account],
    );
  });
});
