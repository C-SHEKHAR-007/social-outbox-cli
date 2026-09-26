import { createInterface } from 'node:readline/promises';
import { deleteAppState, getAppState, isPublishingPaused, setAppState } from '../../db/app-state.js';
import type { Db } from '../../db/client.js';
import type { Video } from '../../db/schema.js';
import type { PublishTarget } from '../../domain/states.js';
import { resolvePageCredentials } from '../../facebook/credentials.js';
import { GraphClient } from '../../facebook/graph-client.js';
import { TARGET_LABEL } from '../../media/publish-target.js';
import { leaseOwner } from '../../publisher/lease.js';
import {
  findPendingReconcile,
  resetForRetry,
  runPublish,
  type PlanItem,
  type PlannedDecision,
  type PublishReport,
} from '../../publisher/publish-service.js';
import { reconcileOne, type PublishOutcome, type PublisherDeps } from '../../publisher/publisher.js';
import { formatLocal } from '../../utils/dates.js';
import { UserError } from '../../utils/errors.js';
import type { AppContext } from '../context.js';

/** Injectable for tests. */
export interface PublishCommandDeps {
  client?: GraphClient;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  confirm?: (question: string) => Promise<boolean>;
  backoffMs?: number[];
}

export interface PublishCommandOptions {
  ids?: number[];
  limit?: string;
  target?: string;
  draft?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** Seconds to wait for Facebook processing; false (from --no-wait) = don't wait. */
  wait?: string | false;
}

