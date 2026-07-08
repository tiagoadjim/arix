# Migración a Baileys v7.x.x — breaking changes

> Si el código base está en v6, hay cosas que se rompen. Acá están las
> más importantes. Para el changelog completo:
> https://github.com/WhiskeySockets/Baileys/releases/

## 1. ESM only

Baileys v7+ es ESM puro. No funciona con `require()`.

**Opciones:**

a) **Migrar tu proyecto a ESM** (recomendado):
```json
// package.json
{ "type": "module" }
```
Y reemplazar `require()` por `import`. Si tenés deps CJS, usá
`createRequire` para cargarlas puntualmente.

b) **Wrapper CJS con dynamic import** (no recomendado, pero funciona):
```ts
async function loadBaileys() {
  const mod = await import('baileys')
  return mod.default
}
```

Implicancia extra: Baileys ahora usa Yarn v4 (corepack), no Yarn Classic.

## 2. LIDs reemplazan PNs para identificar usuarios

WhatsApp introdujo LID (Local Identifier) para anonimato. Los JIDs ahora
vienen en dos formatos:

- **PN** (phone number): `'5491112345678@s.whatsapp.net'` — el viejo
- **LID**: `'1234567890@lid'` — el nuevo

Reglas:

- Por defecto, **todas las nuevas sesiones Signal son en formato LID**.
- Las sesiones viejas se migran automáticamente.
- El dispositivo principal (mobile) manda un mapping `PN ↔ LID`.
- WhatsApp te permite obtener LID desde PN (`onWhatsApp()` /
  `USyncProtocol`), pero **NO al revés** (a menos que el user comparta
  el número explícitamente).

**Cómo migrar tu código:**

```ts
// v6: solo había JIDs-PN
// v7: hay LID y PN

import { isPnUser, isLidUser, isJidGroup } from 'baileys'

if (isPnUser(jid)) { /* es un PN */ }
if (isLidUser(jid)) { /* es un LID */ }
if (isJidGroup(jid)) { /* es un grupo */ }
```

**Resolución LID → PN:**
```ts
const store = sock.signalRepository.lidMapping
const pn = store.getPNForLID(lid)   // string | undefined
```

**No intentes restaurar PN en todos lados.** Mover a LID — es más
estable y es el formato que WhatsApp va a seguir usando.

## 3. Nuevos campos en `MessageKey`

```ts
interface MessageKey {
  remoteJid: string         // el principal
  remoteJidAlt?: string      // <- NUEVO en v6.8+: alternate JID (LID ↔ PN)
  fromMe: boolean
  id: string
  participant?: string       // en grupos
  participantAlt?: string    // <- NUEVO en v6.8+: alternate participant
}
```

`remoteJidAlt` es para DMs, `participantAlt` para grupos. Si
`participant` es un LID, `participantAlt` es el PN equivalente (y
viceversa).

## 4. Contact type — campos cambian

v6 tenía `jid` y `lid`. v7 los unifica:

```ts
interface Contact {
  id: string                 // <- NUEVO: el JID preferido por WhatsApp
  phoneNumber?: string       // presente si id es LID
  lid?: string               // presente si id es PN
  name?: string
  notify?: string
  // ...
}
```

Si tu código hacía `contact.jid`, ahora es `contact.id` (o
`contact.phoneNumber` / `contact.lid` según el caso).

`GroupMetadata.participants` también cambió: cada participante ahora
tiene `id` (LID) + `phoneNumber` (PN), en vez de `jid` solo. También
aparecen `ownerPn`, `descOwnerPn`, etc.

## 5. Acks automáticos removidos

v6 mandaba ACKs (`read`, `received`) a todos los mensajes
automáticamente. WhatsApp empezó a banear por esto.

v7+ **NO manda ACKs**. Si los necesitás, tenés que llamar manualmente:

```ts
// Leer mensajes (mandar el "doble check azul")
const keys = messages.map(m => m.key)
await sock.readMessages(keys)
```

## 6. Protobufs reducidos

Para bajar bundle size, el namespace `proto` perdió métodos:

- `proto.Message.fromObject()` → `proto.Message.create()`
- `proto.Message.encode()` / `.decode()` siguen

Cuando encodes/decodees tipos protobuf, usá las utilidades de
`BufferJSON`. Para hidratar tipos decoded, usá
`sock.decodeAndHydrate(...)` — sino Baileys puede romperse.

## 7. `isJidUser` → `isPnUser`

```ts
// v6
import { isJidUser } from 'baileys'
isJidUser(jid)   // true si es un user JID

// v7
import { isPnUser } from 'baileys'
isPnUser(jid)    // true si es PN user JID
```

Razón: como ahora hay dos tipos de user JID (PN y LID), `isJidUser`
era ambiguo. Si querés "es cualquier user (PN o LID)", usá
`isJidUser` (sigue existiendo) o `isPnUser(jid) || isLidUser(jid)`.

## 8. Coexistence con Meta Cloud API

WhatsApp permite tener la WA Business App + dispositivos vinculados +
Meta API al mismo tiempo. El soporte en Baileys es experimental pero
existe — reportá bugs en GitHub si encontrás algo.

## 9. Nuevo evento `lid-mapping.update`

Llega cuando WhatsApp te avisa de un nuevo mapping LID ↔ PN. **No
siempre** se reporta (WIP según la docu oficial).

## 10. `onWhatsApp` ya no devuelve LIDs

```ts
// v6: a veces devolvía LID
// v7: solo PN
const results = await sock.onWhatsApp(['5491112345678'])
// results: [{ jid, exists, ... }]
```

Para obtener el LID del PN: `store.getLIDForPN(results[0].jid)`.

## Checklist de migración

- [ ] Cambiar `package.json` a `"type": "module"`
- [ ] Reemplazar `require('baileys')` por `import`
- [ ] Reemplazar `isJidUser` → `isPnUser` cuando solo importan PNs
- [ ] Adaptar todos los usos de `Contact.jid` → `Contact.id`
- [ ] Adaptar `GroupMetadata.participants[].jid` → `.id` / `.phoneNumber`
- [ ] Confirmar que el auth state incluye `lid-mapping`,
      `device-list`, `tctoken` (ver `SignalDataTypeMap`)
- [ ] Migrar handlers que asumían todos los JIDs eran PN
- [ ] Quitar cualquier ACK automático (ya no están)
- [ ] Decidir si los handlers van a trabajar con LID o con PN
      (recomendado: LID)
- [ ] Testear con un usuario real — los LIDs no aparecen hasta que
      alguien te manda un mensaje después del upgrade