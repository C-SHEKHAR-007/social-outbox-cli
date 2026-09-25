import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { videos, type NewVideo } from '../../src/db/schema.js';
import { recheckVideos } from '../../src/media/recheck-service.js';
import { mediaInfo, videoRow } from '../fixtures/factories.js';

describe('recheckVideos', () => {
  let h: DbHandle;
  beforeEach(() => {
    h = openDatabase(':memory:');
  });
  afterEach(() => {
    h.close();
  });
  const insert = (d: number, over: Partial<NewVideo> = {}) => {
    return h.db
      .insert(videos)
      .values(videoRow({ durationS: d, mediaInfo: mediaInfo({ durationS: d }), specOk: false, ...over }))
      .returning()
      .get();
  };
  const get = (id: number) => h.db.select().from(videos).where(eq(videos.id, id)).get()!;

  it('moves long videos to VIDEO, respects manual pins and submitted rows, and is idempotent', () => {
    const short = insert(30);
    const long = insert(435);
    const pinned = insert(30, { publishTarget: 'VIDEO', targetSource: 'manual' });
    const live = insert(435, { state: 'SCHEDULED' });

    const s = recheckVideos(h.db, { reelMaxDurationS: 90 });
    expect(s.checked).toBe(3);
    expect(s.targetChanged.map((c) => [c.id, c.to])).toEqual([[long.id, 'VIDEO']]);
    expect(s.byTarget).toEqual({ REEL: { total: 1, specOk: 1 }, VIDEO: { total: 2, specOk: 2 } });
    expect(get(short.id)).toMatchObject({ publishTarget: 'REEL', specOk: true });
    expect(get(long.id)).toMatchObject({ publishTarget: 'VIDEO', specOk: true });
    expect(get(pinned.id).publishTarget).toBe('VIDEO');
    expect(get(live.id)).toMatchObject({ publishTarget: 'REEL', specOk: false }); // untouched

    expect(recheckVideos(h.db, { reelMaxDurationS: 90 }).updated).toBe(0);
  });

  it('moves videos back to REEL when the limit is raised; dry-run writes nothing', () => {
    const long = insert(435, { publishTarget: 'VIDEO', specOk: true });
    const dry = recheckVideos(h.db, { reelMaxDurationS: 900 }, { dryRun: true });
    expect(dry.targetChanged).toHaveLength(1);
    expect(get(long.id).publishTarget).toBe('VIDEO');
    recheckVideos(h.db, { reelMaxDurationS: 900 });
    expect(get(long.id).publishTarget).toBe('REEL');
  });
});
