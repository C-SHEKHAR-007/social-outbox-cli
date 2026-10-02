import { randomBytes, createHash } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import {
  runInstagramPlan,
  runInstagramPublish,
  runInstagramResume,
  runInstagramRetry,
  type InstagramCommandDeps,
} from '../../src/cli/commands/instagram.js';
import { runPublishCommand } from '../../src/cli/commands/publish.js';
import { runWorker } from '../../src/cli/commands/worker.js';
import { createContext, type AppContext } from '../../src/cli/context.js';
import { getAppState, setAppState } from '../../src/db/app-state.js';
import { platformPosts, videos, type NewVideo } from '../../src/db/schema.js';
import { GraphClient } from '../../src/facebook/graph-client.js';
import { MemoryTokenStore } from '../../src/facebook/token-store.js';
import { mediaInfo } from '../fixtures/factories.js';
import { PAGE_ID } from '../fixtures/fake-facebook-videos.js';
import { graphError } from '../fixtures/fake-graph.js';
import { fakeInstagram, IG_ID } from '../fixtures/fake-instagram.js';
import { collectOutput, makeTempDir } from '../helpers.js';

const NOW = new Date('2026-10-05T06:00:00.000Z');
const H = 3_600_000;

describe('instagram commands and worker', () => {
  let dir: string;
  let cleanup: () => void;
  let store: MemoryTokenStore;
  let ig: ReturnType<typeof fakeInstagram>;
  let out: ReturnType<typeof collectOutput>;
  let clock: number;
  let seq = 0;

  const ctx = (env: Record<string, string> = {}): AppContext => {
    out = collectOutput();
    return createContext({
      cwd: dir,
      env: { TIMEZONE: 'Asia/Kolkata', MIN_UPLOAD_GAP_SECONDS: '0', ...env },
      print: out.print,
      tokenStore: store,
    });
  };
  const quiet = () => createContext({ cwd: dir, env: {}, print: () => {}, tokenStore: store });
  const deps = (): InstagramCommandDeps => ({
    client: new GraphClient({ version: 'v26.0', fetch: ig.fetch }),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    backoffMs: [1],
    processingWaitMs: 60_000,
    pollIntervalMs: 1_000,
  });
  function video(over: Partial<NewVideo> = {}) {
    seq += 1;
    const path = join(dir, 'videos', `Video_${seq}.mp4`);
    const bytes = randomBytes(500);
    writeFileSync(path, bytes);
    return quiet().withDb((db) =>
      db
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
          caption: `Caption ${seq}`,
          hashtags: ['#cdrama'],
          action: 'SCHEDULE',
          scheduledAt: new Date(clock + 24 * H).toISOString(),
          state: 'READY',
          ...over,
        })
        .returning()
        .get(),
    );
  }
  const igRow = (videoId: number) =>
    quiet().withDb((db) => db.select().from(platformPosts).where(eq(platformPosts.videoId, videoId)).get());

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    runInit(dir, () => {});
    store = new MemoryTokenStore();
    store.set(`page:${PAGE_ID}`, 'PAGE-TOKEN');
    quiet().withDb((db) => {
      setAppState(db, 'page_id', PAGE_ID);
      setAppState(db, 'page_name', 'My Test Page');
      setAppState(db, 'instagram_user_id', IG_ID);
      setAppState(db, 'instagram_username', 'drama_ig');
    });
    ig = fakeInstagram();
    clock = NOW.getTime();
  });
  afterEach(() => {
    cleanup();
  });

  it('plan --from-facebook mirrors future Facebook times with an offset; preview then --apply', () => {
    const a = video({ scheduledAt: new Date(clock + 5 * H).toISOString() });
    const long = video({ durationS: 20 * 60, mediaInfo: mediaInfo({ durationS: 20 * 60 }) });
    const past = video({ state: 'SCHEDULED', scheduledAt: new Date(clock - H).toISOString() });
    const preview = runInstagramPlan(ctx(), { fromFacebook: true, offset: '30' }, NOW);
    expect(preview.planned.map((p) => [p.video.id, p.at.toISOString(), p.change])).toEqual([
      [a.id, new Date(clock + 5 * H + 30 * 60_000).toISOString(), 'created'],
    ]);
    expect(preview.skipped.map((s) => [s.video.id, s.reason])).toEqual([
      [past.id, 'Facebook time already passed'],
      [long.id, 'duration 20.0 min > 15 min (Instagram limit)'],
    ]);
    expect(out.text()).toContain('Preview only');
    expect(igRow(a.id)).toBeUndefined();

    runInstagramPlan(ctx(), { fromFacebook: true, offset: '30', apply: true }, NOW);
    expect(igRow(a.id)).toMatchObject({
      platform: 'instagram',
      action: 'SCHEDULE',
      state: 'READY',
      scheduledAt: new Date(clock + 5 * H + 30 * 60_000).toISOString(),
    });
    expect(runInstagramPlan(ctx(), { fromFacebook: true, offset: '30' }, NOW).planned[0]?.change).toBe('unchanged');
  });

  it('Facebook publish plan is identical with or without Instagram posts', async () => {
    for (let i = 0; i < 3; i++) video({ scheduledAt: new Date(clock + (i + 2) * H).toISOString() });
    const fbDeps = { client: new GraphClient({ version: 'v26.0', fetch: ig.fetch }), now: () => new Date(clock) };
    await runPublishCommand(ctx(), { dryRun: true }, fbDeps);
    const before = out.text();
    runInstagramPlan(ctx(), { fromFacebook: true, apply: true }, NOW);
    await runPublishCommand(ctx(), { dryRun: true }, fbDeps);
    expect(out.text()).toBe(before);
  });

  it('instagram publish runs one cycle; dry-run sends nothing', async () => {
    const v = video();
    quiet().withDb((db) =>
      db
        .insert(platformPosts)
        .values({ videoId: v.id, platform: 'instagram', action: 'POST_NOW', state: 'READY' })
        .run(),
    );
    await runInstagramPublish(ctx(), { dryRun: true }, deps());
    expect(out.text()).toContain('Prepare now (re-encode + upload): 1');
    expect(ig.requests).toHaveLength(0);
    await runInstagramPublish(ctx(), {}, deps());
    expect(igRow(v.id)?.state).toBe('UPLOADED');
    await runInstagramPublish(ctx(), {}, deps());
    expect(igRow(v.id)?.state).toBe('PUBLISHED');
    expect(out.text()).toContain('✓ published https://www.instagram.com/reel/');
  });

  it('retry resets failed posts; resume clears an Instagram-only pause', async () => {
    const v = video({ durationS: 20 * 60, mediaInfo: mediaInfo({ durationS: 20 * 60 }) });
    quiet().withDb((db) =>
      db
        .insert(platformPosts)
        .values({ videoId: v.id, platform: 'instagram', action: 'POST_NOW', state: 'READY' })
        .run(),
    );
    await runInstagramPublish(ctx(), {}, deps());
    expect(igRow(v.id)?.state).toBe('FAILED');
    expect(runInstagramRetry(ctx())).toBe(1);
    expect(igRow(v.id)?.state).toBe('READY');

    quiet().withDb((db) => {
      setAppState(db, 'instagram_paused', 'true');
    });
    expect(runInstagramResume(ctx())).toBe(true);
    expect(quiet().withDb((db) => getAppState(db, 'instagram_paused'))).toBe('false');
    expect(quiet().withDb((db) => getAppState(db, 'publishing_paused'))).toBeUndefined();
  });

  it('worker: prepares ahead and publishes at the scheduled time, then stops cleanly', async () => {
    const v = video({ scheduledAt: new Date(clock + 2 * H).toISOString() });
    runInstagramPlan(ctx(), { fromFacebook: true, apply: true }, NOW);
    const controller = new AbortController();
    let ticks = 0;
    const code = await runWorker(
      ctx(),
      { interval: '30' },
      {
        ...deps(),
        signal: controller.signal,
        idle: async (ms) => {
          ticks += 1;
          clock += ticks === 1 ? 2 * H : ms; // after the first cycle, jump to the publish time
          if (ticks === 3) controller.abort();
        },
      },
    );
    expect(code).toBe(0);
    expect(igRow(v.id)?.state).toBe('PUBLISHED');
    expect(out.text()).toContain('Worker stopped after 3 cycle(s).');
    expect(ig.publishes()).toBe(1);
  });

  it('worker: only one at a time, and it stops when Instagram pauses', async () => {
    writeFileSync(join(dir, 'data', 'worker.lock'), String(process.pid));
    await expect(runWorker(ctx(), { once: true }, deps())).rejects.toThrow(/already running/);
    writeFileSync(join(dir, 'data', 'worker.lock'), '999999999'); // stale lock is ignored
    const v = video();
    quiet().withDb((db) =>
      db
        .insert(platformPosts)
        .values({ videoId: v.id, platform: 'instagram', action: 'POST_NOW', state: 'READY' })
        .run(),
    );
    ig.fail.create.push(graphError(368, '', 400, { error_subcode: 1390008 }));
    expect(await runWorker(ctx(), { once: true }, deps())).toBe(1);
    expect(out.text()).toContain('Instagram is PAUSED');
    expect(out.text()).toContain('Worker stopped: fix the problem above');
  });

  it('worker refuses to start when Instagram is not connected', async () => {
    const { appState } = await import('../../src/db/schema.js');
    quiet().withDb((db) => db.delete(appState).run());
    await expect(runWorker(ctx(), { once: true }, deps())).rejects.toThrow(/instagram connect/);
  });
});
