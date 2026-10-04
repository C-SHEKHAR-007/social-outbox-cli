import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppState, isPublishingPaused, setAppState } from '../../src/db/app-state.js';
import { appliedMigrationCount, openDatabase, type DbHandle } from '../../src/db/client.js';
import { MIGRATION_COUNT } from '../helpers.js';
import { platformPosts, publishAttempts, videos, type NewVideo } from '../../src/db/schema.js';

const video = (over: Partial<NewVideo> = {}): NewVideo => ({
  fileHash: 'a'.repeat(64),
  filePath: '/videos/a.mp4',
  filename: 'a.mp4',
  fileSize: 1000,
  fileMtime: 1,
  ...over,
});

describe('database', () => {
  let h: DbHandle;
  beforeEach(() => {
    h = openDatabase(':memory:');
  });
  afterEach(() => {
    h.close();
  });

  it('applies migrations and uses sensible defaults', () => {
    expect(appliedMigrationCount(h.sqlite)).toBe(MIGRATION_COUNT);
    const row = h.db.insert(videos).values(video()).returning().get();
    expect(row.state).toBe('NEW');
    expect(row.version).toBe(1);
    expect(row.retryCount).toBe(0);
    expect(row.isAiGenerated).toBe(false);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('rejects a duplicate file_hash', () => {
    h.db.insert(videos).values(video()).run();
    expect(() =>
      h.db
        .insert(videos)
        .values(video({ filePath: '/other/a.mp4' }))
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('rejects two rows with the same fb_video_id but allows many NULLs', () => {
    h.db
      .insert(videos)
      .values(video({ fileHash: '1'.repeat(64) }))
      .run();
    h.db
      .insert(videos)
      .values(video({ fileHash: '2'.repeat(64) }))
      .run();
    h.db
      .insert(videos)
      .values(video({ fileHash: '3'.repeat(64), fbVideoId: '999' }))
      .run();
    expect(() =>
      h.db
        .insert(videos)
        .values(video({ fileHash: '4'.repeat(64), fbVideoId: '999' }))
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('round-trips JSON columns', () => {
    const row = h.db
      .insert(videos)
      .values(video({ hashtags: ['#a', '#b'], specIssues: [{ level: 'error', code: 'X', message: 'too short' }] }))
      .returning()
      .get();
    const read = h.db.select().from(videos).where(eq(videos.id, row.id)).get();
    expect(read?.hashtags).toEqual(['#a', '#b']);
    expect(read?.specIssues?.[0]?.message).toBe('too short');
  });

  it('enforces the publish_attempts foreign key', () => {
    expect(() => h.db.insert(publishAttempts).values({ videoId: 12345, step: 'START' }).run()).toThrow(/FOREIGN KEY/);
  });

  it('stores and updates app state', () => {
    expect(isPublishingPaused(h.db)).toBe(false);
    setAppState(h.db, 'publishing_paused', 'true');
    setAppState(h.db, 'paused_reason', 'error 368');
    expect(isPublishingPaused(h.db)).toBe(true);
    setAppState(h.db, 'publishing_paused', 'false');
    expect(isPublishingPaused(h.db)).toBe(false);
    expect(getAppState(h.db, 'paused_reason')).toBe('error 368');
  });

  it('platform_posts: one post per video per platform, attempts default to facebook', () => {
    const v = h.db.insert(videos).values(video()).returning().get();
    const post = h.db.insert(platformPosts).values({ videoId: v.id, platform: 'instagram' }).returning().get();
    expect(post).toMatchObject({ kind: 'REELS', state: 'NEW', version: 1, retryCount: 0 });
    expect(() => h.db.insert(platformPosts).values({ videoId: v.id, platform: 'instagram' }).run()).toThrow(/UNIQUE/);
    expect(() => h.db.insert(platformPosts).values({ videoId: 99999, platform: 'instagram' }).run()).toThrow(
      /FOREIGN KEY/,
    );
    const attempt = h.db.insert(publishAttempts).values({ videoId: v.id, step: 'START' }).returning().get();
    expect(attempt.platform).toBe('facebook');
  });
});
