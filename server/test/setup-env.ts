// DATABASE_URL and AUTH_JWT_SECRET are the only vars config.ts still requires
// (everything else below is optional there since Phase 3 — see server/src/config.ts).
// They're kept here anyway because they double as env SEEDS for the runtime
// config service (server/src/config/runtime.ts): no real Postgres is reachable
// in tests, so runtime.ts's DB read fails and degrades to these env values —
// resolve-order.test.ts / confirm-payment.test.ts / woocommerce.test.ts rely on
// that to get a `woo().configured === true` snapshot without mocking `pg`.
// Real env wins via ??=.
process.env.LLM_API_KEY ??= 'test-key';
process.env.LLM_BASE_URL ??= 'https://api.minimax.io/v1';
process.env.WC_URL ??= 'https://shop.example.com';
process.env.WC_CONSUMER_KEY ??= 'ck_test';
process.env.WC_CONSUMER_SECRET ??= 'cs_test';
process.env.WC_CURRENCY ??= 'ARS';
process.env.PAYMENT_AMOUNT_TOLERANCE ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/arix_test';
process.env.AUTH_JWT_SECRET ??= 'test-secret-at-least-16-chars-long';
process.env.RECEIPTS_DIR ??= './data/receipts';
