# Quickstart — Bot Baileys mínimo viable

> Código copy-paste que arranca un bot con QR, persiste credenciales en
> disco (solo dev/local), hace eco de mensajes y maneja reconexión.
> Para producción reemplazá `useMultiFileAuthState` por tu propio
> auth state (ver `auth-state.md`).

## `package.json`

```json
{
  "name": "mi-baileys-bot",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dev": "tsx watch src/index.ts"
  },
  "dependencies": {
    "baileys": "^7.0.0",
    "pino": "^9.0.0",
    "qrcode": "^1.5.0",
    "qrcode-terminal": "^0.12.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

## `src/index.ts`

```ts
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
} from 'baileys'
import P from 'pino'
import qrcodeTerminal from 'qrcode-terminal'

const log = P({ level: 'info' })

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')

  const sock = makeWASocket({
    auth: state,
    logger: log,
    markOnlineOnConnect: false,        // <- para que el celu reciba notifs
    browser: Browsers.macOS('Chrome'), // <- sacalo si vas a producción
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nEscaneá este QR con WhatsApp (Dispositivos vinculados):\n')
      qrcodeTerminal.generate(qr, { small: true })
    }
    if (connection === 'open') {
      console.log(`✓ Conectado como ${sock.user?.id}`)
    }
    if (connection === 'close') {
      const err = lastDisconnect?.error as any
      const code = err?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log(`Conexión cerrada (code=${code}). Reconectar: ${shouldReconnect}`)
      if (shouldReconnect) setTimeout(start, 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return
    for (const m of messages) {
      if (m.key.fromMe) continue
      const text =
        m.message?.conversation ??
        m.message?.extendedTextMessage?.text ??
        m.message?.imageMessage?.caption ??
        m.message?.videoMessage?.caption ??
        ''
      if (!text) continue
      console.log(`${m.pushName} (${m.key.remoteJid}): ${text}`)
      await sock.sendMessage(m.key.remoteJid!, { text: `eco: ${text}` })
    }
  })
}

start().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
```

## Cómo arrancar

```bash
npm install
npm run dev
```

La primera vez imprime un QR en la terminal. Escanealo desde
WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo.
Tras escanear, Baileys se va a desconectar a propósito y recrear
el socket — eso es normal, esperá 2-3 segundos.

## Qué tendrías que ver

```
Escaneá este QR con WhatsApp (Dispositivos vinculados):
[QR en ascii art]
✓ Conectado como 54911...:42@s.whatsapp.net
Juan (5491112345678@s.whatsapp.net): hola
eco: hola
```

## Próximos pasos

- Para mandar mensajes proactivos, guardá el `sock.user?.id` después de
  `connection === 'open'` y usá `sock.sendMessage(jid, { text: ... })`.
- Para producción: cambiar `useMultiFileAuthState` por Redis/DB
  (ver `auth-state.md`).
- Para grupos: cachear metadata con `node-cache` (ver SKILL.md §6).