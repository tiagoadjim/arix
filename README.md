# Nico — agente de IA de WhatsApp para Vapenic

Nico atiende a los clientes de **Vapenic** por WhatsApp: asesora y vende
(catálogo, sabores, stock en vivo desde WooCommerce), **ve** los comprobantes de
transferencia y valida que el monto coincida con la orden, cambia el estado de la
orden en WooCommerce cuando el pago es correcto, y **deriva a un humano** cuando
hace falta. Los humanos toman el chat desde un **dashboard** web.

**100% self-hosted en tu VPS — sin servicios de terceros para datos.**

- **WhatsApp**: [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web, no oficial).
- **LLM**: [Minimax](https://platform.minimax.io) `MiniMax-M3` (visión + tool calling) vía API OpenAI-compatible.
- **Tienda**: WooCommerce REST API v3.
- **Datos**: **Postgres** (contenedor propio) · **comprobantes**: archivos en un volumen del VPS · **auth**: login propio (staff + bcrypt + cookie JWT).

## Arquitectura

El **`server` es el único backend**: dueño de Postgres, la API REST, el storage de
comprobantes, la autenticación, Baileys y el harness de Nico. El **dashboard**
(Next.js) no toca la base de datos: consume la API del `server` (Next reescribe
`/api/*` → server, así todo es mismo-origen y sin CORS).

```
WhatsApp ──Baileys──┐
                    ▼
        ┌─────────────────────┐   tools (function calling)   ┌──────────────┐
        │      server/        │ ───────────────────────────▶ │  WooCommerce │
        │     (Node/TS)       │  catálogo, orden, pago        └──────────────┘
        │  Harness Nico (M3)  │ ───────────────────────────▶ ┌──────────────┐
        │  Postgres (pg)      │       visión (comprobantes)   │  Minimax M3  │
        │  Storage (archivos) │                               └──────────────┘
        │  API REST + Auth    │
        └─────────┬───────────┘
                  │  /api/*  (proxy de Next, mismo-origen)
                  ▼
        ┌─────────────────────┐
        │     dashboard/      │  inbox + toma de chat (polling cada 2-4s)
        │     (Next.js)       │  login propio (cookie de sesión)
        └─────────────────────┘
                  ▲
            Postgres ── docker volume (pgdata)   |   comprobantes ── docker volume (receipts)
```

## Estructura

```
server/                 # Node/TS — único backend
  src/
    config.ts           # env (validado con zod)
    index.ts            # migra DB + API + gateway
    db/
      schema.sql        # tablas (idempotente, se aplica al arrancar)
      pool.ts           # pool pg + migrate()
      repo.ts           # queries (conversaciones, mensajes, recibos, staff)
    api/
      server.ts         # API REST (auth, conversaciones, mensajes, media)
      auth.ts           # sesión JWT (jose)
    storage.ts          # comprobantes en disco (RECEIPTS_DIR)
    whatsapp/           # auth-postgres, socket, media
    agent/              # nico (harness), minimax, tools, prompt
    skills/             # catalog, orders, payments, handoff  ← capacidades de Nico
    handlers/messages.ts# enruta entrantes: bot vs humano, debounce, visión
    scripts/create-staff.ts
  test/                 # vitest (parseAmount, tolerancia, dispatch, harness, confirm_pago, resolve-order)
dashboard/              # Next.js — consume la API del server (/api proxy)
docker-compose.yml      # db (postgres) + server + dashboard
```

## Requisitos

- Node 20+ (probado con Node 24), `pnpm`. Para deploy: Docker + Docker Compose.
- API key de **Minimax** (suscripción de platform.minimax.io).
- **WooCommerce**: Consumer Key/Secret con permisos **Read/Write**.
- Un número de WhatsApp para Nico (lo vinculás escaneando un QR).

## Puesta en marcha (Docker — recomendado)

1. **Configurá `.env`**:
   ```bash
   cp .env.example .env
   ```
   Completá: `MINIMAX_API_KEY`; `WC_URL` / `WC_CONSUMER_KEY` / `WC_CONSUMER_SECRET`;
   `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`; un `AUTH_JWT_SECRET` largo y
   aleatorio. (En Docker, `DATABASE_URL`, `RECEIPTS_DIR` y `SERVER_API_URL` se
   setean solos para la red interna.)

2. **Levantá todo** (Postgres + server + dashboard). El schema se crea solo al arrancar:
   ```bash
   docker compose up -d --build
   docker compose logs -f server     # escaneá el QR de WhatsApp la primera vez
   ```

3. **Creá un usuario del dashboard** (staff):
   ```bash
   docker compose exec server pnpm create-staff vos@vapenic.com 'tu-password' 'Tu Nombre'
   ```

4. Entrá al dashboard en `http://TU_VPS:3000` y logueate. El QR de WhatsApp se
   escanea desde los **logs** del server (`docker compose logs -f server`) o, ya
   logueado, desde `/api/qr` (requiere sesión). El puerto del server no se expone
   al host por seguridad (el QR es equivalente a una credencial).

> Datos y comprobantes persisten en los volúmenes `pgdata` y `receipts`. Backup =
> `docker compose exec db pg_dump ...` + el volumen `receipts`.

## Desarrollo local (sin Docker)

Necesitás un Postgres local. Apuntá `DATABASE_URL` a él (ej:
`postgres://nico:nico@localhost:5432/nico`) y `SERVER_API_URL=http://localhost:3001`.
Para que Nico lea comprobantes en **PDF** en local, instalá poppler
(`brew install poppler` en macOS / `apt install poppler-utils` en Linux). En Docker
ya viene incluido. Sin poppler, Nico simplemente pide una foto del comprobante.

```bash
# server (terminal 1) — corre migraciones al arrancar e imprime el QR
cd server && pnpm install && pnpm dev
# crear staff (otra terminal, una vez)
cd server && pnpm create-staff vos@vapenic.com 'tu-password' 'Tu Nombre'
# dashboard (terminal 2)
cd dashboard && pnpm install && pnpm dev   # http://localhost:3000
```

## Cómo funciona

- **Persona humana**: Nico responde como una persona real del equipo; nunca revela
  que es un sistema automático. Responde en hasta **3 burbujas** cortas (más natural
  que un bloque largo).
- **Espera y contexto**: junta los mensajes del cliente **~60s** (`NICO_DEBOUNCE_MS`)
  antes de responder, así lee varios mensajes seguidos juntos. Mantiene el historial
  de la conversación y **no vuelve a saludar** si ya venían hablando.
- **Modo de cada conversación**: `bot` (responde Nico) o `human`. Mientras es
  `human`, Nico no responde.
- **Comprobantes**: el cliente puede mandar **foto o PDF**. Si es PDF, el server
  rasteriza la primera página a imagen para que Nico lo "vea". Se guarda en disco y
  se muestra en el dashboard.
- **Validación de pago**: Nico lee el monto y llama a `confirmar_pago`. El servidor
  compara contra el total de la orden de forma determinística
  (`PAYMENT_AMOUNT_TOLERANCE`) y solo confirma desde estados pre-pago (nunca reactiva
  una orden reembolsada/cancelada). Si todo da bien, pasa la orden a `processing`.
- **Identidad por teléfono o email**: si el teléfono del chat no coincide con la
  orden, Nico **pide el email** de la compra y verifica con eso — solo deriva a un
  humano si tampoco coincide (antes escalaba de más).
- **Catálogo headless**: los links de producto que comparte apuntan al storefront
  `WC_FRONT_URL` (ej. `https://shop.vapenic.com.ar/producto/<slug>`), no al WordPress.
- **FAQs de envíos y pagos**: Nico responde "¿cuándo llega?", "¿cuál es el alias?",
  etc. con la info cargada en **Configuración** (se inyecta en su contexto).
- **Escalado a humano** (`derivar_a_humano`): solo si el cliente lo pide o algo está
  fuera de alcance. La conversación pasa a `human`.
- **Dashboard**: lista de conversaciones (filtro "Con humano"), historial, **Tomar
  chat** (pausa a Nico) / **Devolver a Nico**, caja de respuesta (sale por WhatsApp al
  instante vía el `server`), panel de comprobantes, y **Pedidos del cliente**
  (items, fecha, estado, dirección) traídos de WooCommerce cuando hay identidad.
  Una sección **⚙ Configuración** permite editar medios de pago, envíos e info
  general que Nico usa para responder. Se actualiza por polling (2–4 s).

## Tests

```bash
cd server && pnpm test         # vitest: parseAmount, tolerancia, phone match, dispatch, harness, confirm_pago, resolve-order
pnpm -w typecheck              # tsc en server y dashboard (desde la raíz)
```

## Notas y riesgos

- **Baileys no es oficial**: WhatsApp puede banear la cuenta. No hagas mensajería
  masiva. Si Nico recibe `forbidden`, el server **frena** los reintentos y avisa.
- **+18**: Vapenic vende productos con nicotina. Nico no vende a menores.
- **Secretos**: `MINIMAX_API_KEY`, `WC_*`, `POSTGRES_PASSWORD` y `AUTH_JWT_SECRET`
  solo en el `.env` del VPS. Servir el dashboard detrás de HTTPS (y poner
  `secure: true` en la cookie) para producción.
- Cancelaciones/reembolsos los maneja un humano (Nico no los ejecuta).
