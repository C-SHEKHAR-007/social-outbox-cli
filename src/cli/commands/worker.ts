import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInstagramCycle } from '../../instagram/cycle.js';
import { storedInstagramAccount } from '../../instagram/connect-service.js';
import { UserError } from '../../utils/errors.js';
import type { AppContext } from '../context.js';
import { buildInstagramDeps, renderCycle, type InstagramCommandDeps } from './instagram.js';

export interface WorkerOptions {
  once?: boolean;
  /** Seconds between cycles (default WORKER_INTERVAL_SECONDS). */
  interval?: string;
}

export interface WorkerDeps extends InstagramCommandDeps {
  /** Aborting stops the worker after the current cycle (tests; signals do this in real use). */
  signal?: AbortSignal;
  /** Sleep between cycles; resolves early when `signal` aborts. */
  idle?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultIdle = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Long-running loop for platforms without native scheduling (Instagram): every interval it prepares
 * posts that are coming up and publishes those that are due. One worker per workspace (lock file);
 * Ctrl+C / SIGTERM stop it after the current step. Facebook is not touched (it schedules natively).
 */
export async function runWorker(ctx: AppContext, opts: WorkerOptions = {}, deps: WorkerDeps = {}): Promise<number> {
  const intervalS = opts.interval === undefined ? ctx.config.publishing.workerIntervalSeconds : Number(opts.interval);
  if (!Number.isFinite(intervalS) || intervalS < 5) throw new UserError('Invalid --interval: at least 5 seconds');

  const lock = join(ctx.paths.data, 'worker.lock');
  acquireLock(lock);
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  deps.signal?.addEventListener('abort', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let cycles = 0;
  const stopping = (): boolean => controller.signal.aborted;
  try {
    return await ctx.withDbAsync(async (db) => {
      if (!storedInstagramAccount(db))
        throw new UserError('Instagram is not connected. Run: reel-cli instagram connect');
      ctx.print(`Worker started (every ${intervalS}s${opts.once ? ', once' : ''}). Press Ctrl+C to stop.`);
      ctx.logger.info({ op: 'worker-start', intervalS }, 'worker started');
      for (;;) {
        const igDeps = buildInstagramDeps(ctx, db, deps);
        const stamp = () => new Date().toLocaleTimeString('en-GB', { timeZone: ctx.config.publishing.timezone });
        const report = await runInstagramCycle(igDeps, { config: ctx.config }, (it) => {
          const o = it.outcome;
          ctx.print(
            `[${stamp()}] ${it.action} #${it.post.videoId} ${it.video?.filename ?? ''}: ${o?.result ?? ''}${o?.message ? ` ${o.message}` : ''}`,
          );
        });
        cycles += 1;
        if (report.stopped || report.paused) {
          renderCycle(ctx, report, ctx.config.publishing.timezone, false);
          ctx.print('Worker stopped: fix the problem above, then start it again.');
          return 1;
        }
        if (opts.once || stopping()) break;
        await (deps.idle ?? defaultIdle)(intervalS * 1000, controller.signal);
        if (stopping()) break;
      }
      ctx.print(`Worker stopped after ${cycles} cycle(s).`);
      return 0;
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    rmSync(lock, { force: true });
    ctx.logger.info({ op: 'worker-stop', cycles }, 'worker stopped');
  }
}

function acquireLock(file: string): void {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new UserError(`A worker is already running (pid ${pid}). Stop it first, or delete ${file} if it is stale.`);
    }
  }
  writeFileSync(file, String(process.pid));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
