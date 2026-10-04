import { deleteAppState, getAppState, setAppState } from '../../db/app-state.js';
import type { Db } from '../../db/client.js';
import { countPostsByState, listPosts, postsSentSince, updatePost } from '../../db/platform-post-repository.js';
import { POST_STATES } from '../../domain/platforms.js';
import { resolvePageCredentials } from '../../facebook/credentials.js';
import { GraphClient } from '../../facebook/graph-client.js';
import { loginWithBrowser } from '../../facebook/login-service.js';
import {
  isInstagramPaused,
  linkInstagramAccount,
  missingInstagramScopes,
  storedInstagramAccount,
  type InstagramAccount,
} from '../../instagram/connect-service.js';
import { runInstagramCycle, type CycleItem, type CycleReport } from '../../instagram/cycle.js';
import { igPublishingLimit, INSTAGRAM_SCOPES } from '../../instagram/ig-api.js';
import { planInstagramFromFacebook, type PlanFromFacebookReport } from '../../instagram/plan-service.js';
import type { InstagramDeps } from '../../instagram/publisher.js';
import { leaseOwner } from '../../publisher/lease.js';
import { formatLocal } from '../../utils/dates.js';
import { UserError } from '../../utils/errors.js';
import { openUrl as defaultOpenUrl } from '../../utils/open-url.js';
import type { AppContext } from '../context.js';
import { requireApp, type FacebookCommandDeps } from './facebook.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Connects the Instagram professional account linked to the Facebook Page. If the stored Page token
 * lacks the Instagram permissions (or --login is given), runs the browser login again asking for the
 * Facebook permissions plus instagram_basic and instagram_content_publish.
 */
export async function runInstagramConnect(
  ctx: AppContext,
  opts: { login?: boolean; port?: string; browser?: boolean } = {},
  deps: FacebookCommandDeps = {},
): Promise<InstagramAccount> {
  const app = requireApp(ctx);
  const client = deps.client ?? new GraphClient({ version: app.graphApiVersion, appSecret: app.appSecret });
  const store = ctx.tokenStore();
  const port = opts.port === undefined ? ctx.config.facebook.oauthPort : Number(opts.port);

  return ctx.withDbAsync(async (db) => {
    let page = resolvePageCredentials(ctx.config, db, store);
    if (!page) throw new UserError('Connect the Facebook Page first: reel-cli facebook login');
    const missing = opts.login ? [...INSTAGRAM_SCOPES] : await missingInstagramScopes(client, app, page.token);

    if (missing.length) {
      ctx.print(
        `The Page token is missing Instagram permissions (${missing.join(', ')}); logging in again to add them.`,
      );
      ctx.print(
        'If the browser shows "Invalid Scopes", add the Instagram permissions to your Meta app first (see README).',
      );
      await loginWithBrowser({
        app,
        client,
        db,
        store,
        port,
        timeoutMs: deps.timeoutMs ?? LOGIN_TIMEOUT_MS,
        openUrl: deps.openUrl ?? defaultOpenUrl,
        choosePage: deps.choosePage ?? (() => Promise.reject(new UserError('Use --page or connect a single Page'))),
        print: ctx.print,
        pageId: page.pageId,
        noBrowser: opts.browser === false,
        extraScopes: INSTAGRAM_SCOPES,
        retryCommand: 'reel-cli instagram connect --login',
      });
      page = resolvePageCredentials(ctx.config, db, store);
      if (!page) throw new UserError('Login did not store a Page token.');
    }

    const acct = await linkInstagramAccount(db, client, page);
    ctx.print();
    ctx.print(
      `✓ Instagram connected: ${acct.username ? `@${acct.username} ` : ''}(${acct.igUserId}), via Page "${page.pageName ?? page.pageId}".`,
    );
    ctx.logger.info({ op: 'instagram-connect', igUserId: acct.igUserId }, 'instagram connected');
    return acct;
  });
}

