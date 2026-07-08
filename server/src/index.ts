import { config } from './config';
import { logger } from './logger';
import { migrate } from './db/pool';
import { WhatsAppGateway } from './whatsapp/socket';
import { MessageRouter } from './handlers/messages';
import { createApiServer } from './api/server';

async function main(): Promise<void> {
  await migrate();

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
  logger.info(`🤖 ${config.NICO_NAME} (server) iniciado para ${config.NICO_BUSINESS}`);

  const shutdown = (sig: string) => {
    logger.info({ sig }, 'shutting down');
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error on startup');
  process.exit(1);
});
