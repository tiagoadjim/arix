---
name: baileys
description: |
  Build WhatsApp automation with Baileys (WhiskeySockets/Baileys) in Node.js or TypeScript.
  Use this skill when the user asks to connect to WhatsApp via QR or pairing code,
  send or receive WhatsApp messages, build a WhatsApp chatbot / "bot de WhatsApp" /
  "chatbot wsp", persist Baileys auth state, manage WhatsApp groups or contacts
  through the WhatsApp Web protocol, handle `messages.upsert` /
  `connection.update` / `creds.update` events, or migrate between Baileys versions.
  Triggers: "use Baileys", "makeWASocket", "WhatsApp Web API",
  "WhatsApp bot", "QR pairing", "pairing code", "chatbot wsp",
  "bot de WhatsApp", "messages.upsert", "useMultiFileAuthState".
  Do NOT use for the official WhatsApp Business API / Meta Cloud API / WABA
  (those are different products), for non-WhatsApp messaging platforms
  (Telegram, Signal, Discord, Slack), or for browser-automation of WhatsApp Web.
---

# Baileys (WhiskeySockets)

Baileys es una librería TypeScript/Node.js que habla el protocolo WebSocket de
WhatsApp Web directamente — sin navegador, sin la API oficial de Meta.
Permite construir bots, integraciones o herramientas que envían y reciben
mensajes de una cuenta personal o de WhatsApp Business (mobile app) usando
Linked Devices.

> **Disclaimer oficial del proyecto**: Baileys NO está afiliado ni
> respaldado por WhatsApp. Úsalo bajo tu responsabilidad. No spam,
> no stalkerware, no mensajería masiva. El protocolo puede cambiar y
> romper la librería sin aviso.

## Cuándo usar Baileys vs alternativas

| Caso                                                      | Solución                                    |
| --------------------------------------------------------- | ------------------------------------------- |
| Bot personal o de negocio que manda/recibe mensajes        | **Baileys** ✓                               |
| Necesito la API oficial de Meta (plantillas, facturación) | WhatsApp Business API / Cloud API           |
| Quiero mandar mensajes masivos sin pagar                  | Baileys puede, pero NO deberías             |
| Quiero correr WhatsApp Web en un browser headless         | Playwright/Puppeteer (distinto, más pesado) |

## Inputs a recolectar

Antes de escribir código, confirmar con el usuario:

- **Versión de Node**: Baileys requiere Node 17+.
- **Versión de Baileys**: la actual estable es la línea 7.x (ESM-only,
  con cambios breaking — ver `references/v7-migration.md`).
- **Tipo de cuenta**: personal o business. Ambas funcionan por Linked
  Devices; business tiene features extra (`business-features`).
- **Persistencia de credenciales**: filesystem (solo demo), Redis,
  Postgres, MongoDB, etc. **Nunca** dejar `useMultiFileAuthState` en
  producción — Baileys lo dice textual y consume mucha I/O.
- **Hosting / entorno**: local, VPS, Docker. Baileys guarda estado
  cifrado en disco, así que volúmenes persistentes si va containerizado.
- **¿Bot simple echo/forward, o lógica compleja con FSM / DB / LLMs?**
  Esto cambia la arquitectura (event handlers vs state machine).

## Procedure

### 1. Instalar y arrancar el proyecto

```bash
npm init -y
npm pkg set type="module"            # Baileys 7.x es ESM puro
npm install baileys pino qrcode
```

Razón del `type: module`: Baileys 7+ es ESM-only. Si el proyecto es CJS
hay que usar `await import('baileys')` o migrar a ESM.

### 2. Crear el auth state (NUNCA uses useMultiFileAuthState en prod)

```ts
import { useMultiFileAuthState } from 'baileys'   // SOLO para dev/local
const { state, saveCreds } = await useMultiFileAuthState('./auth')
```

En prod: implementar uno propio. Estructura que Baileys espera:

```ts
type AuthenticationState = {
  creds: AuthenticationCreds          // noiseKey, signedIdentityKey, etc.
  keys: {
    noiseKey?:         KeyPair
    signedIdentityKey: KeyPair
    signedPreKey:      KeyPair
    registrationId:    number
    advSecretKey:      string
    processedHistoryMessages: WAMessageKey[]
    nextPreKeyId:      number
    firstUnuploadedPreKeyId: number
    accountSettings:   AccountSettings
    // ... y muchos más (Signal protocol keys)
  }
}
```

