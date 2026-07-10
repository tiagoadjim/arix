import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import { many, one, pool } from '../db/pool';
import { decryptSecret, encryptSecret, isEncrypted, needsReencryption } from '../config/secret';

/**
 * Production Baileys auth state backed by Postgres (table `wa_auth_state`).
 * Replaces `useMultiFileAuthState`, which the Baileys docs say is dev-only.
 *
 * Buffers are serialized with Baileys' BufferJSON helpers so they survive the
 * jsonb round-trip. A small in-memory cache fronts reads (keys.get is hot).
 */

// Serialize to a JSON STRING (with Baileys' Buffer encoding) and cast to jsonb in
// SQL. Passing a pre-parsed object/array to pg is unsafe: node-postgres encodes
// top-level arrays as Postgres array literals ("{...}"), which jsonb rejects (22P02).
const serialize = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const decode = (value: unknown): unknown => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

function decodeStored(value: unknown): unknown {
  // New rows store an encrypted envelope as a JSON string inside jsonb. Legacy
  // rows stored the actual object and remain readable for seamless upgrades.
  if (typeof value === 'string') {
    const serialized = isEncrypted(value) ? decryptSecret(value) : value;
    return JSON.parse(serialized, BufferJSON.reviver) as unknown;
  }
  return decode(value);
}

function serializedStoredValue(value: unknown): string {
  if (typeof value === 'string') return isEncrypted(value) ? decryptSecret(value) : value;
  return serialize(decode(value));
}

const rotatedAccounts = new Set<string>();

/** Re-encrypt every Signal/credential row before the previous key is removed.
 * This is deliberately transactional: a partial keyring migration could make
 * the next reconnect use a state that cannot survive restart. */
export async function rotateWhatsAppAuthState(accountId: string): Promise<number> {
  if (rotatedAccounts.has(accountId)) return 0;
  const client = await pool.connect();
  let rotated = 0;
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string; data: unknown }>(
      'select id, data from wa_auth_state where account_id = $1 for update',
      [accountId],
    );
    for (const row of rows) {
      if (typeof row.data === 'string' && isEncrypted(row.data) && !needsReencryption(row.data)) continue;
      const serialized = serializedStoredValue(row.data);
      // Validate the legacy payload before replacing it. A corrupt row should
      // abort the whole rotation, not be encrypted into a permanently corrupt
      // but apparently current envelope.
      JSON.parse(serialized, BufferJSON.reviver);
      await client.query(
        'update wa_auth_state set data = $3::jsonb, updated_at = now() where account_id = $1 and id = $2',
        [accountId, row.id, JSON.stringify(encryptSecret(serialized))],
      );
      rotated += 1;
    }
    await client.query('commit');
    rotatedAccounts.add(accountId);
    return rotated;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface PostgresAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}

export async function usePostgresAuthState(accountId: string): Promise<PostgresAuthState> {
  await rotateWhatsAppAuthState(accountId);
  const cache = new Map<string, unknown>();
  let mutationTail: Promise<void> = Promise.resolve();

  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const read = async (id: string): Promise<unknown> => {
    // Never observe/cache a DB value from the middle of a local mutation.
    await mutationTail;
    if (cache.has(id)) return cache.get(id);
    const row = await one<{ data: unknown }>(
      'select data from wa_auth_state where account_id = $1 and id = $2',
      [accountId, id],
    );
    const value = row ? decodeStored(row.data) : null;
    cache.set(id, value);
    return value;
  };

  const write = async (id: string, category: string, value: unknown): Promise<void> => {
    await mutate(async () => {
      await one(
        `insert into wa_auth_state (account_id, id, category, data, updated_at)
         values ($1, $2, $3, $4::jsonb, now())
         on conflict (account_id, id) do update set category = excluded.category, data = excluded.data, updated_at = now()`,
        [accountId, id, category, JSON.stringify(encryptSecret(serialize(value)))],
      );
      cache.set(id, value);
    });
  };

  const creds: AuthenticationCreds =
    ((await read('creds')) as AuthenticationCreds | null) ?? initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              const AppStateSyncKeyData = (proto.Message as unknown as {
                AppStateSyncKeyData?: { fromObject?: (v: unknown) => unknown; create?: (v: unknown) => unknown };
              }).AppStateSyncKeyData;
              value =
                AppStateSyncKeyData?.fromObject?.(value) ??
                AppStateSyncKeyData?.create?.(value) ??
                value;
            }
            if (value) out[id] = value as SignalDataTypeMap[typeof type];
          }),
        );
        return out;
      },
      set: async (data) => mutate(async () => {
        const changes: Array<{ id: string; category: string; value: unknown }> = [];
        for (const category of Object.keys(data)) {
          const categoryData = (data as Record<string, Record<string, unknown>>)[category] ?? {};
          for (const id of Object.keys(categoryData)) {
            const value = categoryData[id];
            const key = `${category}-${id}`;
            changes.push({ id: key, category, value });
          }
        }
        const client = await pool.connect();
        try {
          await client.query('begin');
          for (const change of changes) {
            if (change.value) {
              await client.query(
                `insert into wa_auth_state (account_id, id, category, data, updated_at)
                 values ($1, $2, $3, $4::jsonb, now())
                 on conflict (account_id, id) do update
                 set category = excluded.category, data = excluded.data, updated_at = now()`,
                [accountId, change.id, change.category, JSON.stringify(encryptSecret(serialize(change.value)))],
              );
            } else {
              await client.query('delete from wa_auth_state where account_id = $1 and id = $2', [accountId, change.id]);
            }
          }
          await client.query('commit');
          for (const change of changes) {
            if (change.value) cache.set(change.id, change.value);
            else cache.delete(change.id);
          }
        } catch (err) {
          await client.query('rollback').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }),
    },
  };

  return {
    state,
    saveCreds: () => write('creds', 'creds', creds),
    clearState: () => mutate(async () => {
      await many('delete from wa_auth_state where account_id = $1', [accountId]);
      cache.clear();
    }),
  };
}
