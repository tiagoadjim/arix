---
name: woocommerce
description: |
  Talk to a WooCommerce store from Node/TypeScript via the REST API v3. Use when
  searching products/flavors and stock, looking up an order by number, finding a
  customer's orders by phone, or changing an order's status (e.g. confirming a
  bank transfer). Triggers: "WooCommerce", "wc/v3", "consumer key", "order
  status", "product variations", "WooCommerce REST API".
---

# WooCommerce REST API v3 — for Nico

All endpoints live under `<WC_URL>/wp-json/wc/v3`. Auth is **HTTP Basic** over
HTTPS: consumer key as username, consumer secret as password. A **Read/Write**
key is required to change order status (WooCommerce → Settings → Advanced → REST API).

Implemented in `server/src/integrations/woocommerce.ts`.

```ts
const AUTH = 'Basic ' + Buffer.from(`${ck}:${cs}`).toString('base64');
fetch(`${BASE}/orders/${id}`, { headers: { Authorization: AUTH } });
```

## Products & flavors

- `GET /products?search=&category=&stock_status=&type=&per_page=` — `search` is
  full-text; `category` is a term **id** (resolve via `GET /products/categories`);
  `type=variable` finds products with variations.
- Read `price` / `regular_price` / `sale_price` (strings), `stock_status`
  (`instock|outofstock|onbackorder`), `stock_quantity` (null when `manage_stock` is false).
- **Flavors = variations.** On the parent, `attributes[]` with `variation:true`
  has `options[]` (all flavor names). `variations[]` are the variation ids.
  `GET /products/<id>/variations` → each variation's `attributes[].option` is the
  single flavor, with its own `price` and `stock_status`/`stock_quantity`.

## Orders

- `GET /orders/<id>` — `<id>` is the internal id (URL id). `number` is the
  display number; equals `id` unless a sequential-number plugin is installed.
- Fields: `status`, `currency`, `total` (string), `billing.phone`, `line_items[]`
  (`name`, `quantity`, `meta_data[]` carries the chosen variation/flavor),
  `payment_method` (`bacs` = bank transfer), `date_paid` (null until paid).
- **Resolve a number → order**: try `GET /orders/<number>`; if `number !== id`,
  `GET /orders?search=<number>` and match the `number` field. (`resolveOrderByNumber`.)
- **Find by phone**: `GET /orders?search=<phone>&per_page=100`, then re-filter by
  `billing.phone` (search is fuzzy/cross-field). Compare digit suffixes to handle
  country-code format differences. (`findOrdersByPhone` / `phoneSuffix`.)
- Lists are header-paginated: `X-WP-Total`, `X-WP-TotalPages`; `per_page` default 10, max 100.

## Change status (confirm a transfer)

```
PUT /orders/<id>   body: { "status": "processing" }
```

Core status slugs (no `wc-` prefix): `pending`, `processing`, `on-hold`,
`completed`, `cancelled`, `refunded`, `failed`. A new BACS order lands in
`on-hold`; confirming payment → `processing`. `date_paid` is set automatically.

> In Nico, only `confirmar_pago` writes status (→ `WC_STATUS_AFTER_PAYMENT`),
> and only after a deterministic server-side amount match. Cancellations /
> refunds are intentionally left to humans (escalate instead).
