import { config } from './config';
import { logger } from './logger';
import { migrate } from './db/pool';
import { pool } from './db/pool';
import { rotateStoredSecrets, seedFromEnvOnFirstBoot } from './config/runtime';
import { WhatsAppGateway } from './whatsapp/socket';
import { MessageRouter } from './handlers/messages';
import { createApiServer } from './api/server';
import { readReceiptImage, startReceiptCleanup } from './storage';
import { createHash } from 'node:crypto';
import {
  listStaleReceiptReviews,
  listReceiptMediaMissingHashes,
  setReceiptMediaHash,
} from './db/repo';
import { reconcileReceiptAfterAmbiguousOrderUpdate } from './skills/payments';

async function reconcileReceiptState(): Promise<void> {
  const stale = await listStaleReceiptReviews();
  for (const receipt of stale) {
    if (!receipt.review_attempt_id || !receipt.woo_order_id) continue;
    const result = await reconcileReceiptAfterAmbiguousOrderUpdate({
      receiptId: receipt.id,
      attemptId: receipt.review_attempt_id,
      orderId: receipt.woo_order_id,
      statusAfterPayment: receipt.review_target_status,
      approvedNote: 'Pago reconciliado automáticamente después de una revisión interrumpida.',
    });
    logger.info({ receiptId: receipt.id, state: result.state }, 'reconciled interrupted receipt review');
  }
  const missing = await listReceiptMediaMissingHashes();
  let hashed = 0;
  for (const receipt of missing) {
    const image = await readReceiptImage(receipt.media_url);
    if (!image) continue;
    try {
      await setReceiptMediaHash(receipt.id, createHash('sha256').update(image).digest('hex'));
      hashed += 1;
    } catch (err) {
      // A duplicate hash means another historical row already protects this
      // image from reuse; leave this row untouched rather than failing boot.
      if ((err as { code?: string } | null)?.code !== '23505') throw err;
    }
  }
  if (hashed > 0) logger.info({ hashed }, 'backfilled historical receipt hashes');
}

async function main(): Promise<void> {
  await migrate();
  // Give env-driven deploys a DB row for anything they seed, so the dashboard
  // has something to take over once an env var is eventually removed.
  await seedFromEnvOnFirstBoot();
  await rotateStoredSecrets();
  await reconcileReceiptState();
  const stopReceiptCleanup = startReceiptCleanup();
  let reconcilingReceipts = false;
  const reconciliationTimer = setInterval(() => {
    if (reconcilingReceipts) return;
    reconcilingReceipts = true;
    void reconcileReceiptState()
      .catch((err) => logger.warn({ err }, 'periodic receipt reconciliation failed'))
      .finally(() => {
        reconcilingReceipts = false;
      });
  }, 5 * 60_000);
  reconciliationTimer.unref();

  const gateway = new WhatsAppGateway();
  const router = new MessageRouter(gateway);
  gateway.onMessage = (sock, msg) => router.handle(sock, msg);
  // On (re)connect, answer any customer whose last message went unanswered.
  gateway.onConnected = () => void router.recoverUnanswered();

  const app = createApiServer({
    gateway,
    recoverUnanswered: () => void router.recoverUnanswered(),
    cancelConversationTurn: (conversationId) => router.cancelConversationTurn(conversationId, 'human takeover'),
  });
  const httpServer = app.listen(config.PORT, () =>
    logger.info({ port: config.PORT }, 'API server listening'),
  );

  await gateway.start();
  logger.info('arix server started');

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) {
      logger.fatal({ sig }, 'second shutdown signal received; forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ sig }, 'shutting down');
    const hardDeadline = setTimeout(() => {
      logger.fatal({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, 'shutdown deadline exceeded; forcing exit');
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    hardDeadline.unref();
    try {
      clearInterval(reconciliationTimer);
      stopReceiptCleanup();
      // Stop accepting work immediately, then drain routers/transports while
      // existing HTTP requests get a short grace period.
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await Promise.all([
        router.stop(),
        gateway.stop().catch((err) => logger.warn({ err }, 'failed to stop WhatsApp cleanly')),
      ]);
      const drained = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          timer.unref();
        }),
      ]);
      if (!drained) {
        logger.warn('HTTP drain deadline reached; closing remaining connections');
        httpServer.closeAllConnections();
        await closed.catch(() => {});
      }
      await pool.end().catch((err) => logger.warn({ err }, 'failed to close Postgres pool cleanly'));
      logger.info('shutdown complete');
    } finally {
      clearTimeout(hardDeadline);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error on startup');
  process.exit(1);
});
