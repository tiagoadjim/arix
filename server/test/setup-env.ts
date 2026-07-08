// Provide dummy env so `config.ts` validates (and doesn't process.exit) in tests.
// Real env wins via ??=.
process.env.MINIMAX_API_KEY ??= 'test-key';
process.env.MINIMAX_BASE_URL ??= 'https://api.minimax.io/v1';
process.env.WC_URL ??= 'https://shop.example.com';
process.env.WC_CONSUMER_KEY ??= 'ck_test';
process.env.WC_CONSUMER_SECRET ??= 'cs_test';
process.env.WC_CURRENCY ??= 'ARS';
process.env.PAYMENT_AMOUNT_TOLERANCE ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/nico_test';
process.env.AUTH_JWT_SECRET ??= 'test-secret-at-least-16-chars-long';
process.env.RECEIPTS_DIR ??= './data/receipts';
