import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { platformPosts } from '../db/schema.js';
import type { PostState } from '../domain/platforms.js';
import { toIso } from '../utils/time.js';

export const POST_LEASE_TTL_MS = 30 * 60 * 1000;

/** Atomic claim of one platform post (same rules as the Facebook lease). */
export function claimPost(
  db: Db,
  id: number,
  owner: string,
  now: Date,
  states: readonly PostState[],
  ttlMs = POST_LEASE_TTL_MS,
): boolean {
  const res = db
    .update(platformPosts)
    .set({ lockedBy: owner, lockExpiresAt: toIso(new Date(now.getTime() + ttlMs)) })
    .where(
      and(
        eq(platformPosts.id, id),
        inArray(platformPosts.state, [...states]),
        or(
          isNull(platformPosts.lockedBy),
          eq(platformPosts.lockedBy, owner),
          lt(platformPosts.lockExpiresAt, toIso(now)),
        ),
      ),
    )
    .run();
  return res.changes === 1;
}

export function releasePost(db: Db, id: number, owner: string): void {
  db.update(platformPosts)
    .set({ lockedBy: null, lockExpiresAt: null })
    .where(and(eq(platformPosts.id, id), eq(platformPosts.lockedBy, owner)))
    .run();
}
