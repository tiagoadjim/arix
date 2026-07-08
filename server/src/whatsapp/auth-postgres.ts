import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from 'baileys';
import { many, one } from '../db/pool';

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

export interface PostgresAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}

export async function usePostgresAuthState(accountId: string): Promise<PostgresAuthState> {
  const cache = new Map<string, unknown>();

  const read = async (id: string): Promise<unknown> => {
    if (cache.has(id)) return cache.get(id);
    const row = await one<{ data: unknown }>(
      'select data from wa_auth_state where account_id = $1 and id = $2',
      [accountId, id],
    );
    const value = row ? decode(row.data) : null;
    cache.set(id, value);
    return value;
  };

  const write = async (id: string, category: string, value: unknown): Promise<void> => {
    cache.set(id, value);
    await one(
      `insert into wa_auth_state (account_id, id, category, data, updated_at)
       values ($1, $2, $3, $4::jsonb, now())
       on conflict (account_id, id) do update set category = excluded.category, data = excluded.data, updated_at = now()`,
      [accountId, id, category, serialize(value)],
    );
  };

  const remove = async (id: string): Promise<void> => {
    cache.delete(id);
    await many('delete from wa_auth_state where account_id = $1 and id = $2', [accountId, id]);
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
      set: async (data) => {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(data)) {
          const categoryData = (data as Record<string, Record<string, unknown>>)[category] ?? {};
          for (const id of Object.keys(categoryData)) {
            const value = categoryData[id];
            const key = `${category}-${id}`;
            tasks.push(value ? write(key, category, value) : remove(key));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: () => write('creds', 'creds', creds),
    clearState: async () => {
      cache.clear();
      await many('delete from wa_auth_state where account_id = $1', [accountId]);
    },
  };
}