function buildDeps(
  ctx: AppContext,
  db: Db,
  deps: PublishCommandDeps,
  pollSeconds: number,
): { publisher: PublisherDeps; pageLabel: string } {
  const creds = resolvePageCredentials(ctx.config, db, ctx.tokenStore());
  if (!creds) throw new UserError('No Facebook Page connected. Run: reel-cli facebook login');
  const client =
    deps.client ??
    new GraphClient({ version: ctx.config.facebook.graphApiVersion, appSecret: ctx.config.facebook.appSecret });
  return {
    pageLabel: creds.pageName ? `"${creds.pageName}"` : `Page ${creds.pageId}`,
    publisher: {
      db,
      client,
      page: { id: creds.pageId, token: creds.token },
      owner: leaseOwner(),
      now: deps.now ?? (() => new Date()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      logger: ctx.logger,
      maxRetries: ctx.config.publishing.maxRetries,
      backoffMs: deps.backoffMs,
      pollTimeoutMs: pollSeconds * 1000,
      pollIntervalMs: 5000,
    },
  };
}

export async function runPublishCommand(
  ctx: AppContext,
  opts: PublishCommandOptions = {},
  deps: PublishCommandDeps = {},
): Promise<{ report: PublishReport; code: number }> {
  const limit = opts.limit === undefined ? undefined : positiveInt(opts.limit, '--limit');
  const targets = parseTarget(opts.target);
  const pollSeconds = opts.wait === false ? 0 : opts.wait === undefined ? 120 : positiveInt(opts.wait, '--wait');
  const tz = ctx.config.publishing.timezone;

  return ctx.withDbAsync(async (db) => {
    const { publisher, pageLabel } = buildDeps(ctx, db, deps, pollSeconds);
    const runOpts = { config: ctx.config, ids: opts.ids, limit, targets, draft: opts.draft };

    // Always show the plan first (no network, no writes).
    const preview = await runPublish(publisher, { ...runOpts, dryRun: true });
    renderPlan(ctx, preview, pageLabel, tz, !!opts.dryRun);
    const toSubmit = preview.items.filter((i) => submits(i.decision));
    const limited = limit === undefined ? toSubmit.length : Math.min(limit, toSubmit.length);
    if (opts.dryRun) return { report: preview, code: 0 };
    if (!limited && !preview.pendingReconcile.length) {
      ctx.print('Nothing to publish.');
      return { report: preview, code: 0 };
    }

    if (limited && !opts.yes) {
      const what = opts.draft ? 'upload as private draft(s)' : 'publish/schedule';
      const question = `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} ${limited} video(s) on ${pageLabel}? [y/N] `;
      const ok = await (deps.confirm ?? promptYesNo)(question);
      if (!ok) {
        ctx.print('Cancelled. Nothing was sent.');
        return { report: preview, code: 0 };
      }
    }

    ctx.print();
    let n = 0;
    const report = await runPublish(publisher, runOpts, (e) => {
      if (e.type === 'reconciled') ctx.print(`↻ #${e.video.id} ${e.video.filename}: ${describeOutcome(e.outcome)}`);
      if (e.type === 'start') {
        n += 1;
        ctx.print(`[${n}/${limited}] #${e.video.id} ${e.video.filename} (${TARGET_LABEL[e.video.publishTarget]}) …`);
      }
      if (e.type === 'done') ctx.print(`      ${describeOutcome(e.outcome)}`);
    });
    const code = renderSummary(ctx, report);
    ctx.logger.info(
      { op: 'publish', draft: !!opts.draft, submitted: n, stopped: report.stopped?.reason },
      'publish run complete',
    );
    return { report, code };
  });
}

export async function runReconcileCommand(
  ctx: AppContext,
  opts: { ids?: number[] } = {},
  deps: PublishCommandDeps = {},
): Promise<PublishOutcome[]> {
  return ctx.withDbAsync(async (db) => {
    const { publisher } = buildDeps(ctx, db, deps, 0);
    const pending = findPendingReconcile(db, publisher.now(), { ids: opts.ids });
    if (!pending.length) {
      ctx.print('Nothing to reconcile: no videos are waiting on Facebook.');
      return [];
    }
    const results: PublishOutcome[] = [];
    for (const v of pending) {
      const outcome = await reconcileOne(publisher, v.id);
      results.push(outcome);
      ctx.print(`#${v.id} ${v.filename} (${v.state}): ${describeOutcome(outcome)}`);
      if (outcome.stop === 'fatal' || outcome.stop === 'pause') break;
    }
    return results;
  });
}

export function runRetry(ctx: AppContext, opts: { ids?: number[]; drafts?: boolean; dryRun?: boolean } = {}): Video[] {
  return ctx.withDb((db) => {
    const rows = resetForRetry(db, { ids: opts.ids, includeDrafts: opts.drafts, dryRun: opts.dryRun });
    if (!rows.length) {
      ctx.print(
        opts.drafts
          ? 'No failed or draft videos to retry.'
          : 'No failed videos to retry. (Use --drafts to reset drafts too.)',
      );
      return rows;
    }
    ctx.print(`${opts.dryRun ? 'Would reset' : 'Reset'} ${rows.length} video(s) for publishing:`);
    for (const v of rows) ctx.print(`  #${v.id} ${v.filename} (${v.state}${v.lastError ? `: ${v.lastError}` : ''})`);
    if (rows.some((v) => v.state === 'DRAFT')) {
      ctx.print(
        'Note: the draft copies stay on Facebook (Meta Business Suite > Content); delete them there if you like.',
      );
    }
    if (!opts.dryRun) ctx.print('Next: reel-cli publish');
    return rows;
  });
}

export function runResume(ctx: AppContext): boolean {
  return ctx.withDb((db) => {
    if (!isPublishingPaused(db)) {
      ctx.print('Publishing is not paused.');
      return false;
    }
    const reason = getAppState(db, 'paused_reason');
    setAppState(db, 'publishing_paused', 'false');
    deleteAppState(db, 'paused_reason');
    ctx.print(`✓ Publishing resumed.${reason ? ` (Was paused because: ${reason})` : ''}`);
    ctx.logger.info({ op: 'resume', reason }, 'publishing resumed');
    return true;
  });
}

// ---------- rendering ----------

function submits(d: PlannedDecision): boolean {
  return d.kind === 'now' || d.kind === 'schedule' || d.kind === 'draft';
}

function renderPlan(ctx: AppContext, r: PublishReport, pageLabel: string, tz: string, dryRun: boolean): void {
  const p = ctx.print;
  const line = (i: PlanItem, extra = '') => `  #${i.video.id}  ${i.video.filename}  ${i.video.publishTarget}${extra}`;
  const groups: Array<[string, PlanItem[], (i: PlanItem) => string]> = [
    ['Publish now:', r.items.filter((i) => i.decision.kind === 'now'), (i) => line(i)],
    [
      'Schedule on Facebook:',
      r.items.filter((i) => i.decision.kind === 'schedule'),
      (i) => line(i, `  ${i.decision.kind === 'schedule' ? formatLocal(i.decision.at.toISOString(), tz) : ''}`),
    ],
    ['Upload as private draft:', r.items.filter((i) => i.decision.kind === 'draft'), (i) => line(i)],
    [
      'Hold (not sent yet):',
      r.items.filter((i) => i.decision.kind === 'hold'),
      (i) =>
        line(
          i,
          i.decision.kind === 'hold'
            ? `  ${i.decision.reason}${i.decision.until ? ` (until ${formatLocal(i.decision.until.toISOString(), tz)})` : ''}`
            : '',
        ),
    ],
    [
      'Not publishable:',
      r.items.filter((i) => i.decision.kind === 'invalid' || i.decision.kind === 'skip'),
      (i) =>
        line(
          i,
          `  ${i.decision.kind === 'invalid' ? i.decision.reasons.join('; ') : i.decision.kind === 'skip' ? i.decision.reason : ''}`,
        ),
    ],
  ];
  p(`Publish plan for ${pageLabel}${dryRun ? ' (dry run: nothing will be sent)' : ''}`);
  if (r.pendingReconcile.length) {
    p();
    p(`Check with Facebook first: ${r.pendingReconcile.length} video(s) waiting (FINISHING/PROCESSING/SCHEDULED)`);
  }
  let any = false;
  for (const [title, items, fmt] of groups) {
    if (!items.length) continue;
    any = true;
    p();
    p(`${title} ${items.length}`);
    for (const i of items.slice(0, 20)) p(fmt(i));
    if (items.length > 20) p(`  … and ${items.length - 20} more`);
  }
  if (!any && !r.pendingReconcile.length)
    p('\nNo videos are ready. Set an action (POST_NOW/SCHEDULE) via export/import or `reel-cli schedule`.');
  p();
}

function describeOutcome(o: PublishOutcome): string {
  switch (o.result) {
    case 'published':
      return '✓ published';
    case 'scheduled':
      return '✓ scheduled on Facebook';
    case 'draft':
      return '✓ uploaded as private draft';
    case 'processing':
      return '… uploaded, still processing on Facebook (run `reel-cli reconcile` later)';
    case 'uploading':
      return '↺ upload not finished; will resume on next publish';
    case 'held':
      return `⏸ held: ${o.message ?? ''}`;
    case 'unknown':
      return `? ${o.message ?? 'outcome unknown'}`;
    case 'failed':
      return `✗ failed: ${o.message ?? ''}`;
    default:
      return `– skipped: ${o.message ?? ''}`;
  }
}

function renderSummary(ctx: AppContext, r: PublishReport): number {
  const outcomes = [...r.reconciled, ...r.items.flatMap((i) => (i.outcome ? [i.outcome] : []))];
  const count = (res: PublishOutcome['result']) => outcomes.filter((o) => o.result === res).length;
  ctx.print();
  ctx.print(
    `Done: ${count('published')} published, ${count('scheduled')} scheduled, ${count('draft')} drafts, ` +
      `${count('processing')} processing, ${count('failed')} failed, ${count('unknown')} unknown.`,
  );
  if (r.rateLimited.length)
    ctx.print(`⏸ Facebook rate limit hit for ${r.rateLimited.join(', ')}; held videos retry after an hour.`);
  if (r.stopped?.reason === 'fatal')
    ctx.print(`✗ Stopped: ${r.stopped.message}\n  Check the login with \`reel-cli facebook verify\`.`);
  if (r.stopped?.reason === 'pause') {
    ctx.print(
      `✗ Publishing PAUSED: ${r.stopped.message}\n  Review the Page in Meta Business Suite, then run \`reel-cli resume\`.`,
    );
  }
  if (count('unknown')) ctx.print('Some results are unknown; run `reel-cli reconcile` (it never re-posts).');
  return r.stopped || count('failed') || count('unknown') ? 1 : 0;
}

// ---------- input helpers ----------

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new UserError('Not a terminal: add --yes to confirm publishing.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function parseTarget(input: string | undefined): PublishTarget[] | undefined {
  if (!input || input.toLowerCase() === 'all') return undefined;
  const t = input.toUpperCase();
  if (t === 'REEL' || t === 'VIDEO') return [t];
  throw new UserError(`Invalid --target: ${input} (use reel, video or all)`);
}

function positiveInt(input: string, flag: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`Invalid ${flag}: ${input}`);
  return n;
}
