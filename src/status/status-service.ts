import { and, asc, count, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { isPublishingPaused, getAppState } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import { videos } from '../db/schema.js';
import { VIDEO_STATES, type PublishTarget, type VideoState } from '../domain/states.js';
import { quotaUsed } from '../scheduling/quota.js';
import { toIso } from '../utils/time.js';

export interface StatusReport {
  total: number;
  byTarget: Record<PublishTarget, number>;
  byState: Record<VideoState, number>;
  quota: { used: number; limit: number };
  paused: { paused: boolean; reason: string | undefined };
  upcoming: Array<{ id: number; filename: string; state: VideoState; target: PublishTarget; scheduledAt: string }>;
  failed: Array<{ id: number; filename: string; error: string }>;
}

const UPCOMING_STATES: VideoState[] = ['READY', 'HELD', 'SCHEDULED'];

export function getStatusReport(db: Db, opts: { now: Date; quotaLimit: number; listLimit?: number }): StatusReport {
  const listLimit = opts.listLimit ?? 10;
  const byState = Object.fromEntries(VIDEO_STATES.map((s) => [s, 0])) as Record<VideoState, number>;
  for (const row of db.select({ state: videos.state, n: count() }).from(videos).groupBy(videos.state).all()) {
    byState[row.state] = row.n;
  }
  const total = Object.values(byState).reduce((a, b) => a + b, 0);
  const byTarget: Record<PublishTarget, number> = { REEL: 0, VIDEO: 0 };
  for (const row of db
    .select({ t: videos.publishTarget, n: count() })
    .from(videos)
    .groupBy(videos.publishTarget)
    .all()) {
    byTarget[row.t] = row.n;
  }

  const used = quotaUsed(db, opts.now);

  const upcoming = db
    .select({
      id: videos.id,
      filename: videos.filename,
      state: videos.state,
      target: videos.publishTarget,
      scheduledAt: videos.scheduledAt,
    })
    .from(videos)
    .where(
      and(
        inArray(videos.state, UPCOMING_STATES),
        isNotNull(videos.scheduledAt),
        gt(videos.scheduledAt, toIso(opts.now)),
      ),
    )
    .orderBy(asc(videos.scheduledAt))
    .limit(listLimit)
    .all()
    .map((r) => ({ ...r, scheduledAt: r.scheduledAt ?? '' }));

  const failed = db
    .select({ id: videos.id, filename: videos.filename, error: videos.lastError })
    .from(videos)
    .where(eq(videos.state, 'FAILED'))
    .orderBy(desc(videos.updatedAt))
    .limit(listLimit)
    .all()
    .map((r) => ({ ...r, error: r.error ?? 'unknown error' }));

  return {
    total,
    byTarget,
    byState,
    quota: { used, limit: opts.quotaLimit },
    paused: { paused: isPublishingPaused(db), reason: getAppState(db, 'paused_reason') },
    upcoming,
    failed,
  };
}
