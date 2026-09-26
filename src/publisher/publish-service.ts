import { and, inArray, lte, or } from 'drizzle-orm';
import type { AppConfig } from '../config/env.js';
import { isPublishingPaused } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import { videos, type Video } from '../db/schema.js';
import { updateVideo } from '../db/video-repository.js';
import type { PublishTarget, VideoState } from '../domain/states.js';
import { quotaFreesAt, quotaUsed } from '../scheduling/quota.js';
import { UserError } from '../utils/errors.js';
import { toIso } from '../utils/time.js';
import { validateVideo } from '../validation/validate-service.js';
import { decidePublish, type PublishDecision } from './decision.js';
import { publishOne, reconcileOne, type PublishOutcome, type PublisherDeps } from './publisher.js';

export interface PublishRunOptions {
  config: AppConfig;
  ids?: number[];
  limit?: number;
  targets?: PublishTarget[];
  draft?: boolean;
  dryRun?: boolean;
}

export type PlannedDecision = PublishDecision | { kind: 'invalid'; reasons: string[] };

export interface PlanItem {
  video: Video;
  decision: PlannedDecision;
  outcome?: PublishOutcome;
}

export interface PublishReport {
  reconciled: PublishOutcome[];
  pendingReconcile: Video[];
  items: PlanItem[];
  stopped?: { reason: 'fatal' | 'pause'; message: string };
  rateLimited: PublishTarget[];
}

export type PublishEvent =
  | { type: 'reconciled'; outcome: PublishOutcome; video: Video }
  | { type: 'start'; video: Video; decision: PlannedDecision }
  | { type: 'done'; video: Video; decision: PlannedDecision; outcome: PublishOutcome };

const CANDIDATE_STATES: VideoState[] = ['READY', 'HELD', 'UPLOADING'];
const DRAFT_STATES: VideoState[] = ['NEW', 'READY', 'HELD', 'UPLOADING'];

/**
 * One publish run: settle pending videos, then submit eligible ones in order (POST_NOW first,
 * then by scheduled time). With `dryRun`, nothing is sent and nothing is written.
 */
export async function runPublish(
  deps: PublisherDeps,
  opts: PublishRunOptions,
  onEvent: (e: PublishEvent) => void = () => undefined,
): Promise<PublishReport> {
  const { db } = deps;
  if (isPublishingPaused(db) && !opts.dryRun) {
    throw new UserError('Publishing is paused (Facebook error 368). Review the Page, then run `reel-cli resume`.');
  }
  if (opts.draft && !opts.ids?.length)
    throw new UserError('--draft needs --ids (drafts are for testing specific videos).');

  const report: PublishReport = { reconciled: [], pendingReconcile: [], items: [], rateLimited: [] };

  // 1. Settle anything whose outcome is pending (unless we are only drafting specific videos).
  report.pendingReconcile = findPendingReconcile(db, deps.now(), opts);
  if (!opts.dryRun) {
    for (const v of report.pendingReconcile) {
      const outcome = await reconcileOne(deps, v.id);
      report.reconciled.push(outcome);
      onEvent({ type: 'reconciled', outcome, video: v });
      if (outcome.stop === 'fatal' || outcome.stop === 'pause') {
        report.stopped = { reason: outcome.stop, message: outcome.message ?? '' };
        return report;
      }
    }
  }

  // 2. Plan and submit.
  let submitted = 0;
  for (const video of findCandidates(db, deps.now(), opts)) {
    const decision = await plan(db, video, deps.now(), opts);
    const item: PlanItem = { video, decision };
    report.items.push(item);
    const submits = decision.kind === 'now' || decision.kind === 'schedule' || decision.kind === 'draft';
    if (submits && report.rateLimited.includes(video.publishTarget)) {
      item.decision = { kind: 'hold', reason: 'rate limited earlier in this run', until: null };
      continue;
    }
    if (opts.dryRun || !submits) {
      if (!opts.dryRun && decision.kind === 'hold') {
        updateVideo(db, video.id, {
          state: video.state === 'UPLOADING' ? 'UPLOADING' : 'HELD',
          nextAttemptAt: decision.until ? toIso(decision.until) : null,
        });
      }
      continue;
    }
    if (opts.limit !== undefined && submitted >= opts.limit) {
      item.decision = { kind: 'skip', reason: `--limit ${opts.limit} reached` };
      continue;
    }
    submitted += 1;
    onEvent({ type: 'start', video, decision });
    const outcome = await publishOne(deps, video.id, decision);
    item.outcome = outcome;
    onEvent({ type: 'done', video, decision, outcome });
    if (outcome.stop === 'fatal' || outcome.stop === 'pause') {
      report.stopped = { reason: outcome.stop, message: outcome.message ?? '' };
      break;
    }
    if (outcome.stop === 'rate_limit') report.rateLimited.push(video.publishTarget);
  }
  return report;
}

