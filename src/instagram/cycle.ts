import type { AppConfig } from '../config/env.js';
import { getAppState } from '../db/app-state.js';
import { lastPostSentAt, listPosts, postsFreeAt, postsSentSince } from '../db/platform-post-repository.js';
import type { PlatformPost, Video } from '../db/schema.js';
import { findVideoById } from '../db/video-repository.js';
import { isInstagramPaused } from './connect-service.js';
import {
  prepareInstagramPost,
  publishInstagramPost,
  reconcileInstagramPost,
  type InstagramDeps,
  type InstagramOutcome,
} from './publisher.js';

export type CycleAction = 'reconcile' | 'publish' | 'prepare' | 'wait';

export interface CycleItem {
  post: PlatformPost;
  video: Video | undefined;
  action: CycleAction;
  dueAt: Date;
  /** Why it waits, or what it waits for. */
  reason?: string;
  until?: Date;
  outcome?: InstagramOutcome;
}

export interface CycleReport {
  items: CycleItem[];
  paused?: string;
  stopped?: { reason: 'fatal' | 'pause'; message: string };
}

export interface CycleOptions {
  config: AppConfig;
  dryRun?: boolean;
  ids?: number[];
  /** Heavy work (re-encode + upload) per cycle, so a worker tick stays short. */
  maxPreparesPerCycle?: number;
}

const HOUR = 3_600_000;

/**
 * One Instagram pass. Instagram has no native scheduling, so posts are prepared (uploaded and
 * processed) up to INSTAGRAM_PREPARE_HOURS before their time and published by the cycle that runs at
 * or after that time. Order: settle lost publishes → publish what is due → prepare what is coming.
 */
export async function runInstagramCycle(
  deps: InstagramDeps,
  opts: CycleOptions,
  onEvent: (item: CycleItem) => void = () => undefined,
): Promise<CycleReport> {
  const { db } = deps;
  const report: CycleReport = { items: [] };
  if (isInstagramPaused(db)) {
    report.paused = getAppState(db, 'instagram_paused_reason') ?? 'paused';
    if (!opts.dryRun) return report;
  }

  const now = deps.now();
  const prepareMs = opts.config.instagram.prepareHours * HOUR;
  const posts = listPosts(db, 'instagram').filter(
    (p) => (!opts.ids || opts.ids.includes(p.videoId)) && (p.action === 'POST_NOW' || p.action === 'SCHEDULE'),
  );
  const dueOf = (p: PlatformPost) =>
    p.action === 'SCHEDULE' && p.scheduledAt ? new Date(p.scheduledAt) : new Date(p.createdAt);
  const item = (p: PlatformPost, action: CycleAction, extra: Partial<CycleItem> = {}): CycleItem => ({
    post: p,
    video: findVideoById(db, p.videoId),
    action,
    dueAt: dueOf(p),
    ...extra,
  });

  // 1. Publishes whose outcome is unknown.
  for (const p of posts.filter((x) => x.state === 'PUBLISHING')) report.items.push(item(p, 'reconcile'));

  // 2. Publish: prepared and due, within the daily limit and the gap between posts.
  let used = postsSentSince(db, 'instagram', now);
  let lastSent = lastPostSentAt(db, 'instagram')?.getTime() ?? 0;
  const gapMs = opts.config.publishing.minUploadGapSeconds * 1000;
  const uploaded = posts.filter((x) => x.state === 'UPLOADED').sort((a, b) => dueOf(a).getTime() - dueOf(b).getTime());
  for (const p of uploaded) {
    if (dueOf(p) > now) {
      report.items.push(item(p, 'wait', { reason: 'ready, publishes at its time', until: dueOf(p) }));
    } else if (used >= opts.config.instagram.dailyLimit) {
      report.items.push(
        item(p, 'wait', {
          reason: 'Instagram daily limit reached',
          until: postsFreeAt(db, 'instagram', now) ?? undefined,
        }),
      );
    } else if (lastSent + gapMs > now.getTime()) {
      report.items.push(
        item(p, 'wait', { reason: 'keeping the gap between posts', until: new Date(lastSent + gapMs) }),
      );
    } else {
      report.items.push(item(p, 'publish'));
      used += 1;
      lastSent = now.getTime();
    }
  }

  // 3. Prepare: due within the prepare window (POST_NOW immediately).
  let prepares = 0;
  const maxPrepares = opts.maxPreparesPerCycle ?? 3;
  const pending = posts
    .filter((x) => x.state === 'READY' || x.state === 'HELD' || x.state === 'UPLOADING')
    .filter((x) => x.state !== 'HELD' || !x.nextAttemptAt || Date.parse(x.nextAttemptAt) <= now.getTime())
    .filter((x) => x.state !== 'UPLOADING' || !x.lockExpiresAt || Date.parse(x.lockExpiresAt) < now.getTime())
    .sort((a, b) => dueOf(a).getTime() - dueOf(b).getTime());
  for (const p of pending) {
    const startAt = new Date(dueOf(p).getTime() - prepareMs);
    if (startAt > now) report.items.push(item(p, 'wait', { reason: 'prepared closer to its time', until: startAt }));
    else if (prepares >= maxPrepares)
      report.items.push(item(p, 'wait', { reason: 'next cycle (prepare limit per cycle)' }));
    else {
      report.items.push(item(p, 'prepare'));
      prepares += 1;
    }
  }

  if (opts.dryRun) return report;

  // Run the actions in order.
  for (const it of report.items) {
    if (it.action === 'wait') continue;
    if (report.stopped) break;
    const id = it.post.id;
    it.outcome =
      it.action === 'reconcile'
        ? await reconcileInstagramPost(deps, id)
        : it.action === 'publish'
          ? await publishInstagramPost(deps, id)
          : await prepareInstagramPost(deps, id);
    onEvent(it);
    if (it.outcome.stop === 'fatal' || it.outcome.stop === 'pause') {
      report.stopped = { reason: it.outcome.stop, message: it.outcome.message ?? '' };
    }
  }
  return report;
}
