import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import type { PublishTarget } from '../domain/states.js';
import { ConfigError } from '../utils/errors.js';
import { parseSlots } from '../scheduling/slots.js';

const optionalString = z.string().min(1).optional();
const SLOT_MESSAGE = 'must be comma-separated HH:mm times (e.g. 09:00,14:00) or "none"';
const isSlotList = (v: string) => parseSlots(v) !== null;

const EnvSchema = z.object({
  FACEBOOK_APP_ID: optionalString,
  FACEBOOK_APP_SECRET: optionalString,
  FACEBOOK_PAGE_ID: z.string().regex(/^\d+$/, 'must be a numeric Page ID').optional(),
  FACEBOOK_PAGE_ACCESS_TOKEN: optionalString,
  FACEBOOK_OAUTH_PORT: z.coerce.number().int().min(1024).max(65535).default(8585),
  GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'must look like v26.0')
    .default('v26.0'),

  QUOTA_PER_24H: z.coerce.number().int().min(1).max(30).default(25),
  REEL_SLOTS: z.string().refine(isSlotList, SLOT_MESSAGE).default('09:00,14:00,20:00'),
  VIDEO_SLOTS: z.string().refine(isSlotList, SLOT_MESSAGE).default('12:00,18:00'),
  REEL_MAX_DURATION_S: z.coerce.number().int().min(3).max(3600).default(90),
  MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  PUBLISH_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(3),
  WORKER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  TIMEZONE: z
    .string()
    .refine((tz) => IANAZone.isValidZone(tz), 'must be a valid IANA timezone, e.g. Asia/Kolkata')
    .default('Asia/Kolkata'),

  AI_PROVIDER: z.enum(['ollama']).default('ollama'),
  OLLAMA_BASE_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3:8b'),
  TRANSCRIPTION_PROVIDER: z.enum(['whisper-cpp']).default('whisper-cpp'),
  WHISPER_MODEL: z.string().min(1).default('small'),
  WHISPER_BINARY: optionalString,

  DATABASE_URL: z.string().min(1).default('./data/reels.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export interface AppConfig {
  facebook: {
    appId: string | undefined;
    appSecret: string | undefined;
    pageId: string | undefined;
    pageAccessToken: string | undefined;
    graphApiVersion: string;
    /** Local port for the browser-login callback (http://localhost:PORT/callback). */
    oauthPort: number;
  };
  publishing: {
    quotaPer24h: number;
    /** Longer videos are published as regular Page videos instead of Reels. */
    reelMaxDurationS: number;
    /** Default daily posting times per target (HH:mm, local). Empty = do not auto-schedule. */
    slots: Record<PublishTarget, string[]>;
    maxRetries: number;
    /** Videos uploaded in parallel by `publish`. */
    concurrency: number;
    workerIntervalSeconds: number;
    timezone: string;
  };
  ai: {
    provider: 'ollama';
    ollamaBaseUrl: string;
    ollamaModel: string;
    transcriptionProvider: 'whisper-cpp';
    whisperModel: string;
    whisperBinary: string | undefined;
  };
  databaseUrl: string;
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
}

/** Pure: validates an env-like record. Empty strings are treated as unset. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
  }
  const e = result.data;
  return {
    facebook: {
      appId: e.FACEBOOK_APP_ID,
      appSecret: e.FACEBOOK_APP_SECRET,
      pageId: e.FACEBOOK_PAGE_ID,
      pageAccessToken: e.FACEBOOK_PAGE_ACCESS_TOKEN,
      graphApiVersion: e.GRAPH_API_VERSION,
      oauthPort: e.FACEBOOK_OAUTH_PORT,
    },
    publishing: {
      quotaPer24h: e.QUOTA_PER_24H,
      reelMaxDurationS: e.REEL_MAX_DURATION_S,
      slots: { REEL: parseSlots(e.REEL_SLOTS) ?? [], VIDEO: parseSlots(e.VIDEO_SLOTS) ?? [] },
      maxRetries: e.MAX_RETRIES,
      concurrency: e.PUBLISH_CONCURRENCY,
      workerIntervalSeconds: e.WORKER_INTERVAL_SECONDS,
      timezone: e.TIMEZONE,
    },
    ai: {
      provider: e.AI_PROVIDER,
      ollamaBaseUrl: e.OLLAMA_BASE_URL.replace(/\/+$/, ''),
      ollamaModel: e.OLLAMA_MODEL,
      transcriptionProvider: e.TRANSCRIPTION_PROVIDER,
      whisperModel: e.WHISPER_MODEL,
      whisperBinary: e.WHISPER_BINARY,
    },
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
  };
}

/** Reads `<cwd>/.env` (if present); real environment variables take precedence. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envFile = join(cwd, '.env');
  const fileVars = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
  return parseConfig({ ...fileVars, ...env });
}