Ver `references/auth-state.md` para implementaciones de referencia
(Redis, Postgres, Mongo).

### 3. Crear el socket y conectar

```ts
import makeWASocket, { DisconnectReason } from 'baileys'
import P from 'pino'

const sock = makeWASocket({
  auth: state,
  logger: P({ level: 'info' }),
  // markOnlineOnConnect: false,  // <- desactiva online (recibe notifs al celu)
  // browser: Browsers.macOS('Google Chrome'),  // <- solo si usás pairing code
})

sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
  if (qr) {
    // Mostrar QR al usuario (terminal, frontend, lo que sea)
    console.log(await QRCode.toString(qr, { type: 'terminal' }))
  }
  if (connection === 'close') {
    const reason = (lastDisconnect?.error as Boom)?.output?.statusCode
    if (reason === DisconnectReason.restartRequired) {
      // crear socket nuevo — el viejo ya no sirve
    } else if (reason !== DisconnectReason.loggedOut) {
      // reconectar (con backoff)
      setTimeout(start, 3000)
    } else {
      // loggedOut -> usuario sacó el device desde el celu -> borrar auth
    }
  }
  if (connection === 'open') console.log('conectado ✓')
})
```

Punto crítico: tras escanear el QR, WhatsApp **te va a desconectar a
propósito** (`restartRequired`) para forzar el handshake de credenciales
nuevas. Eso NO es un error — recreá el socket.

### 4. Recibir mensajes

```ts
sock.ev.on('messages.upsert', ({ type, messages }) => {
  if (type !== 'notify') return   // 'append' son mensajes viejos
  for (const msg of messages) {
    const text = msg.message?.conversation
      ?? msg.message?.extendedTextMessage?.text
      ?? ''
    if (!msg.key.fromMe && text) {
      console.log(`${msg.pushName}: ${text}`)
    }
  }
})
```

`messages.upsert` entrega mensajes nuevos (tipo `notify`) y resync
(`append`). Siempre iterar el array — vienen varios juntos.
Ver `references/events.md` para el catálogo completo.

### 5. Responder / enviar mensajes

Texto:

```ts
await sock.sendMessage(jid, { text: 'Hola' })
```

Imagen / video / audio / documento:

```ts
import { readFileSync } from 'node:fs'
await sock.sendMessage(jid, {
  image: readFileSync('./foto.png'),
  caption: 'mirá esto',
})
```

Reaccionar, editar, borrar, forward, polls, contacts, location — ver
`references/messages.md` para la tabla completa con payloads exactos.

### 6. Grupos, contactos, presencia

- Grupos: `sock.groupMetadata(jid)`, `sock.groupCreate(name, participants)`,
  `sock.groupParticipantsUpdate(jid, participants, 'add' | 'remove' | 'promote' | 'demote')`.
- Contactos: eventos `contacts.upsert` / `contacts.update`.
- Presencia: `sock.sendPresenceUpdate('available' | 'unavailable' | 'composing' | 'recording', jid)`.

⚠️ `cachedGroupMetadata`: cuando mandás a un grupo, Baileys pide la lista
de participantes para cifrar el mensaje. Eso **rate-limita y puede
banear**. Cacheá los metadata con `node-cache` (TTL ~5 min) o similar.

### 7. Lifecycle — qué hacer ante cada DisconnectReason

| Razón                         | Acción                                            |
| ----------------------------- | ------------------------------------------------- |
| `restartRequired`             | Recrear socket (es el caso normal tras QR)        |
| `loggedOut`                   | Borrar creds, mostrar QR de nuevo                 |
| `timedOut`                    | Reconectar con backoff exponencial                |
| `connectionClosed` / `lost`   | Reconectar con backoff                            |
| `multideviceMismatch`         | Borrar auth state, empezar de cero                |
| `forbidden` / `banned`        | **STOP**. La cuenta fue baneada. Pausar todo.     |

## Output contract

Cuando uses esta skill, entregás código TypeScript ejecutable que:

1. Define un entrypoint (ej. `src/index.ts`) que arranca el socket
2. Maneja los 3 eventos críticos: `connection.update`, `creds.update`,
   `messages.upsert`
3. Persiste credenciales en algo que sobrevive reinicios (Redis/DB;
   nunca `useMultiFileAuthState` en prod)
