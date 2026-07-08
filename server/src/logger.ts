import pino from 'pino';
import { config } from './config';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
