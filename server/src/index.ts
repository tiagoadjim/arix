import { config } from './config';
import { logger } from './logger';
import { migrate } from './db/pool';
import { seedFromEnvOnFirstBoot } from './config/runtime';
import { WhatsAppGateway } from './whatsapp/socket';
import { MessageRouter } from './handlers/messages';
import { createApiServer } from './api/server';
import { closeMcpPool } from './mcp/manager';

async function main(): Promise<void> {
  await migrate();
  // Give env-driven deploys a DB row for anything they seed, so the dashboard
  // has something to take over once an env var is eventually removed.
  await seedFromEnvOnFirstBoot();

  const gateway = new WhatsAppGateway();
  const router = new MessageRouter(gateway);
  gateway.onMessage = (sock, msg) => router.handle(sock, msg);
  // On (re)connect, answer any customer whose last message went unanswered.
  gateway.onConnected = () => void router.recoverUnanswered();

  const app = createApiServer({ gateway });
  const httpServer = app.listen(config.PORT, () =>
    logger.info({ port: config.PORT }, 'API server listening'),
  );

  await gateway.start();
  logger.info('arix server started');

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down');
    await Promise.allSettled([
      closeMcpPool(),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error on startup');
  process.exit(1);
});
