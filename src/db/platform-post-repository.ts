import { and, count, eq, gt, max, min, sql } from 'drizzle-orm';
import type { Platform, PostState } from '../domain/platforms.js';
import { nowIso, toIso } from '../utils/time.js';
import type { Db } from './client.js';
import { platformPosts, type NewPlatformPost, type PlatformPost } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function findPost(db: Db, videoId: number, platform: Platform): PlatformPost | undefined {
  return db
    .select()
    .from(platformPosts)
    .where(and(eq(platformPosts.videoId, videoId), eq(platformPosts.platform, platform)))
    .get();
}

export function findPostById(db: Db, id: number): PlatformPost | undefined {
  return db.select().from(platformPosts).where(eq(platformPosts.id, id)).get();
}

export function listPosts(db: Db, platform: Platform): PlatformPost[] {
  return db.select().from(platformPosts).where(eq(platformPosts.platform, platform)).all();
}

export function insertPost(db: Db, values: NewPlatformPost): PlatformPost {
  return db.insert(platformPosts).values(values).returning().get();
}

/** Every update bumps `version` (stale-CSV detection, optimistic concurrency). */
export function updatePost(db: Db, id: number, values: Partial<NewPlatformPost>): void {
  db.update(platformPosts)
    .set({ ...values, version: sql`${platformPosts.version} + 1`, updatedAt: nowIso() })
    .where(eq(platformPosts.id, id))
    .run();
}

export function updatePostIfVersion(
  db: Db,
  id: number,
  expectedVersion: number,
  values: Partial<NewPlatformPost>,
): boolean {
  const res = db
    .update(platformPosts)
    .set({ ...values, version: sql`${platformPosts.version} + 1`, updatedAt: nowIso() })
    .where(and(eq(platformPosts.id, id), eq(platformPosts.version, expectedVersion)))
    .run();
  return res.changes === 1;
}

export function countPostsByState(db: Db, platform: Platform): Partial<Record<PostState, number>> {
  const out: Partial<Record<PostState, number>> = {};
  for (const r of db
    .select({ state: platformPosts.state, n: count() })
    .from(platformPosts)
    .where(eq(platformPosts.platform, platform))
    .groupBy(platformPosts.state)
    .all()) {
    out[r.state] = r.n;
  }
  return out;
}

/** Publish calls sent in the rolling 24h window (counted when sent, like the Facebook limit). */
export function postsSentSince(db: Db, platform: Platform, now: Date): number {
  const since = toIso(new Date(now.getTime() - DAY_MS));
  return (
    db
      .select({ n: count() })
      .from(platformPosts)
      .where(and(eq(platformPosts.platform, platform), gt(platformPosts.publishSentAt, since)))
      .get()?.n ?? 0
  );
}

export function postsFreeAt(db: Db, platform: Platform, now: Date): Date | null {
  const since = toIso(new Date(now.getTime() - DAY_MS));
  const oldest = db
    .select({ at: min(platformPosts.publishSentAt) })
    .from(platformPosts)
    .where(and(eq(platformPosts.platform, platform), gt(platformPosts.publishSentAt, since)))
    .get()?.at;
  return oldest ? new Date(Date.parse(oldest) + DAY_MS) : null;
}

export function lastPostSentAt(db: Db, platform: Platform): Date | null {
  const last = db
    .select({ at: max(platformPosts.publishSentAt) })
    .from(platformPosts)
    .where(eq(platformPosts.platform, platform))
    .get()?.at;
  return last ? new Date(last) : null;
}
