# Events — Catálogo completo de `sock.ev`

> `sock.ev` es un `EventEmitter`. Todos los eventos llegan con un
> payload que tenés que destructurar. **Siempre iterá los arrays**
> dentro del payload — Baileys agrupa mensajes.

## Connection lifecycle

### `connection.update`

```ts
sock.ev.on('connection.update', ({ connection, lastDisconnect, qr, isNewLogin }) => {
  // connection: 'connecting' | 'open' | 'close'
  // qr: string (presente solo cuando hay QR nuevo para escanear)
  // lastDisconnect.error: Boom, contiene .output.statusCode = DisconnectReason
  // isNewLogin: boolean (true la primera vez que entra a open)
})
```

### `creds.update`

```ts
sock.ev.on('creds.update', () => saveCreds())
// Disparado cada vez que Baileys actualiza credenciales (noiseKey, signedIdentityKey, etc.)
// Si no lo guardás, vas a tener que re-escanear QR cada vez.
```

## Mensajes

### `messages.upsert` — el más importante

```ts
sock.ev.on('messages.upsert', ({ type, messages, requestId }) => {
  // type: 'notify' (mensajes nuevos en tiempo real) | 'append' (mensajes viejos, history sync)
  // messages: proto.IWebMessageInfo[]
})
```

### `messages.update`

```ts
sock.ev.on('messages.update', (updates) => {
  // updates: WAMessageUpdate[]
  // cambios: edit, delete, receipt state changes (delivered, read, played)
  // Cada update tiene: { key, update: { status, message, pollUpdates? } }
})
```

### `messages.delete`

```ts
sock.ev.on('messages.delete', ({ keys }) => {
  // keys: WAMessageKey[] — los mensajes borrados
  // Solo dispara si vos BORRASTE para todos, o si el otro lo borró
})
```

### `messages.reaction`

```ts
sock.ev.on('messages.reaction', (reactions) => {
  // reactions: { key, reaction: { text: '❤️', groupTimestamp?: number } }[]
  // reaction.text === '' significa que quitaron la reacción
})
```

### `message-receipt.update`

```ts
sock.ev.on('message-receipt.update', (updates) => {
  // updates: MessageUserReceipt[] — quién leyó/vio/reprodujo
  // Más útil en grupos
})
```

## Chats (conversaciones)

### `chats.upsert`
Nuevo chat abierto con vos. `chats: Chat[]`.

### `chats.update`
Dispara en **cada mensaje** (para actualizar el contador de no leídos).
También cuando cambia el último mensaje del chat.

### `chats.delete`
Solo cuando un chat fue borrado.

### `chats.phoneNumberShare`
Cuando alguien comparte su número en un chat (PN ↔ LID mapping).

## Contactos

### `contacts.upsert`
Contacto nuevo agregado al address book del dispositivo principal.

### `contacts.update`
Datos de un contacto guardado cambiaron.

## Grupos

### `groups.upsert`
Te unieron a un grupo nuevo.

### `groups.update`
Metadata del grupo cambió (nombre, descripción, foto, settings).

### `group-participants.update`
Cambios en miembros: `{ groupJid, participants, action: 'add'|'remove'|'promote'|'demote' }`.

## Blocklist

### `blocklist.set`
Snapshot completo del blocklist.

### `blocklist.update`
Cambio incremental al blocklist.

## Llamadas

### `call`
Universal event para llamadas:
```ts
sock.ev.on('call', ([call]) => {
  // call.id, call.from, call.status: 'offer'|'timeout'|'accept'|'reject'|'terminate'
  // Para rechazar automáticamente: sock.rejectCall(call.id, call.from)
})
```

## LID mapping (v7+)

### `lid-mapping.update`
Nuevo mapping LID ↔ PN. **No siempre** se reporta (la docu dice WIP).
Para resolver LID → PN usá `sock.signalRepository.lidMapping.getPNForLID(lid)`.

## Presencia / otros

### `presence.update`
```ts
sock.ev.on('presence.update', ({ id, presences }) => {
  // id: jid del chat
  // presences: { participant: jid, lastKnownPresence: 'available'|'unavailable'|'composing'|'recording'|'paused' }[]
})
```

### `messaging-history.set`
Recién conectado, Baileys puede sincronizar historial completo (si
`syncFullHistory: true`). Payload: `{ chats, contacts, messages, isLatest }`.

## Cómo consumir eventos sin fugar memoria

Si re-asignás handlers en hot-reload, los handlers viejos se quedan
escuchando. Patrón seguro:

```ts
function registerHandlers(sock: WASocket) {
  const onUpsert = async ({ type, messages }: any) => { /* ... */ }
  sock.ev.on('messages.upsert', onUpsert)

  return () => {
    sock.ev.off('messages.upsert', onUpsert)   // cleanup para hot-reload / tests
  }
}
```

Llamá el cleanup antes de crear un socket nuevo (ej. cuando hacés
`restartRequired`).