async function plan(db: Db, video: Video, now: Date, opts: PublishRunOptions): Promise<PlannedDecision> {
  if (video.state !== 'UPLOADING') {
    const check = await validateVideo(video, { config: opts.config, now, facebookConnected: true });
    const errors = opts.draft
      ? check.errors.filter((e) => !e.startsWith('no action set') && !e.startsWith('scheduled_at'))
      : check.errors;
    if (errors.length) return { kind: 'invalid', reasons: errors };
  }
  const used = quotaUsed(db, now);
  return decidePublish(video, {
    now,
    draft: opts.draft,
    reelQuotaLeft: opts.config.publishing.quotaPer24h - used,
    reelQuotaFreesAt: quotaFreesAt(db, now),
  });
}

function findCandidates(db: Db, now: Date, opts: PublishRunOptions): Video[] {
  const nowIso = toIso(now);
  const rows = db
    .select()
    .from(videos)
    .where(inArray(videos.state, opts.draft ? DRAFT_STATES : CANDIDATE_STATES))
    .all()
    .filter((v) => (!opts.ids || opts.ids.includes(v.id)) && (!opts.targets || opts.targets.includes(v.publishTarget)))
    .filter((v) => opts.draft || v.action === 'POST_NOW' || v.action === 'SCHEDULE')
    .filter((v) => v.state !== 'HELD' || !v.nextAttemptAt || v.nextAttemptAt <= nowIso)
    .filter((v) => v.state !== 'UPLOADING' || !v.lockExpiresAt || v.lockExpiresAt < nowIso);
  const rank = (v: Video) => (v.action === 'POST_NOW' ? 0 : 1);
  return rows.sort(
    (a, b) => rank(a) - rank(b) || (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '') || a.id - b.id,
  );
}

/** Videos whose Facebook outcome must be (re)checked. */
export function findPendingReconcile(
  db: Db,
  now: Date,
  opts: Pick<PublishRunOptions, 'ids' | 'targets'> = {},
): Video[] {
  return db
    .select()
    .from(videos)
    .where(
      or(
        inArray(videos.state, ['FINISHING', 'PROCESSING']),
        and(inArray(videos.state, ['SCHEDULED']), lte(videos.scheduledAt, toIso(now))),
      ),
    )
    .all()
    .filter((v) => (!opts.ids || opts.ids.includes(v.id)) && (!opts.targets || opts.targets.includes(v.publishTarget)));
}

/** FAILED (and DRAFT) → READY so they can be published again. Returns the rows reset. */
export function resetForRetry(db: Db, opts: { ids?: number[]; includeDrafts?: boolean; dryRun?: boolean }): Video[] {
  const states: VideoState[] = opts.includeDrafts ? ['FAILED', 'DRAFT'] : ['FAILED'];
  const rows = db
    .select()
    .from(videos)
    .where(inArray(videos.state, states))
    .all()
    .filter((v) => !opts.ids || opts.ids.includes(v.id));
  if (!opts.dryRun) {
    for (const v of rows) {
      updateVideo(db, v.id, {
        state: v.action ? 'READY' : 'NEW',
        fbVideoId: null,
        fbPostId: null,
        fbPermalink: null,
        bytesUploaded: 0,
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
        lastErrorCode: null,
        lockedBy: null,
        lockExpiresAt: null,
      });
    }
  }
  return rows;
}
