import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/env.js';
import { setAppState } from '../../src/db/app-state.js';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { videos, type NewVideo } from '../../src/db/schema.js';
import { sha256File } from '../../src/scanner/file-identity.js';
import { validateVideos } from '../../src/validation/validate-service.js';
import { makeTempDir } from '../helpers.js';
import { statSync } from 'node:fs';
import { mediaInfo } from '../fixtures/factories.js';

const NOW = new Date('2026-09-26T06:00:00.000Z');
const HOUR = 3600_000;
const goodInfo = mediaInfo({ durationS: 10 });

describe('validateVideos', () => {
  let h: DbHandle;
  let dir: string;
  let cleanup: () => void;
  let seq = 0;
  const config = parseConfig({ FACEBOOK_PAGE_ID: '123', FACEBOOK_PAGE_ACCESS_TOKEN: 'x', QUOTA_PER_24H: '3' });

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    h = openDatabase(':memory:');
  });
  afterEach(() => {
    h.close();
    cleanup();
  });

  async function insert(over: Partial<NewVideo> = {}) {
    seq += 1;
    const path = join(dir, `reel${seq}.mp4`);
    writeFileSync(path, `content-${seq}`);
    const st = statSync(path);
    return h.db
      .insert(videos)
      .values({
        fileHash: await sha256File(path),
        filePath: path,
        filename: `reel${seq}.mp4`,
        fileSize: st.size,
        fileMtime: Math.trunc(st.mtimeMs),
        mediaInfo: goodInfo,
        specOk: true,
        specIssues: [],
        caption: 'A caption',
        hashtags: ['#reels'],
        action: 'POST_NOW',
        state: 'READY',
        ...over,
      })
      .returning()
      .get();
  }
  const run = (ids?: number[], cfg = config) => validateVideos(h.db, { config: cfg, now: NOW, ids });

  it('passes a complete READY video', async () => {
    await insert();
    const r = await run();
    expect(r.videos[0]).toMatchObject({ errors: [], warnings: [] });
    expect(r).toMatchObject({ valid: 1, invalid: 0 });
  });

  it('only validates READY/HELD rows by default', async () => {
    await insert({ state: 'NEW', action: null });
    await insert({ state: 'PUBLISHED' });
    await insert({ state: 'HELD' });
    expect((await run()).videos.map((v) => v.id)).toEqual([3]);
  });

  it('detects missing files and changed content', async () => {
    const gone = await insert({ filePath: join(dir, 'nope.mp4') });
    const changed = await insert();
    writeFileSync(changed.filePath, 'tampered content that is longer');
    const r = await run();
    expect(r.videos.find((v) => v.id === gone.id)?.errors[0]).toMatch(/file does not exist/);
    expect(r.videos.find((v) => v.id === changed.id)?.errors).toContain(
      'file content changed since scan (hash mismatch); rescan the folder',
    );
  });

  it('re-checks specs from stored media info (errors block, warnings do not)', async () => {
    await insert({ mediaInfo: { ...goodInfo, durationS: 2 } });
    await insert({ mediaInfo: { ...goodInfo, audio: null } });
    const r = await run();
    expect(r.videos[0]?.errors).toContain('spec: duration 2.0s < 3s');
    expect(r.videos[1]?.errors).toEqual([]);
    expect(r.videos[1]?.warnings).toContain('spec: no audio stream');
  });

  it('checks content and action', async () => {
    await insert({ caption: '  ', hashtags: [] });
    await insert({ action: null });
    await insert({ hashtags: ['#bad-tag'] });
    const [a, b, c] = (await run()).videos;
    expect(a?.errors).toContain('caption is empty');
    expect(a?.warnings).toContain('no hashtags');
    expect(b?.errors).toContain('no action set (POST_NOW or SCHEDULE)');
    expect(c?.errors).toContain('invalid hashtag(s): #bad-tag');
  });

  it('checks schedule windows', async () => {
    await insert({ action: 'SCHEDULE', scheduledAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() });
    await insert({ action: 'SCHEDULE', scheduledAt: new Date(NOW.getTime() + 2 * HOUR).toISOString() });
    await insert({ action: 'SCHEDULE', scheduledAt: new Date(NOW.getTime() + 40 * 24 * HOUR).toISOString() });
    await insert({ action: 'SCHEDULE', scheduledAt: null });
    const [soon, ok, far, none] = (await run()).videos;
    expect(soon?.errors).toContain('scheduled_at must be at least 10 minutes in the future');
    expect(ok?.errors).toEqual([]);
    expect(far?.errors).toEqual([]);
    expect(far?.warnings[0]).toMatch(/more than 29 days/);
    expect(none?.errors).toContain('scheduled_at is required for SCHEDULE');
  });

  it('flags explicitly requested rows in other states', async () => {
    const pub = await insert({ state: 'PUBLISHED' });
    const failed = await insert({ state: 'FAILED' });
    const skipped = await insert({ state: 'SKIPPED', action: 'SKIP' });
    const r = await run([pub.id, failed.id, skipped.id, 999]);
    expect(r.videos.map((v) => v.errors[0] ?? v.warnings[0])).toEqual([
      'already submitted to Facebook (state PUBLISHED)',
      'failed earlier; run `reel-cli retry` first',
      'skipped; will not be published',
      'Unknown id 999',
    ]);
    expect(r.invalid).toBe(3);
  });

  it('reports global problems: paused, missing Facebook config, quota', async () => {
    for (let i = 0; i < 4; i++) await insert();
    await insert({ state: 'PUBLISHED', finishSentAt: new Date(NOW.getTime() - HOUR).toISOString() });
    setAppState(h.db, 'publishing_paused', 'true');
    const r = await run(undefined, parseConfig({ QUOTA_PER_24H: '3' }));
    expect(r.global.errors[0]).toMatch(/publishing is paused/);
    expect(r.global.warnings).toEqual([
      expect.stringContaining('No Facebook Page connected'),
      '4 Reel(s) to submit but only 2 of 3 left in the 24h Reels quota; the rest will be held and submitted later',
    ]);
  });

  it('uses Page video rules for long videos: no 90s limit, 6-month schedule window, no Reels quota', async () => {
    const longInfo = { ...goodInfo, durationS: 420, video: { ...goodInfo.video!, codec: 'av1' } };
    for (let i = 0; i < 4; i++) {
      await insert({
        publishTarget: 'VIDEO',
        mediaInfo: longInfo,
        action: 'SCHEDULE',
        scheduledAt: new Date(NOW.getTime() + (40 + i) * 24 * HOUR).toISOString(),
      });
    }
    await insert({ mediaInfo: longInfo }); // still REEL → too long
    const r = await run();
    expect(r.videos[0]?.errors).toEqual([]);
    expect(r.videos[0]?.warnings).toEqual([
      'spec: video codec av1; H.264 recommended (re-encode for best compatibility)',
    ]);
    expect(r.videos[4]?.errors).toContain('spec: duration 420.0s > 90s (too long for a Reel)');
    expect(r.global.warnings).toEqual([]); // 4 videos > quota 3, but Page videos don't count
  });

  it('warns when too many reels are scheduled in one 24h window', async () => {
    for (let i = 1; i <= 4; i++)
      await insert({ action: 'SCHEDULE', scheduledAt: new Date(NOW.getTime() + i * HOUR).toISOString() });
    const r = await run(
      undefined,
      parseConfig({ FACEBOOK_PAGE_ID: '1', FACEBOOK_PAGE_ACCESS_TOKEN: 'x', QUOTA_PER_24H: '3' }),
    );
    expect(r.global.warnings.some((w) => w.startsWith('4 Reels scheduled within 24h'))).toBe(true);
  });
});
