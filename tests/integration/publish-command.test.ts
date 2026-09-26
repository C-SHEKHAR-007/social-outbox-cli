import { randomBytes } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import {
  runPublishCommand,
  runReconcileCommand,
  runResume,
  runRetry,
  type PublishCommandDeps,
} from '../../src/cli/commands/publish.js';
import { createContext, type AppContext } from '../../src/cli/context.js';
import { getAppState, setAppState } from '../../src/db/app-state.js';
import { videos, type NewVideo } from '../../src/db/schema.js';
import { GraphClient } from '../../src/facebook/graph-client.js';
import { MemoryTokenStore } from '../../src/facebook/token-store.js';
import { sha256File } from '../../src/scanner/file-identity.js';
import { UserError } from '../../src/utils/errors.js';
import { fakeFacebookVideos, PAGE_ID } from '../fixtures/fake-facebook-videos.js';
import { mediaInfo } from '../fixtures/factories.js';
import { graphError } from '../fixtures/fake-graph.js';
import { collectOutput, makeTempDir } from '../helpers.js';

const NOW = new Date('2026-09-27T06:00:00.000Z');
const H = 3_600_000;

describe('publish command', () => {
  let dir: string;
  let cleanup: () => void;
  let store: MemoryTokenStore;
  let fb: ReturnType<typeof fakeFacebookVideos>;
  let out: ReturnType<typeof collectOutput>;
  let clock: number;
  let seq = 0;
  let confirmAnswer = true;
  let asked: string[] = [];

  const ctx = (env: Record<string, string> = {}): AppContext => {
    out = collectOutput();
    return createContext({ cwd: dir, env: { TIMEZONE: 'Asia/Kolkata', ...env }, print: out.print, tokenStore: store });
  };
  const deps = (): PublishCommandDeps => ({
    client: new GraphClient({ version: 'v26.0', fetch: fb.fetch }),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    backoffMs: [1],
    confirm: async (q) => {
      asked.push(q);
      return confirmAnswer;
    },
  });

  async function add(over: Partial<NewVideo> = {}) {
    seq += 1;
    const path = join(dir, 'videos', `Video_${seq}.mp4`);
    writeFileSync(path, randomBytes(600));
    const st = statSync(path);
    const c = ctx();
    return c.withDbAsync(async (db) =>
      db
        .insert(videos)
        .values({
          fileHash: await sha256File(path),
          filePath: path,
          filename: `Video_${seq}.mp4`,
          fileSize: st.size,
          fileMtime: Math.trunc(st.mtimeMs),
          durationS: 30,
          mediaInfo: mediaInfo(),
          specOk: true,
          specIssues: [],
          caption: `Caption ${seq}`,
          hashtags: ['#reels'],
          action: 'POST_NOW',
          state: 'READY',
          ...over,
        })
        .returning()
        .get(),
    );
  }
  /** Reads a row without resetting the captured command output. */
  const row = (id: number) =>
    createContext({ cwd: dir, env: {}, print: () => {}, tokenStore: store }).withDb((db) =>
      db.select().from(videos).where(eq(videos.id, id)).get()!,
    );

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    runInit(dir, () => {});
    store = new MemoryTokenStore();
    store.set(`page:${PAGE_ID}`, 'PAGE-TOKEN');
    ctx().withDb((db) => {
      setAppState(db, 'page_id', PAGE_ID);
      setAppState(db, 'page_name', 'Reel Viral Page');
    });
    fb = fakeFacebookVideos();
    clock = NOW.getTime();
    confirmAnswer = true;
    asked = [];
  });
  afterEach(() => {
    cleanup();
  });

  it('dry-run prints the plan and sends nothing', async () => {
    await add();
    await add({ action: 'SCHEDULE', scheduledAt: new Date(clock + 5 * H).toISOString() });
    await add({ action: 'SCHEDULE', scheduledAt: new Date(clock + 40 * 24 * H).toISOString() });
    await add({ caption: null });
    const { code } = await runPublishCommand(ctx(), { dryRun: true }, deps());
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain('Publish plan for "Reel Viral Page" (dry run: nothing will be sent)');
    expect(text).toMatch(/Publish now: 1\n {2}#1 +Video_1\.mp4 +REEL/);
    expect(text).toMatch(/Schedule on Facebook: 1\n {2}#2 +Video_2\.mp4 +REEL +2026-09-27 16:30/);
    expect(text).toContain('Hold (not sent yet): 1');
    expect(text).toMatch(/Not publishable: 1\n {2}#4 .*caption is empty/);
    expect(fb.requests).toHaveLength(0);
    expect(row(3).state).toBe('READY'); // dry-run writes nothing
  });

  it('asks for confirmation and sends nothing when declined', async () => {
    await add();
    confirmAnswer = false;
    await runPublishCommand(ctx(), {}, deps());
    expect(asked).toEqual(['Publish/schedule 1 video(s) on "Reel Viral Page"? [y/N] ']);
    expect(out.text()).toContain('Cancelled. Nothing was sent.');
    expect(fb.requests).toHaveLength(0);
  });

  it('publishes POST_NOW first, schedules natively, holds far-future, skips invalid', async () => {
    const sched = await add({ action: 'SCHEDULE', scheduledAt: new Date(clock + 5 * H).toISOString() });
    const now1 = await add();
    const far = await add({ action: 'SCHEDULE', scheduledAt: new Date(clock + 40 * 24 * H).toISOString() });
    const bad = await add({ caption: '' });
    const long = await add({ publishTarget: 'VIDEO', durationS: 400, mediaInfo: mediaInfo({ durationS: 400 }) });

    const { report, code } = await runPublishCommand(ctx(), { yes: true }, deps());
    expect(code).toBe(0);
    expect(asked).toEqual([]);
    expect(report.items.filter((i) => i.outcome).map((i) => [i.video.id, i.outcome!.result])).toEqual([
      [now1.id, 'published'],
      [long.id, 'published'],
      [sched.id, 'scheduled'],
    ]);
    expect(row(far.id)).toMatchObject({
      state: 'HELD',
      nextAttemptAt: new Date(Date.parse(far.scheduledAt!) - 29 * 24 * H + H).toISOString(),
    });
    expect(row(bad.id).state).toBe('READY');
    expect(out.text()).toContain('Done: 2 published, 1 scheduled, 0 drafts, 0 processing, 0 failed, 0 unknown.');
    expect(out.text()).toMatch(
      new RegExp(`\\[\\d/3\\] #${now1.id} ${now1.filename} \\(Reel\\) ✓ published \\(\\d+s\\)`),
    );
    expect(out.text()).toContain('Uploading 3 video(s), 3 at a time…');
  });

  it('respects the Reels quota (Page videos are not counted) and --limit', async () => {
    const a = await add();
    const b = await add();
    const v = await add({ publishTarget: 'VIDEO', durationS: 400, mediaInfo: mediaInfo({ durationS: 400 }) });
    await runPublishCommand(ctx({ QUOTA_PER_24H: '1' }), { yes: true }, deps());
    expect([row(a.id).state, row(b.id).state, row(v.id).state]).toEqual(['PUBLISHED', 'HELD', 'PUBLISHED']);
    // b was planned while a was still uploading (reserved quota), so it is re-checked in an hour
    expect(row(b.id).nextAttemptAt).toBe(new Date(NOW.getTime() + H).toISOString());

    const c = await add();
    const d = await add();
    await runPublishCommand(ctx(), { yes: true, limit: '1', ids: [c.id, d.id] }, deps());
    expect([row(c.id).state, row(d.id).state]).toEqual(['PUBLISHED', 'READY']);
  });

  it('--draft uploads privately (even without an action) and retry --drafts makes it publishable', async () => {
    const v = await add({ action: null, state: 'NEW' });
    await expect(runPublishCommand(ctx(), { draft: true, yes: true }, deps())).rejects.toThrow(/--draft needs --ids/);
    await runPublishCommand(ctx(), { draft: true, yes: true, ids: [v.id] }, deps());
    expect(row(v.id)).toMatchObject({ state: 'DRAFT', fbVideoId: 'R1' });
    expect(fb.requests.find((r) => r.params.upload_phase === 'finish')!.params.video_state).toBe('DRAFT');

    runRetry(ctx(), { ids: [v.id] });
    expect(row(v.id).state).toBe('DRAFT'); // drafts need --drafts
    runRetry(ctx(), { ids: [v.id], drafts: true });
    expect(row(v.id)).toMatchObject({ state: 'NEW', fbVideoId: null });
    expect(out.text()).toContain('draft copies stay on Facebook');
  });

  it('stops the whole run on a token error', async () => {
    const a = await add();
    const b = await add();
    fb.fail.reelStart.push(graphError(190, 'Error validating access token'));
    const { report, code } = await runPublishCommand(ctx(), { yes: true, concurrency: '1' }, deps());
    expect(code).toBe(1);
    expect(report.stopped?.reason).toBe('fatal');
    expect([row(a.id).state, row(b.id).state]).toEqual(['READY', 'READY']);
    expect(fb.starts()).toBe(1);
    expect(out.text()).toContain('reel-cli facebook verify');
  });

  it('uploads several videos in parallel and never exceeds the Reels quota', async () => {
    fb = fakeFacebookVideos({ latencyMs: 15 });
    const reels = [];
    for (let i = 0; i < 6; i++) reels.push(await add());
    const vids = [];
    for (let i = 0; i < 3; i++)
      vids.push(await add({ publishTarget: 'VIDEO', durationS: 400, mediaInfo: mediaInfo({ durationS: 400 }) }));
    const { code } = await runPublishCommand(ctx({ QUOTA_PER_24H: '4' }), { yes: true, concurrency: '3' }, deps());
    expect(code).toBe(0);
    expect(fb.maxInFlight()).toBeGreaterThan(1);
    expect(fb.maxInFlight()).toBeLessThanOrEqual(3);
    const states = reels.map((r) => row(r.id).state);
    expect(states.filter((s) => s === 'PUBLISHED')).toHaveLength(4); // quota 4, even though uploads overlapped
    expect(states.filter((s) => s === 'HELD')).toHaveLength(2);
    expect(vids.map((v) => row(v.id).state)).toEqual(['PUBLISHED', 'PUBLISHED', 'PUBLISHED']);
  });

  it('a fatal error while uploading in parallel lets running uploads finish but starts no new ones', async () => {
    fb = fakeFacebookVideos({ latencyMs: 15 });
    const all = [];
    for (let i = 0; i < 6; i++) all.push(await add());
    fb.fail.reelStart.push(graphError(190, 'Error validating access token'));
    const { report, code } = await runPublishCommand(ctx(), { yes: true, concurrency: '2' }, deps());
    expect(code).toBe(1);
    expect(report.stopped?.reason).toBe('fatal');
    expect(fb.starts()).toBeLessThanOrEqual(3); // the failing one, the one already running, at most one more in the gap
    expect(all.map((v) => row(v.id).state).filter((s) => s === 'READY').length).toBeGreaterThanOrEqual(3);
  });

  it('scheduled videos are not waited for by default; POST_NOW is', async () => {
    fb = fakeFacebookVideos({ processingPolls: 1 });
    const now1 = await add();
    const sched = await add({ action: 'SCHEDULE', scheduledAt: new Date(clock + 5 * H).toISOString() });
    await runPublishCommand(ctx(), { yes: true, concurrency: '1' }, deps());
    expect(row(now1.id).state).toBe('PUBLISHED'); // waited through processing
    expect(row(sched.id).state).toBe('PROCESSING'); // one quick check, confirmed later
    expect(out.text()).toContain('run `reel-cli reconcile` in a few minutes');
    await runReconcileCommand(ctx(), {}, deps());
    expect(row(sched.id).state).toBe('SCHEDULED');
  });

  it('--wait also waits for scheduled videos; --no-wait never waits', async () => {
    fb = fakeFacebookVideos({ processingPolls: 2 });
    const a = await add({ action: 'SCHEDULE', scheduledAt: new Date(clock + 5 * H).toISOString() });
    await runPublishCommand(ctx(), { yes: true, wait: '60' }, deps());
    expect(row(a.id).state).toBe('SCHEDULED');
    const b = await add();
    await runPublishCommand(ctx(), { yes: true, wait: false }, deps());
    expect(row(b.id).state).toBe('PROCESSING');
  });

  it('the dry run counts the Reels quota down like a real run', async () => {
    for (let i = 0; i < 3; i++) await add();
    await runPublishCommand(ctx({ QUOTA_PER_24H: '2' }), { dryRun: true }, deps());
    expect(out.text()).toContain('Publish now: 2');
    expect(out.text()).toMatch(/Hold \(not sent yet\): 1\n.*Reels 24h quota reached/);
  });

  it('rejects an invalid --concurrency', async () => {
    await expect(runPublishCommand(ctx(), { dryRun: true, concurrency: '9' }, deps())).rejects.toThrow(/--concurrency/);
  });

  it('refuses to publish while paused; resume clears it', async () => {
    await add();
    ctx().withDb((db) => {
      setAppState(db, 'publishing_paused', 'true');
      setAppState(db, 'paused_reason', 'Facebook error 368');
    });
    await expect(runPublishCommand(ctx(), { yes: true }, deps())).rejects.toThrow(UserError);
    expect(runResume(ctx())).toBe(true);
    expect(out.text()).toContain('Was paused because: Facebook error 368');
    expect(ctx().withDb((db) => getAppState(db, 'publishing_paused'))).toBe('false');
    expect(runResume(ctx())).toBe(false);
    expect((await runPublishCommand(ctx(), { yes: true }, deps())).code).toBe(0);
  });

  it('reconcile settles unknown outcomes and publish reconciles first', async () => {
    const v = await add();
    fb.flags.finishAppliedButNetworkDrop = true;
    const first = await runPublishCommand(ctx(), { yes: true }, deps());
    expect(first.code).toBe(1);
    expect(row(v.id).state).toBe('FINISHING');
    expect(out.text()).toContain('run `reel-cli reconcile`');

    const results = await runReconcileCommand(ctx(), {}, deps());
    expect(results.map((r) => r.result)).toEqual(['published']);
    expect(row(v.id).state).toBe('PUBLISHED');
    expect(fb.finishes()).toBe(1);
    await runReconcileCommand(ctx(), {}, deps());
    expect(out.text()).toContain('Nothing to reconcile');
  });

  it('retry resets FAILED videos', async () => {
    fb = fakeFacebookVideos({ processingError: 'Video could not be processed' });
    const v = await add();
    await runPublishCommand(ctx(), { yes: true }, deps());
    expect(row(v.id)).toMatchObject({ state: 'FAILED', lastError: 'Video could not be processed' });
    runRetry(ctx(), { dryRun: true });
    expect(row(v.id).state).toBe('FAILED');
    runRetry(ctx());
    expect(row(v.id)).toMatchObject({ state: 'READY', fbVideoId: null, lastError: null });
  });

  it('requires a connected Page', async () => {
    store = new MemoryTokenStore();
    await expect(runPublishCommand(ctx(), { dryRun: true }, deps())).rejects.toThrow(/No Facebook Page connected/);
  });
});
