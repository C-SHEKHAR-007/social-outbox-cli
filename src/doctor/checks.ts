import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { resolvePageCredentials } from '../facebook/credentials.js';
import { createTokenStore, type TokenStore } from '../facebook/token-store.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { resolvePaths } from '../config/paths.js';
import { isPublishingPaused, getAppState } from '../db/app-state.js';
import { appliedMigrationCount, openDatabase } from '../db/client.js';
import { videos } from '../db/schema.js';
import { count } from 'drizzle-orm';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

export interface DoctorDeps {
  cwd: string;
  tokenStore?: TokenStore;
  env?: NodeJS.ProcessEnv;
  run?: RunCommand;
  fetch?: typeof fetch;
  nodeVersion?: string;
}

const defaultRun: RunCommand = async (cmd, args) => (await execa(cmd, args, { timeout: 10_000 })).stdout;

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const run = deps.run ?? defaultRun;
  const fetchFn = deps.fetch ?? fetch;
  const results: CheckResult[] = [
    checkNode(deps.nodeVersion ?? process.versions.node),
    { name: 'workspace', status: 'ok', detail: deps.cwd },
  ];

  let config: AppConfig;
  try {
    config = loadConfig(deps.cwd, deps.env);
    results.push({
      name: 'config',
      status: 'ok',
      detail: existsSync(`${deps.cwd}/.env`) ? '.env valid' : 'defaults (no .env)',
    });
  } catch (err) {
    results.push({ name: 'config', status: 'fail', detail: (err as Error).message });
    return results;
  }

  results.push(await checkBinary(run, 'ffprobe', ['-version'], 'fail'));
  results.push(await checkBinary(run, 'ffmpeg', ['-version'], 'fail'));
  results.push(checkDatabase(deps.cwd, config));
  results.push(await checkOllama(fetchFn, config));
  results.push(await checkWhisper(run, config));
  results.push(
    checkFacebook(
      deps.cwd,
      config,
      deps.tokenStore ?? createTokenStore(join(resolvePaths(deps.cwd, config.databaseUrl).data, 'credentials.json')),
    ),
  );
  results.push(checkInstagram(deps.cwd, config));
  return results;
}

/** Informational only: Instagram is optional. */
function checkInstagram(cwd: string, config: AppConfig): CheckResult {
  const paths = resolvePaths(cwd, config.databaseUrl);
  if (paths.db !== ':memory:' && !existsSync(paths.db)) {
    return { name: 'instagram', status: 'ok', detail: 'not connected (optional)' };
  }
  const handle = openDatabase(paths.db);
  try {
    const id = getAppState(handle.db, 'instagram_user_id');
    if (!id) return { name: 'instagram', status: 'ok', detail: 'not connected (optional: reel-cli instagram connect)' };
    const user = getAppState(handle.db, 'instagram_username');
    if (getAppState(handle.db, 'instagram_paused') === 'true') {
      return {
        name: 'instagram',
        status: 'warn',
        detail: `${user ? `@${user}` : id} PAUSED (reel-cli instagram resume)`,
      };
    }
    return {
      name: 'instagram',
      status: 'ok',
      detail: `${user ? `@${user} ` : ''}(${id}); posts at their time while \`reel-cli worker\` runs`,
    };
  } finally {
    handle.close();
  }
}

export function checkNode(version: string): CheckResult {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const ok = major > 20 || (major === 20 && minor >= 5);
  return { name: 'node', status: ok ? 'ok' : 'fail', detail: ok ? `v${version}` : `v${version} (need >= 20.5)` };
}

async function checkBinary(
  run: RunCommand,
  cmd: string,
  args: string[],
  missingStatus: CheckStatus,
  hint = `install it (e.g. sudo apt install ffmpeg)`,
): Promise<CheckResult> {
  try {
    const out = await run(cmd, args);
    return { name: cmd, status: 'ok', detail: (out.split('\n')[0] ?? 'found').replace(/\s+Copyright.*$/, '').trim() };
  } catch {
    return { name: cmd, status: missingStatus, detail: `not found — ${hint}` };
  }
}

function checkDatabase(cwd: string, config: AppConfig): CheckResult {
  const paths = resolvePaths(cwd, config.databaseUrl);
  if (paths.db !== ':memory:' && !existsSync(paths.db)) {
    return { name: 'database', status: 'fail', detail: 'not initialized — run `reel-cli init`' };
  }
  try {
    const handle = openDatabase(paths.db);
    try {
      const total = handle.db.select({ n: count() }).from(videos).get()?.n ?? 0;
      const migrations = appliedMigrationCount(handle.sqlite);
      if (isPublishingPaused(handle.db)) {
        const reason = getAppState(handle.db, 'paused_reason') ?? 'unknown reason';
        return {
          name: 'database',
          status: 'warn',
          detail: `publishing PAUSED (${reason}) — review, then \`reel-cli resume\``,
        };
      }
      return { name: 'database', status: 'ok', detail: `${total} video(s), ${migrations} migration(s)` };
    } finally {
      handle.close();
    }
  } catch (err) {
    return { name: 'database', status: 'fail', detail: (err as Error).message };
  }
}

async function checkOllama(fetchFn: typeof fetch, config: AppConfig): Promise<CheckResult> {
  const { ollamaBaseUrl: base, ollamaModel: model } = config.ai;
  try {
    const res = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { name: 'ollama', status: 'warn', detail: `${base} returned HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (body.models ?? []).map((m) => m.name);
    const wanted = model.includes(':') ? model : `${model}:latest`;
    if (names.includes(wanted)) return { name: 'ollama', status: 'ok', detail: `${base}, model ${model} available` };
    return { name: 'ollama', status: 'warn', detail: `model ${model} not pulled — run \`ollama pull ${model}\`` };
  } catch {
    return { name: 'ollama', status: 'warn', detail: `not reachable at ${base} (needed for \`generate\`)` };
  }
}

async function checkWhisper(run: RunCommand, config: AppConfig): Promise<CheckResult> {
  const binary = config.ai.whisperBinary ?? 'whisper-cli';
  const result = await checkBinary(
    run,
    binary,
    ['--help'],
    'warn',
    'install whisper.cpp or set WHISPER_BINARY (needed for `transcribe`)',
  );
  return { ...result, name: 'whisper', detail: result.status === 'ok' ? binary : result.detail };
}

function checkFacebook(cwd: string, config: AppConfig, store: TokenStore): CheckResult {
  const fb = config.facebook;
  const warn = (detail: string): CheckResult => ({ name: 'facebook', status: 'warn', detail });
  if (!fb.appId || !fb.appSecret) return warn('FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not set (needed for publishing)');

  const paths = resolvePaths(cwd, config.databaseUrl);
  if (paths.db !== ':memory:' && !existsSync(paths.db)) return warn('workspace not initialized');
  const handle = openDatabase(paths.db);
  try {
    const creds = resolvePageCredentials(config, handle.db, store);
    if (!creds) return warn('no Page connected; run `reel-cli facebook login`');
    // token_checked_at belongs to the stored login; a .env token has never been verified by us.
    const checked = creds.source === 'env' ? undefined : getAppState(handle.db, 'token_checked_at');
    const where = creds.source === 'env' ? '.env' : creds.source;
    return {
      name: 'facebook',
      status: 'ok',
      detail: `Page ${creds.pageName ? `"${creds.pageName}" ` : ''}(${creds.pageId}), token in ${where}; ${checked ? `last verified ${checked.slice(0, 10)}` : 'not verified yet (`reel-cli facebook verify`)'}`,
    };
  } finally {
    handle.close();
  }
}
