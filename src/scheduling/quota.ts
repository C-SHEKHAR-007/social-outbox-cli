import { and, count, eq, gt, max, min } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { videos } from '../db/schema.js';
import { toIso } from '../utils/time.js';
import { DAY_MS } from './windows.js';

/**
 * Reels counted against Meta's rolling 24h Reels API limit (Page videos are not counted).
 * Counted at FINISH time until
 * docs/plan.md §2.7 Q1 is answered (conservative).
 */
export function quotaUsed(db: Db, now: Date): number {
  const since = toIso(new Date(now.getTime() - DAY_MS));
  return (
    db
      .select({ n: count() })
      .from(videos)
      .where(and(eq(videos.publishTarget, 'REEL'), gt(videos.finishSentAt, since)))
      .get()?.n ?? 0
  );
}

/** When the oldest Reel counted in the current window leaves it (i.e. one more slot frees up). */
export function quotaFreesAt(db: Db, now: Date): Date | null {
  const since = toIso(new Date(now.getTime() - DAY_MS));
  const oldest = db
    .select({ at: min(videos.finishSentAt) })
    .from(videos)
    .where(and(eq(videos.publishTarget, 'REEL'), gt(videos.finishSentAt, since)))
    .get()?.at;
  return oldest ? new Date(Date.parse(oldest) + DAY_MS) : null;
}

/** Uploads of any kind (Reels, Page videos, drafts) sent to Facebook in the rolling 24h window. */
export function uploadsUsed(db: Db, now: Date): number {
  const since = toIso(new Date(now.getTime() - DAY_MS));
  return db.select({ n: count() }).from(videos).where(gt(videos.finishSentAt, since)).get()?.n ?? 0;
}

/** When the oldest upload counted in the current window leaves it. */
export function uploadsFreeAt(db: Db, now: Date): Date | null {
  const since = toIso(new Date(now.getTime() - DAY_MS));
  const oldest = db
    .select({ at: min(videos.finishSentAt) })
    .from(videos)
    .where(gt(videos.finishSentAt, since))
    .get()?.at;
  return oldest ? new Date(Date.parse(oldest) + DAY_MS) : null;
}

/** The most recent upload (finish sent), used to keep a gap between uploads across runs. */
export function lastUploadAt(db: Db): Date | null {
  const last = db
    .select({ at: max(videos.finishSentAt) })
    .from(videos)
    .get()?.at;
  return last ? new Date(last) : null;
}
