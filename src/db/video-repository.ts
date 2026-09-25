import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { videos, type NewVideo, type Video } from './schema.js';
import { nowIso } from '../utils/time.js';

export function findVideoByHash(db: Db, fileHash: string): Video | undefined {
  return db.select().from(videos).where(eq(videos.fileHash, fileHash)).get();
}

export function findVideosByPath(db: Db, filePath: string): Video[] {
  return db.select().from(videos).where(eq(videos.filePath, filePath)).all();
}

export function insertVideo(db: Db, values: NewVideo): Video {
  return db.insert(videos).values(values).returning().get();
}

/** Every update bumps `version` so stale CSV edits can be detected. */
export function updateVideo(db: Db, id: number, values: Partial<NewVideo>): void {
  db.update(videos)
    .set({ ...values, version: sql`${videos.version} + 1`, updatedAt: nowIso() })
    .where(eq(videos.id, id))
    .run();
}

export function listVideosUnder(db: Db, dirPrefix: string): Video[] {
  const escaped = dirPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return db
    .select()
    .from(videos)
    .where(sql`${videos.filePath} LIKE ${`${escaped}%`} ESCAPE '\\'`)
    .all();
}

export function findVideoById(db: Db, id: number): Video | undefined {
  return db.select().from(videos).where(eq(videos.id, id)).get();
}

export function listVideos(db: Db, opts: { includePublished?: boolean } = {}): Video[] {
  const q = db.select().from(videos);
  return (opts.includePublished ? q : q.where(ne(videos.state, 'PUBLISHED'))).orderBy(asc(videos.id)).all();
}

/** Optimistic-concurrency update: applies only if the row still has `expectedVersion`. */
export function updateVideoIfVersion(db: Db, id: number, expectedVersion: number, values: Partial<NewVideo>): boolean {
  const result = db
    .update(videos)
    .set({ ...values, version: sql`${videos.version} + 1`, updatedAt: nowIso() })
    .where(and(eq(videos.id, id), eq(videos.version, expectedVersion)))
    .run();
  return result.changes === 1;
}