export async function runInstagramStatus(
  ctx: AppContext,
  deps: FacebookCommandDeps = {},
  now = new Date(),
): Promise<void> {
  const store = ctx.tokenStore();
  await ctx.withDbAsync(async (db) => {
    const acct = storedInstagramAccount(db);
    const p = ctx.print;
    p('Instagram');
    p('=========');
    if (!acct) {
      p('Not connected. Run: reel-cli instagram connect');
      return;
    }
    p(`Account:      ${acct.username ? `@${acct.username} ` : ''}(${acct.igUserId})`);
    if (isInstagramPaused(db))
      p(`⚠ PAUSED: ${getAppState(db, 'instagram_paused_reason') ?? 'unknown reason'} (reel-cli instagram resume)`);
    const byState = countPostsByState(db, 'instagram');
    p();
    for (const s of POST_STATES)
      if (byState[s]) p(`${`${s[0]}${s.slice(1).toLowerCase()}:`.padEnd(14)}${String(byState[s]).padStart(5)}`);
    if (!Object.keys(byState).length) p('No Instagram posts planned yet (set ig_action in the CSV).');
    p();
    p(
      `Posts (24h):  ${postsSentSince(db, 'instagram', now)}/${ctx.config.instagram.dailyLimit} (INSTAGRAM_DAILY_LIMIT)`,
    );

    const page = resolvePageCredentials(ctx.config, db, store);
    const { appId, appSecret, graphApiVersion } = ctx.config.facebook;
    if (page && appId && appSecret) {
      try {
        const client = deps.client ?? new GraphClient({ version: graphApiVersion, appSecret });
        const limit = await igPublishingLimit(client, acct.igUserId, page.token);
        if (limit.used !== undefined) p(`Instagram's own quota: ${limit.used}/${limit.total ?? 100} in the last 24h`);
      } catch (err) {
        p(`(could not read Instagram's quota: ${(err as Error).message})`);
      }
    }
  });
}

// ---------- plan / publish / retry / resume ----------

/** Everything the Instagram publisher needs; throws a clear error if Instagram isn't connected. */
export function buildInstagramDeps(ctx: AppContext, db: Db, deps: InstagramCommandDeps = {}): InstagramDeps {
  const page = resolvePageCredentials(ctx.config, db, ctx.tokenStore());
  if (!page) throw new UserError('No Facebook Page connected. Run: reel-cli facebook login');
  const acct = storedInstagramAccount(db);
  if (!acct) throw new UserError('Instagram is not connected. Run: reel-cli instagram connect');
  return {
    db,
    client:
      deps.client ??
      new GraphClient({ version: ctx.config.facebook.graphApiVersion, appSecret: ctx.config.facebook.appSecret }),
    igUserId: acct.igUserId,
    token: page.token,
    owner: leaseOwner(),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    logger: ctx.logger,
    maxRetries: ctx.config.publishing.maxRetries,
    backoffMs: deps.backoffMs,
    normalizedDir: ctx.paths.normalized,
    normalize: deps.normalize,
    processingWaitMs: deps.processingWaitMs ?? 3 * 60_000,
    pollIntervalMs: deps.pollIntervalMs ?? 10_000,
  };
}

export interface InstagramCommandDeps extends FacebookCommandDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number[];
  normalize?: InstagramDeps['normalize'];
  processingWaitMs?: number;
  pollIntervalMs?: number;
}

export function runInstagramPlan(
  ctx: AppContext,
  opts: { fromFacebook?: boolean; offset?: string; ids?: number[]; apply?: boolean } = {},
  now = new Date(),
): PlanFromFacebookReport {
  if (!opts.fromFacebook) throw new UserError('Use --from-facebook (or set ig_action / ig_scheduled_at in the CSV).');
  const offsetMinutes = opts.offset === undefined ? 0 : Number(opts.offset);
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 24 * 60)
    throw new UserError(`Invalid --offset: ${String(opts.offset)} (minutes)`);
  const tz = ctx.config.publishing.timezone;
  return ctx.withDb((db) => {
    const r = planInstagramFromFacebook(db, { now, offsetMinutes, ids: opts.ids, apply: opts.apply });
    const p = ctx.print;
    const changes = r.planned.filter((x) => x.change !== 'unchanged');
    p(
      `Instagram plan from the Facebook schedule${offsetMinutes ? ` (+${offsetMinutes} min)` : ''}: ${r.planned.length} video(s)`,
    );
    for (const x of r.planned.slice(0, 15))
      p(`  ${formatLocal(x.at.toISOString(), tz)}  #${x.video.id} ${x.video.filename}  ${x.change}`);
    if (r.planned.length > 15) p(`  … and ${r.planned.length - 15} more`);
    if (r.skipped.length) {
      p();
      p(`Not planned: ${r.skipped.length}`);
      const reasons = new Map<string, number>();
      for (const s of r.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
      for (const [reason, n] of reasons) p(`  ${n} × ${reason}`);
    }
    p();
    if (!changes.length) p('Nothing to change.');
    else if (!opts.apply) p(`Preview only. Run again with --apply to save ${changes.length} change(s).`);
    else {
      p(
        `Saved ${changes.length} Instagram post(s). They publish via \`reel-cli worker\` (Instagram has no native scheduling).`,
      );
      ctx.logger.info({ op: 'instagram-plan', count: changes.length, offsetMinutes }, 'instagram plan applied');
    }
    return r;
  });
}

