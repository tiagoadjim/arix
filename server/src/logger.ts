import pino from 'pino';
import { createHash } from 'node:crypto';
import { config } from './config';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers.x-setup-token',
      'headers.authorization',
      'headers.cookie',
      'headers.x-setup-token',
      '*.apiKey',
      '*.api_key',
      '*.consumerKey',
      '*.consumerSecret',
      '*.consumer_key',
      '*.consumer_secret',
      '*.password',
      '*.token',
      'err.config.headers.Authorization',
      'err.request.headers.Authorization',
      'err.body',
    ],
    censor: '[REDACTED]',
  },
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

export function logIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash('sha256')
    .update(`${config.AUTH_JWT_SECRET}:${value}`)
    .digest('hex')
    .slice(0, 16);
}
