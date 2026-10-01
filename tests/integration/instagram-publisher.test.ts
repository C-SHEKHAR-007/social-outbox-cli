import { randomBytes, createHash } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/env.js';
import { getAppState } from '../../src/db/app-state.js';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { platformPosts, publishAttempts, videos, type NewPlatformPost, type NewVideo } from '../../src/db/schema.js';
import { GraphClient } from '../../src/facebook/graph-client.js';
import { runInstagramCycle } from '../../src/instagram/cycle.js';
import {
  prepareInstagramPost,
  publishInstagramPost,
  reconcileInstagramPost,
  type InstagramDeps,
} from '../../src/instagram/publisher.js';
import { mediaInfo } from '../fixtures/factories.js';
import { graphError } from '../fixtures/fake-graph.js';
import { fakeInstagram, IG_ID } from '../fixtures/fake-instagram.js';
import { makeTempDir } from '../helpers.js';

const NOW = new Date('2026-10-05T06:00:00.000Z');
const H = 3_600_000;

describe('Instagram publisher', () => {
  let h: DbHandle;
  let dir: string;
  let cleanup: () => void;
  let clock: number;
  let ig: ReturnType<typeof fakeInstagram>;
  let seq = 0;
  const config = (env: Record<string, string> = {}) => parseConfig({ MIN_UPLOAD_GAP_SECONDS: '120', ...env });

  const deps = (over: Partial<InstagramDeps> = {}): InstagramDeps => ({
    db: h.db,
    client: new GraphClient({ version: 'v26.0', fetch: ig.fetch }),
    igUserId: IG_ID,
    token: 'PAGE-TOKEN',
    owner: 'test',
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    maxRetries: 3,
    backoffMs: [1_000],
    normalizedDir: join(dir, 'normalized'),
    processingWaitMs: 60_000,
    pollIntervalMs: 5_000,
    ...over,
  });

  function video(over: Partial<NewVideo> = {}) {
    seq += 1;
    const path = join(dir, `Video_${seq}.mp4`);
    const bytes = randomBytes(800);
    writeFileSync(path, bytes);
    return h.db
      .insert(videos)
      .values({
        fileHash: createHash('sha256').update(bytes).digest('hex'),
        filePath: path,
        filename: `Video_${seq}.mp4`,
        fileSize: statSync(path).size,
        fileMtime: Math.trunc(statSync(path).mtimeMs),
        durationS: 60,
        mediaInfo: mediaInfo({ durationS: 60 }),
        specOk: true,
        caption: `Hook ${seq}`,
        hashtags: ['#cdrama', `#tag${seq}`],
        state: 'SCHEDULED', // its Facebook life is separate
        ...over,
      })
      .returning()
      .get();
  }
  const post = (videoId: number, over: Partial<NewPlatformPost> = {}) =>
    h.db
      .insert(platformPosts)
      .values({
        videoId,
        platform: 'instagram',
        action: 'SCHEDULE',
        scheduledAt: new Date(clock + 30 * 60_000).toISOString(),
        state: 'READY',
        ...over,
      })
      .returning()
      .get();
  const row = (id: number) => h.db.select().from(platformPosts).where(eq(platformPosts.id, id)).get()!;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    h = openDatabase(':memory:');
    clock = NOW.getTime();
    ig = fakeInstagram();
  });
  afterEach(() => {
    h.close();
    cleanup();
  });

  it('prepares: container (id saved first) → upload → processing → UPLOADED, with caption + hashtags', async () => {
    const v = video();
    const p = post(v.id);
    const out = await prepareInstagramPost(deps(), p.id);
    expect(out.result).toBe('prepared');
    expect(row(p.id)).toMatchObject({ state: 'UPLOADED', containerId: 'C1', uploadPath: v.filePath, lockedBy: null });
    expect(ig.containers.get('C1')).toMatchObject({ caption: 'Hook 1\n\n#cdrama #tag1', bytes: 800, fileSize: 800 });
    expect(ig.publishes()).toBe(0); // nothing public yet
    const steps = h.db
      .select()
      .from(publishAttempts)
      .all()
      .map((a) => `${a.platform}:${a.step}:${a.outcome}`);
    expect(steps).toEqual([
      'instagram:START:ok',
      'instagram:TRANSFER:ok',
      'instagram:VERIFY:ok',
      'instagram:VERIFY:ok',
    ]);
  });

  it('publishes an UPLOADED post: media id, permalink, publish time', async () => {
    const p = post(video().id);
    await prepareInstagramPost(deps(), p.id);
    const out = await publishInstagramPost(deps(), p.id);
    expect(out).toMatchObject({ result: 'published', message: 'https://www.instagram.com/reel/M2/' });
    expect(row(p.id)).toMatchObject({
      state: 'PUBLISHED',
      mediaId: 'M2',
      permalink: 'https://www.instagram.com/reel/M2/',
      publishSentAt: new Date(clock).toISOString(),
    });
  });

  it('a lost publish response is reconciled from the container, never re-sent', async () => {
    const p = post(video().id);
    await prepareInstagramPost(deps(), p.id);
    ig.flags.publishAppliedButNetworkDrop = true;
    expect((await publishInstagramPost(deps(), p.id)).result).toBe('unknown');
    expect(row(p.id).state).toBe('PUBLISHING');
    expect((await publishInstagramPost(deps(), p.id)).result).toBe('skipped'); // not UPLOADED any more
    expect((await reconcileInstagramPost(deps(), p.id)).result).toBe('published');
    expect(row(p.id)).toMatchObject({
      state: 'PUBLISHED',
      mediaId: 'M2',
      permalink: 'https://www.instagram.com/reel/M2/',
    });
    expect(ig.publishes()).toBe(1);
  });

  it('a publish that never reached Instagram goes back to UPLOADED and is published once later', async () => {
    const p = post(video().id);
    await prepareInstagramPost(deps(), p.id);
    ig.fail.publish.push('network-error');
    expect((await publishInstagramPost(deps(), p.id)).result).toBe('unknown');
    expect((await reconcileInstagramPost(deps(), p.id)).result).toBe('prepared');
    expect(row(p.id).state).toBe('UPLOADED');
    expect((await publishInstagramPost(deps(), p.id)).result).toBe('published');
    expect(ig.media).toHaveLength(1);
  });

  it('retries transient publish errors; an expired container is re-uploaded', async () => {
    const p = post(video().id);
    await prepareInstagramPost(deps(), p.id);
    ig.fail.publish.push(graphError(2, 'Service temporarily unavailable', 503));
    expect((await publishInstagramPost(deps(), p.id)).result).toBe('published');

    const q = post(video().id);
    await prepareInstagramPost(deps(), q.id);
    ig.containers.get(row(q.id).containerId!)!.status = 'EXPIRED';
    expect((await publishInstagramPost(deps(), q.id)).result).toBe('requeued');
    expect(row(q.id)).toMatchObject({ state: 'READY', containerId: null });
    expect((await prepareInstagramPost(deps(), q.id)).result).toBe('prepared');
    expect(ig.creates()).toBe(3);
  });

  it('resumes an interrupted prepare without creating a second container', async () => {
    ig = fakeInstagram({ processingPolls: 5 });
    const p = post(video().id);
    const first = await prepareInstagramPost(deps({ processingWaitMs: 0 }), p.id);
    expect(first.result).toBe('processing');
    expect(row(p.id).state).toBe('UPLOADING');
    expect((await prepareInstagramPost(deps(), p.id)).result).toBe('prepared');
    expect(ig.creates()).toBe(1);
  });

  it('error 368 pauses Instagram only (Facebook pause flag untouched)', async () => {
    const p = post(video().id);
    await prepareInstagramPost(deps(), p.id);
    ig.fail.publish.push(graphError(368, '', 400, { error_subcode: 1390008 }));
    const out = await publishInstagramPost(deps(), p.id);
    expect(out.stop).toBe('pause');
    expect(getAppState(h.db, 'instagram_paused')).toBe('true');
    expect(getAppState(h.db, 'instagram_paused_reason')).toContain('posting too fast');
    expect(getAppState(h.db, 'publishing_paused')).toBeUndefined();
    expect(row(p.id).state).toBe('UPLOADED');
  });

  it('refuses videos Instagram cannot take and skips empty captions', async () => {
    const long = post(video({ durationS: 20 * 60, mediaInfo: mediaInfo({ durationS: 20 * 60 }) }).id);
    expect(await prepareInstagramPost(deps(), long.id)).toMatchObject({ result: 'failed' });
    expect(row(long.id).lastError).toContain('20.0 min > 15 min');
    const empty = post(video({ caption: '' }).id);
    expect(await prepareInstagramPost(deps(), empty.id)).toMatchObject({
      result: 'skipped',
      message: 'caption is empty',
    });
    expect(ig.creates()).toBe(0);
  });

  describe('cycle', () => {
    const plan = async (env: Record<string, string> = {}) =>
      (await runInstagramCycle(deps(), { config: config(env), dryRun: true })).items.map((i) => [
        i.post.id,
        i.action,
        i.reason ?? '',
      ]);

    it('prepares only within INSTAGRAM_PREPARE_HOURS, publishes only at/after the time', async () => {
      const soon = post(video().id, { scheduledAt: new Date(clock + 2 * H).toISOString() });
      const later = post(video().id, { scheduledAt: new Date(clock + 10 * H).toISOString() });
      const now = post(video().id, { action: 'POST_NOW', scheduledAt: null });
      expect(await plan()).toEqual([
        [now.id, 'prepare', ''],
        [soon.id, 'prepare', ''],
        [later.id, 'wait', 'prepared closer to its time'],
      ]);
      expect(ig.requests).toHaveLength(0); // dry run

      await runInstagramCycle(deps(), { config: config() });
      expect([row(now.id).state, row(soon.id).state, row(later.id).state]).toEqual(['UPLOADED', 'UPLOADED', 'READY']);

      // next cycle: POST_NOW publishes; the 2 h one waits for its time
      await runInstagramCycle(deps(), { config: config() });
      expect([row(now.id).state, row(soon.id).state]).toEqual(['PUBLISHED', 'UPLOADED']);
      clock += 2 * H;
      await runInstagramCycle(deps(), { config: config() });
      expect(row(soon.id).state).toBe('PUBLISHED');
    });

    it('respects the gap between posts and INSTAGRAM_DAILY_LIMIT', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) ids.push(post(video().id, { action: 'POST_NOW', scheduledAt: null }).id);
      await runInstagramCycle(deps(), { config: config({ INSTAGRAM_DAILY_LIMIT: '2' }) }); // prepares all 3
      await runInstagramCycle(deps(), { config: config({ INSTAGRAM_DAILY_LIMIT: '2' }) });
      expect(ids.map((i) => row(i).state)).toEqual(['PUBLISHED', 'UPLOADED', 'UPLOADED']); // gap: one per 120 s
      clock += 121_000;
      await runInstagramCycle(deps(), { config: config({ INSTAGRAM_DAILY_LIMIT: '2' }) });
      clock += 121_000;
      const last = await runInstagramCycle(deps(), { config: config({ INSTAGRAM_DAILY_LIMIT: '2' }) });
      expect(ids.map((i) => row(i).state)).toEqual(['PUBLISHED', 'PUBLISHED', 'UPLOADED']);
      expect(last.items.find((i) => i.post.id === ids[2])?.reason).toBe('Instagram daily limit reached');
    });

    it('does nothing while Instagram is paused', async () => {
      post(video().id, { action: 'POST_NOW', scheduledAt: null });
      h.db
        .insert((await import('../../src/db/schema.js')).appState)
        .values({ key: 'instagram_paused', value: 'true' })
        .run();
      const r = await runInstagramCycle(deps(), { config: config() });
      expect(r.paused).toBeTruthy();
      expect(ig.requests).toHaveLength(0);
    });

    it('never touches Facebook data on the videos table', async () => {
      const v = video();
      post(v.id, { action: 'POST_NOW', scheduledAt: null });
      const before = JSON.stringify(h.db.select().from(videos).all());
      await runInstagramCycle(deps(), { config: config() });
      await runInstagramCycle(deps(), { config: config() });
      expect(JSON.stringify(h.db.select().from(videos).all())).toBe(before);
      expect(
        h.db
          .select()
          .from(publishAttempts)
          .all()
          .every((a) => a.platform === 'instagram'),
      ).toBe(true);
    });
  });
});
