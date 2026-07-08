# Sending Messages — todos los formatos

> Todos los ejemplos asumen `sock: WASocket` ya conectado. `jid` es
> `'PHONE@s.whatsapp.net'` para DMs y `'GROUPID@g.us'` para grupos.

## Texto

```ts
await sock.sendMessage(jid, { text: 'Hola' })
```

Con reply (cita):

```ts
await sock.sendMessage(jid, {
  text: 'Mirá esto',
  quoted: originalMessage,   // proto.IWebMessageInfo
})
```

Con link preview automático:

```ts
await sock.sendMessage(jid, {
  text: 'Entrá a https://ejemplo.com',
  linkPreview: { head: 'Título', body: 'desc', mediaType: 'image' },
})
```

## Media (imagen, video, audio, documento, sticker)

Acepta `Buffer`, `{ url }`, o `{ stream: Readable }`:

```ts
import { readFileSync } from 'node:fs'

await sock.sendMessage(jid, {
  image: readFileSync('./foto.png'),
  caption: 'mirá esto',
})

await sock.sendMessage(jid, {
  video: { url: 'https://example.com/clip.mp4' },
  caption: 'video',
  ptv: false,        // true = video "Nota de voz"-style (circular, ephemeral)
})

await sock.sendMessage(jid, {
  audio: { url: 'https://example.com/voice.ogg' },
  ptt: true,         // true = nota de voz (ola verde)
})

await sock.sendMessage(jid, {
  document: readFileSync('./factura.pdf'),
  fileName: 'factura-marzo.pdf',
  mimetype: 'application/pdf',
})

await sock.sendMessage(jid, {
  sticker: readFileSync('./sticker.webp'),
})
```

## Reacciones

```ts
await sock.sendMessage(jid, {
  react: { text: '🔥', key: originalMessage.key },
})

// Quitar reacción
await sock.sendMessage(jid, {
  react: { text: '', key: originalMessage.key },
})
```

## Edit (editar mensaje enviado)

Solo funciona si vos mandaste el mensaje y dentro de ~15 minutos:

```ts
await sock.sendMessage(jid, {
  text: 'versión corregida',
  edit: originalMessage.key,
})
```

## Delete (borrar mensaje)

```ts
await sock.sendMessage(jid, {
  delete: originalMessage.key,
})
// Para todos: incluir { remoteJid, fromMe: true, id }
```

## Forward (reenviar)

```ts
await sock.sendMessage(targetJid, { forward: originalMessage }, { quoted: originalMessage })
// quoted opcional — si lo ponés aparece "compartido desde..."
```

## Contact card (vCard)

```ts
await sock.sendMessage(jid, {
  contacts: {
    displayName: 'Juan Pérez',
    contacts: [{
      vcard:
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        'FN:Juan Pérez\n' +
        'TEL;type=CELL;type=VOICE;waid=5491112345678:+54 9 11 1234-5678\n' +
        'END:VCARD',
    }],
  },
})
```

## Location

```ts
await sock.sendMessage(jid, {
  location: { degreesLatitude: -34.6, degreesLongitude: -58.4, name: 'Buenos Aires' },
})
```

## Polls (encuestas)

```ts
await sock.sendMessage(jid, {
  poll: {
    name: '¿Cuál preferís?',
    values: ['Opción A', 'Opción B', 'Opción C'],
    selectableCount: 1,         // 1 = voto único, N = multiselect
    toAnnouncementGroup: false,
  },
})
```

## Events (eventos de calendario)

```ts
await sock.sendMessage(jid, {
  event: {
    name: 'Reunión',
    description: 'Reunión de equipo',
    startDate: new Date('2026-07-01T14:00:00Z'),
    endDate: new Date('2026-07-01T15:00:00Z'),
    location: { degreesLatitude: 0, degreesLongitude: 0, name: 'Online' },
  },
})
```

## Lista interactiva (botones en lista)

```ts
await sock.sendMessage(jid, {
  buttonText: { displayText: 'Ver opciones' },
  sections: [{
    title: 'Menú principal',
    rows: [
      { title: 'Opción 1', description: 'desc', rowId: 'opt1' },
      { title: 'Opción 2', rowId: 'opt2' },
    ],
  }],
})
```

El response llega por `messages.upsert` con
`message.buttonsResponseMessage` / `message.listResponseMessage` con
el `selectedButtonId` / `selectedRowId`.

## Botones simples (template)

```ts
await sock.sendMessage(jid, {
  text: '¿Confirmás el turno?',
  buttons: [
    { buttonId: 'yes', buttonText: { displayText: 'Sí' }, type: 1 },
    { buttonId: 'no', buttonText: { displayText: 'No' }, type: 1 },
  ],
})
```

## Disappearing messages (efímeros)

```ts
// 7 días
await sock.sendMessage(jid, {
  text: 'este mensaje se autodestruye',
  ephemeralExpiration: 7 * 24 * 60 * 60,
})
```

## Presencia mientras mandás

```ts
await sock.presenceSubscribe(jid)
await sock.sendPresenceUpdate('composing', jid)
await new Promise(r => setTimeout(r, 1500))
await sock.sendMessage(jid, { text: '...' })
await sock.sendPresenceUpdate('paused', jid)
```

## Grupos — mensajes especiales

```ts
// Mencionar a uno o varios
await sock.sendMessage(groupJid, {
  text: 'ey @juan',
  mentions: ['5491112345678@s.whatsapp.net'],
})

// Cambiar descripción del grupo (solo admins)
await sock.groupUpdateDescription(groupJid, 'nueva descripción')

// Cambiar nombre
await sock.groupUpdateSubject(groupJid, 'nombre nuevo')
```

## Errores comunes

- **`recipient not found`**: JID mal formado (chequear E.164 sin `+`).
- **`forbidden`**: la cuenta fue baneada o el contacto te bloqueó.
- **`rate-overlimit`**: estás mandando demasiado rápido — backoff.
- **Reenviar muchos mensajes en loop**: WhatsApp flagea como spam.

## Múltiples destinatarios (NO usar para spam)

```ts
// Bien: distintos mensajes a cada uno
for (const jid of recipients) {
  await sock.sendMessage(jid, { text: '...' })
  await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000))
}
```

```ts
// MAL: mandar el MISMO mensaje en bulk — baneable
```