import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** Keys that must never reach a log file. Pino wildcards match one level deep. */
export const REDACT_PATHS = [
  'access_token',
  'accessToken',
  'token',
  'pageAccessToken',
  'appSecret',
  'app_secret',
  'client_secret',
  'appsecret_proof',
  'authorization',
  'Authorization',
  'password',
  ...[
    'access_token',
    'accessToken',
    'token',
    'pageAccessToken',
    'appSecret',
    'app_secret',
    'client_secret',
    'appsecret_proof',
    'authorization',
    'Authorization',
    'password',
  ].map((k) => `*.${k}`),
];

export function createLogger(opts: { level: string; file?: string; destination?: DestinationStream }): Logger {
  let destination = opts.destination;
  if (!destination && opts.file) {
    mkdirSync(dirname(opts.file), { recursive: true });
    // sync writes: CLI processes are short-lived and must not lose the last lines on exit
    destination = pino.destination({ dest: opts.file, sync: true });
  }
  return pino(
    {
      level: opts.level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination ?? pino.destination({ dest: 2, sync: true }),
  );
}
