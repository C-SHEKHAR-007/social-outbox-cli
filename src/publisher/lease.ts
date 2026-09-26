import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { videos } from '../db/schema.js';
import type { VideoState } from '../domain/states.js';
import { toIso } from '../utils/time.js';

export const LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * Atomically claims a video for publishing. Succeeds only if it is in one of `states` and not
 * leased by someone else (or that lease has expired). A crashed run's lease simply times out.
 */
export function claimVideo(
  db: Db,
  id: number,
  owner: string,
  now: Date,
  states: readonly VideoState[],
  ttlMs = LEASE_TTL_MS,
): boolean {
  const res = db
    .update(videos)
    .set({ lockedBy: owner, lockExpiresAt: toIso(new Date(now.getTime() + ttlMs)) })
    .where(
      and(
        eq(videos.id, id),
        inArray(videos.state, [...states]),
        or(isNull(videos.lockedBy), eq(videos.lockedBy, owner), lt(videos.lockExpiresAt, toIso(now))),
      ),
    )
    .run();
  return res.changes === 1;
}

export function releaseVideo(db: Db, id: number, owner: string): void {
  db.update(videos)
    .set({ lockedBy: null, lockExpiresAt: null })
    .where(and(eq(videos.id, id), eq(videos.lockedBy, owner)))
    .run();
}

/** Unique-enough lease owner for this process. */
export function leaseOwner(): string {
  return `${process.pid}@${Math.random().toString(36).slice(2, 8)}`;
}
