import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { publishAttempts, videos } from '../../src/db/schema.js';
import { FacebookApiError } from '../../src/facebook/graph-client.js';
import { finishAttempt, startAttempt } from '../../src/publisher/attempts.js';
import { claimVideo, releaseVideo } from '../../src/publisher/lease.js';
import { videoRow } from '../fixtures/factories.js';

describe('lease and attempt log', () => {
  let h: DbHandle;
  const NOW = new Date('2026-09-27T06:00:00.000Z');
  beforeEach(() => {
    h = openDatabase(':memory:');
  });
  afterEach(() => {
    h.close();
  });
  const insert = (over = {}) =>
    h.db
      .insert(videos)
      .values(videoRow({ state: 'READY', ...over }))
      .returning()
      .get();

  it('only one owner can claim a video until release or expiry', () => {
    const v = insert();
    expect(claimVideo(h.db, v.id, 'A', NOW, ['READY'])).toBe(true);
    expect(claimVideo(h.db, v.id, 'B', NOW, ['READY'])).toBe(false);
    expect(claimVideo(h.db, v.id, 'A', NOW, ['READY'])).toBe(true); // re-entrant
    const later = new Date(NOW.getTime() + 31 * 60_000);
    expect(claimVideo(h.db, v.id, 'B', later, ['READY'])).toBe(true); // A's lease expired
    releaseVideo(h.db, v.id, 'A'); // not the owner any more: no effect
    expect(h.db.select().from(videos).where(eq(videos.id, v.id)).get()?.lockedBy).toBe('B');
    releaseVideo(h.db, v.id, 'B');
    expect(h.db.select().from(videos).where(eq(videos.id, v.id)).get()?.lockedBy).toBeNull();
  });

  it('refuses to claim videos in the wrong state', () => {
    const v = insert({ state: 'PUBLISHED' });
    expect(claimVideo(h.db, v.id, 'A', NOW, ['READY', 'HELD'])).toBe(false);
  });

  it('records attempts with Facebook error details', () => {
    const v = insert();
    const a = startAttempt(h.db, v.id, 'START');
    finishAttempt(h.db, a, 'fatal', {
      error: new FacebookApiError('Bad token', { httpStatus: 400, code: 190, subcode: 463, fbtraceId: 'T1' }),
    });
    const b = startAttempt(h.db, v.id, 'TRANSFER');
    finishAttempt(h.db, b, 'ok', { message: '1200 bytes' });
    const rows = h.db.select().from(publishAttempts).all();
    expect(
      rows.map((r) => [r.step, r.outcome, r.fbErrorCode, r.fbErrorSubcode, r.httpStatus, r.fbTraceId, r.message]),
    ).toEqual([
      ['START', 'fatal', 190, 463, 400, 'T1', 'Bad token'],
      ['TRANSFER', 'ok', null, null, null, null, '1200 bytes'],
    ]);
    expect(rows.every((r) => r.endedAt)).toBe(true);
  });
});
