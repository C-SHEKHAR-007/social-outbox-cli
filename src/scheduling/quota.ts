import { and, count, eq, gt } from 'drizzle-orm';
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