export async function runInstagramPublish(
  ctx: AppContext,
  opts: { dryRun?: boolean; ids?: number[] } = {},
  deps: InstagramCommandDeps = {},
): Promise<{ report: CycleReport; code: number }> {
  const tz = ctx.config.publishing.timezone;
  return ctx.withDbAsync(async (db) => {
    const igDeps = buildInstagramDeps(ctx, db, deps);
    const report = await runInstagramCycle(igDeps, { config: ctx.config, dryRun: opts.dryRun, ids: opts.ids }, (it) => {
      ctx.print(
        `${describeAction(it.action)} #${it.post.videoId} ${it.video?.filename ?? ''}: ${describeIgOutcome(it.outcome)}`,
      );
    });
    renderCycle(ctx, report, tz, !!opts.dryRun);
    const failed = report.items.some((i) => i.outcome?.result === 'failed' || i.outcome?.result === 'unknown');
    return { report, code: report.stopped || failed ? 1 : 0 };
  });
}

export function renderCycle(ctx: AppContext, report: CycleReport, tz: string, dryRun: boolean): void {
  const p = ctx.print;
  if (report.paused) p(`⚠ Instagram is PAUSED: ${report.paused}. Review the account, then: reel-cli instagram resume`);
  if (dryRun) {
    const groups: Array<[string, CycleItem[]]> = [
      ['Check with Instagram', report.items.filter((i) => i.action === 'reconcile')],
      ['Publish now', report.items.filter((i) => i.action === 'publish')],
      ['Prepare now (re-encode + upload)', report.items.filter((i) => i.action === 'prepare')],
      ['Waiting', report.items.filter((i) => i.action === 'wait')],
    ];
    p(`Instagram plan (dry run: nothing will be sent)`);
    for (const [title, items] of groups) {
      if (!items.length) continue;
      p();
      p(`${title}: ${items.length}`);
      for (const i of items.slice(0, 15)) {
        const when = i.until ? ` until ${formatLocal(i.until.toISOString(), tz)}` : '';
        p(
          `  #${i.post.videoId} ${i.video?.filename ?? ''}  due ${formatLocal(i.dueAt.toISOString(), tz)}${i.reason ? `  (${i.reason}${when})` : ''}`,
        );
      }
      if (items.length > 15) p(`  … and ${items.length - 15} more`);
    }
    if (!report.items.length)
      p('\nNo Instagram posts planned. Use `reel-cli instagram plan --from-facebook` or the CSV.');
  }
  if (report.stopped?.reason === 'pause') {
    p(`⚠ Instagram is PAUSED: ${report.stopped.message}`);
    p(
      '  Facebook publishing is not affected. Wait (at least 24 h for "posting too fast"), then: reel-cli instagram resume',
    );
  } else if (report.stopped) {
    p(`✗ Stopped: ${report.stopped.message}`);
  }
}

function describeAction(a: CycleItem['action']): string {
  return a === 'publish' ? '▶ publish' : a === 'prepare' ? '⇪ prepare' : a === 'reconcile' ? '↻ check' : '…';
}

function describeIgOutcome(o: CycleItem['outcome']): string {
  if (!o) return '';
  switch (o.result) {
    case 'published':
      return `✓ published${o.message ? ` ${o.message}` : ''}`;
    case 'prepared':
      return '✓ uploaded and processed; publishes at its time';
    case 'processing':
      return '… uploaded, Instagram still processing';
    case 'requeued':
      return `↺ ${o.message ?? 're-uploading next cycle'}`;
    case 'held':
      return `⏸ held: ${o.message ?? ''}`;
    case 'unknown':
      return `? ${o.message ?? 'outcome unknown; will be checked'}`;
    case 'failed':
      return `✗ failed: ${o.message ?? ''}`;
    default:
      return `– skipped: ${o.message ?? ''}`;
  }
}

export function runInstagramRetry(ctx: AppContext, opts: { ids?: number[] } = {}): number {
  return ctx.withDb((db) => {
    const failed = listPosts(db, 'instagram').filter(
      (p) => p.state === 'FAILED' && (!opts.ids || opts.ids.includes(p.videoId)),
    );
    for (const p of failed) {
      updatePost(db, p.id, {
        state: 'READY',
        containerId: null,
        containerCreatedAt: null,
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
        lastErrorCode: null,
        lockedBy: null,
        lockExpiresAt: null,
      });
    }
    ctx.print(
      failed.length ? `Reset ${failed.length} failed Instagram post(s) to READY.` : 'No failed Instagram posts.',
    );
    return failed.length;
  });
}

export function runInstagramResume(ctx: AppContext): boolean {
  return ctx.withDb((db) => {
    if (!isInstagramPaused(db)) {
      ctx.print('Instagram publishing is not paused.');
      return false;
    }
    const reason = getAppState(db, 'instagram_paused_reason');
    setAppState(db, 'instagram_paused', 'false');
    deleteAppState(db, 'instagram_paused_reason');
    ctx.print(`✓ Instagram publishing resumed.${reason ? ` (Was paused because: ${reason})` : ''}`);
    return true;
  });
}
