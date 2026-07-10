# Migrating an existing Vapenic deployment to Arix

For anyone running the pre-rename "Vapenic bot" (Nico) in production and
upgrading in place. This is not a fresh-install guide — see the main
[README](../README.md#quickstart-docker) for that.

## What happens automatically

- **`sender` values** — existing messages with `sender = 'nico'` are updated
  to `'agent'` by migration `0002_sender_agent.sql`, which runs on the
  server's next boot. No action needed.
- **Settings keys** — legacy flat setting keys (`medios_de_pago`, `envios`,
  `info_general`, `envio_template`, `compliance_rules`) are renamed in
  place to their new dot-namespaced equivalents (`info.payment`,
  `info.shipping`, `info.general`, `dispatch.template`, `compliance.rules`)
  by migration `0003_settings_namespaced.sql`. Values are preserved, not
  reset.

Both migrations are idempotent and part of the normal migration runner —
nothing extra to run by hand.

## What you need to do

### 1. Rename your environment variables

Behavior is unchanged except where noted below — just rename the key in
`.env`; the value carries over as-is.

| Old variable | New variable | Notes |
|---|---|---|
| `MINIMAX_API_KEY` | `LLM_API_KEY` | Also set `LLM_PROVIDER=minimax` — the provider is no longer implicit. |
| `MINIMAX_BASE_URL` | `LLM_BASE_URL` | Now optional; leave unset to use MiniMax's own default. |
| `MINIMAX_MODEL` | `LLM_MODEL` | |
| `MINIMAX_MODEL_FAST` | *(removed)* | Was dead config, never read by the running code — no replacement. |
| `MINIMAX_REASONING_SPLIT` | `LLM_REASONING_SPLIT` | |
| `MINIMAX_THINKING_DISABLED` | `LLM_THINKING_DISABLED` | |
| `NICO_NAME` | `AGENT_NAME` | New default is `Arix` — set this explicitly to keep your agent's current name. |
| `NICO_BUSINESS` | `BUSINESS_NAME` | New default is `My Store` — set this explicitly to keep your business name. |
| `NICO_HISTORY_LIMIT` | `AGENT_HISTORY_LIMIT` | Same default (30). |
| `NICO_DEBOUNCE_MS` | `AGENT_DEBOUNCE_MS` | Same default (60000). |
| `NICO_MAX_BUBBLES` | `AGENT_MAX_BUBBLES` | Same default (3). |

`WC_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `PAYMENT_AMOUNT_TOLERANCE`,
`WC_STATUS_AFTER_PAYMENT`, `DATABASE_URL`, `RECEIPTS_DIR`, `AUTH_JWT_SECRET`,
`COOKIE_SECURE`, `PORT`, `WA_MARK_ONLINE`, and `LOG_LEVEL` keep their old
names and behavior unchanged.

### 2. Keep your paired WhatsApp session

The default `WA_ACCOUNT_ID` changed from `vapenic-main` to `default`. Your
existing pairing is stored in Postgres under the old key — if you don't set
this explicitly, Arix looks for a session under `default`, finds nothing, and
asks you to pair again with a new QR code.

**Set `WA_ACCOUNT_ID=vapenic-main` in your `.env`** to keep using the
already-paired number without re-scanning.

### 3. A few defaults changed

These now need an explicit value (env var, or the equivalent dashboard
setting once you're past onboarding) if you want to keep the old behavior:

- **`WC_FRONT_URL`** is now optional with no built-in fallback (it used to
  default to `https://shop.vapenic.com.ar`). If your storefront domain
  differs from `WC_URL`, set it explicitly — otherwise product links keep
  whatever origin the WooCommerce API's own `permalink` already has.
- **`WC_CURRENCY`** now defaults to `USD` instead of `ARS`. Set
  `WC_CURRENCY=ARS` to keep prices displayed in pesos.
- **`WC_STATUS_AFTER_DISPATCH`** now defaults to empty (dispatch sends its
  WhatsApp message but sets no custom order status) instead of `en-camino`.
  Set it explicitly if you still want that status applied.
- **DeepSeek's model aliases are retiring**: if `LLM_MODEL` was ever pointed
  at `deepseek-chat` or `deepseek-reasoner`, switch to the canonical
  `deepseek-v4-flash` (see `server/src/agent/llm/providers.ts`) before those
  aliases stop resolving.

### 4. Everyone needs to log back into the dashboard

The session cookie was renamed from `nico_session` to `arix_session`,
invalidating every active dashboard session. Staff just need to log in
again — nothing else is affected.

## Everything else

The onboarding wizard (`/setup`) only runs when no staff account exists yet,
so an upgraded deployment with existing staff skips straight to the normal
dashboard — it will not re-prompt for setup. Existing conversations, orders,
and receipts are untouched by any of the above.

Current Arix releases still require a `SETUP_TOKEN` (minimum 32 characters) at
process startup, including upgraded installations whose bootstrap endpoint is
already disabled by existing staff. Add an independently generated value
(`openssl rand -hex 32`) to `.env`; existing administrators never need to
enter it unless they intentionally start again with an empty staff table.