4. Maneja reconexión con backoff y el caso `restartRequired`
5. Loggea con pino (nunca `console.log` suelto)

Estructura sugerida para proyectos medianos:

```
src/
├── index.ts              # entrypoint, crea socket y arranca handlers
├── socket.ts             # makeWASocket + config
├── auth.ts               # custom auth state (Redis/DB)
├── handlers/
│   ├── messages.ts       # messages.upsert
│   ├── groups.ts         # group* events
│   └── presence.ts       # presence updates
└── utils/
    ├── jid.ts            # isPnUser, isLidUser, etc.
    └── reconnect.ts      # backoff exponencial
```

## Failure handling

**Rate limit / bans potenciales**
- Mandar a muchos grupos sin `cachedGroupMetadata` → baneable.
- Reenviar el mismo mensaje a muchos contactos → flag de spam.
- ACK automático de mensajes en v6 → WhatsApp banea por esto.
  v7+ ya no manda ACKs automáticamente.

**QR loop infinito**
- El usuario no escaneó, o el auth state está corrupto.
- Borrar la carpeta de auth y empezar de cero.

**Auth state corrupto tras deploy**
- Generalmente: volumes mal montados, o el `saveCreds` no se llamó en
  `creds.update`. Confirmá que `sock.ev.on('creds.update', saveCreds)`
  está conectado ANTES de `connection.update`.

**"Baileys no me manda mensajes que yo mando"**
- `markOnlineOnConnect` está en `true` por defecto, eso apaga las
  notifs del celu. Cambialo a `false` si querés notifs.

**ESM vs CJS**
- v7+ es ESM puro. `require('baileys')` no funciona. O migrás el
  proyecto a ESM, o `await import('baileys')` dentro de un wrapper CJS.

**LIDs en v7**
- WhatsApp reemplazó JIDs-PN por LIDs para privacidad. Los participantes
  de grupo vienen con `id` (LID) y `phoneNumber` (PN). NO intentes
  restaurar el PN — migrá la lógica a LID. Ver `references/v7-migration.md`.

**Pairing code falla**
- `browser` tiene que estar seteado a algo lógico (`Browsers.macOS('Google Chrome')`)
  antes del pair. Después podés volver a algo normal.

## Examples

**Ejemplo 1 — Echo bot mínimo (todo-en-uno)**

```ts
// src/index.ts
import makeWASocket, { DisconnectReason } from 'baileys'
import { useMultiFileAuthState } from 'baileys'
import P from 'pino'
import QRCode from 'qrcode'

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const sock = makeWASocket({ auth: state, logger: P({ level: 'warn' }) })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log(await QRCode.toString(qr, { type: 'terminal' }))
    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode
      if (reason !== DisconnectReason.loggedOut) setTimeout(start, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      const text = m.message?.conversation
        ?? m.message?.extendedTextMessage?.text
      if (!text || m.key.fromMe) continue
      await sock.sendMessage(m.key.remoteJid!, { text: `eco: ${text}` })
    }
  })
}
start()
```

**Ejemplo 2 — Bot que manda un mensaje proactivo a un contacto**

```ts
// Requiere auth ya poblada (escaneaste QR antes)
const jid = '5491112345678@s.whatsapp.net'   // E.164 sin +, @s.whatsapp.net
await sock.sendMessage(jid, {
  text: '¡Hola! Tu turno está confirmado para mañana 10am.',
})
```

Para más patrones (media, grupos, polls, custom auth state, v7 LID
migration): ver la carpeta `references/`.

## Windows (win32) platform notes

Los comandos npm (`npm install`, `npm run dev`) funcionan idéntico en
PowerShell. Lo único distinto:

- **`qrcode-terminal`**: puede tener problemas de encoding en
  PowerShell 5.1. Workaround: agregá
  `$OutputEncoding = [System.Text.Encoding]::UTF8` al inicio del script,
  o usá `qrcode` (devuelve Buffer, lo renderizás como quieras).
- **`pino`**: puede emitir caracteres raros en consolas Windows viejas.
  Solución: usar Windows Terminal o instalar `pino-pretty`.
- **Paths**: `readFileSync('./foto.png')` funciona igual. Si servís
  archivos vía HTTP, ojo con backslashes en URLs.

El código TypeScript no requiere cambios entre macOS/Linux/Windows.