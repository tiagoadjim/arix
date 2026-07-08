# Custom Auth State — implementación para producción

> **Regla de oro**: `useMultiFileAuthState` es solo para dev y demo.
> En producción consume mucha I/O, no escala, y Baileys lo dice textual
> en la docu oficial.

## Estructura que Baileys espera

```ts
type AuthenticationState = {
  creds: AuthenticationCreds
  keys: {
    // Signal protocol keys (muchos; ver SignalDataTypeMap)
    noiseKey?: KeyPair
    signedIdentityKey: KeyPair
    signedPreKey: KeyPair
    registrationId: number
    advSecretKey: string
    processedHistoryMessages: WAMessageKey[]
    nextPreKeyId: number
    firstUnuploadedPreKeyId: number
    accountSettings: AccountSettings
    // ... y muchos más, todos bajo la misma interface SignalDataTypeMap
  }
}
```

La función que le pasás a `makeWASocket({ auth })` tiene la forma:

```ts
type AuthenticationStateProvider = {
  state: Promise<AuthenticationState>
  saveCreds: () => Promise<void>   // se llama en cada creds.update
  // opcional pero común:
  keys: {
    get: (type, ids) => Promise<{ [id: string]: SignalDataTypeMap[type] }>
    set: (data: SignalDataTypeMap) => Promise<void>
  }
}
```

## Implementación Redis (recomendada para producción)

```ts
// auth-redis.ts
import { Redis } from 'ioredis'
import {
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalDataSet,
} from 'baileys'

const KEY = (id: string) => `baileys:auth:${id}`

export async function useRedisAuthState(redis: Redis) {
  // Helper para re-hidratar Buffers desde JSON plano
  const readData = <T>(key: string): Promise<T | null> =>
    redis.get(key).then((v) => (v ? JSON.parse(v, BufferJSON.reviver) : null))

  const writeData = (key: string, value: unknown) =>
    redis.set(key, JSON.stringify(value, BufferJSON.replacer))

  const clearState = async () => {
    const keys = await redis.keys('baileys:auth:*')
    if (keys.length) await redis.del(...keys)
  }

  const creds: AuthenticationCreds =
    (await readData<AuthenticationCreds>(KEY('creds'))) ?? initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [k: string]: any } = {}
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData<any>(KEY(`${type}-${id}`))
              if (value) data[id] = value
            }),
          )
          return data
        },
        set: async (data: SignalDataSet) => {
          const tasks: Promise<unknown>[] = []
          for (const category in data) {
            const categoryData = data[category as keyof SignalDataTypeMap]
            for (const id in categoryData) {
              const value = categoryData[id as keyof typeof categoryData]
              const key = KEY(`${category}-${id}`)
              if (value) {
                tasks.push(writeData(key, value))
              } else {
                tasks.push(redis.del(key))
              }
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => writeData(KEY('creds'), creds),
    clearState,
  }
}
```

Uso:

```ts
import { Redis } from 'ioredis'
const redis = new Redis(process.env.REDIS_URL!)
const { state, saveCreds, clearState } = await useRedisAuthState(redis)

const sock = makeWASocket({ auth: state, logger: P() })
sock.ev.on('creds.update', saveCreds)
```

## Implementación Postgres (multi-device, auditoría)

```sql
CREATE TABLE baileys_auth (
  id           TEXT PRIMARY KEY,    -- e.g. "creds", "app-state-sync-key-id_abc123"
  category     TEXT NOT NULL,       -- "creds", "noise-key", etc.
  data         JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON baileys_auth (category);
```

```ts
// auth-postgres.ts
import { Pool } from 'pg'
import {
  initAuthCreds,
  BufferJSON,
  type AuthenticationCreds,
  type SignalDataSet,
} from 'baileys'

export async function usePostgresAuthState(pool: Pool) {
  const read = async (category: string, id: string) => {
    const { rows } = await pool.query(
      'SELECT data FROM baileys_auth WHERE id = $1',
      [`${category}-${id}`],
    )
    return rows[0]?.data ?? null
  }

  const write = async (category: string, id: string, value: unknown) => {
    await pool.query(
      `INSERT INTO baileys_auth (id, category, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET data = $3, updated_at = NOW()`,
      [`${category}-${id}`, category, value],
    )
  }

  const credsRow = await pool.query(
    'SELECT data FROM baileys_auth WHERE id = $1',
    ['creds'],
  )
  const creds: AuthenticationCreds = credsRow.rows[0]?.data ?? initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out: any = {}
          await Promise.all(
            ids.map(async (id) => {
              const data = await read(type, id)
              if (data) out[id] = data
            }),
          )
          return out
        },
        set: async (data: SignalDataSet) => {
          for (const category in data) {
            const catData = data[category as keyof SignalDataSet] as any
            for (const id in catData) {
              await write(category, id, catData[id])
            }
          }
        },
      },
    },
    saveCreds: () =>
      pool.query(
        `INSERT INTO baileys_auth (id, category, data)
         VALUES ('creds', 'creds', $1)
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [creds],
      ),
  }
}
```

## Notas importantes

1. **`BufferJSON.reviver` / `BufferJSON.replacer`**: NO guardar con
   `JSON.stringify` plano. Los Buffers se rompen. Usá siempre el replacer
   que viene en Baileys.

2. **Categorías de keys**: son ~30 tipos (noise-key, signed-identity-key,
   pre-key, app-state-sync-key, lid-mapping, device-list, tctoken, ...).
   Tu `set()` tiene que manejar TODOS. Lo más fácil es guardar el
   payload entero por `category-id`.

3. **Performance**: `keys.get()` se llama **mucho** (cada mensaje que
   entra puede requerir keys). En Redis el `MGET` es tu amigo.
   En Postgres considerá un cache en memoria con TTL para keys
   que no cambian.

4. **Multi-account**: si un bot maneja varias cuentas de WhatsApp,
   prefix las keys con `account_id`:
   ```ts
   const KEY = (id: string) => `baileys:${accountId}:auth:${id}`
   ```

5. **Backups**: las Signal keys son irrecuperables si se pierden —
   el usuario tiene que re-escanear el QR. Hacé backup regular
   de Redis/DB.

6. **Tests**: para tests, podés usar `initAuthCreds()` directo sin
   persistir nada. Cada test corre contra un socket fresco.

## Señales de auth state roto

- QR loop infinito → auth state corrupto, borrar y empezar de cero.
- Mensajes salen pero no entran → probablemente `keys.get()` falló para
  algún pre-key. Limpiá esa key específica.
- `Bad MAC` errors al recibir → encryption keys desincronizadas.
  Esto suele pasar tras un crash a mitad de `creds.update`. Restaurá
  el último backup.