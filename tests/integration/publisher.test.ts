import { randomBytes } from 'node:crypto';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAppState } from '../../src/db/app-state.js';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { publishAttempts, videos, type NewVideo } from '../../src/db/schema.js';
import { GraphClient } from '../../src/facebook/graph-client.js';
import { claimVideo } from '../../src/publisher/lease.js';
import { publishOne, reconcileOne, type PublisherDeps } from '../../src/publisher/publisher.js';
import { sha256File } from '../../src/scanner/file-identity.js';
import { fakeFacebookVideos, PAGE_ID } from '../fixtures/fake-facebook-videos.js';
import { graphError } from '../fixtures/fake-graph.js';
import { makeTempDir } from '../helpers.js';

const TOKEN = 'PAGE-TOKEN';
const NOW = new Date('2026-09-27T06:00:00.000Z');

describe('publisher', () => {
  let h: DbHandle;
  let dir: string;
  let cleanup: () => void;
  let clock: number;
  let fb: ReturnType<typeof fakeFacebookVideos>;
  let seq = 0;

  const deps = (over: Partial<PublisherDeps> = {}): PublisherDeps => ({
    db: h.db,
    client: new GraphClient({ version: 'v26.0', fetch: fb.fetch }),
    page: { id: PAGE_ID, token: TOKEN },
    owner: 'test-run',
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    maxRetries: 3,
    backoffMs: [5_000, 15_000, 45_000],
    pollTimeoutMs: 60_000,
    pollIntervalMs: 5_000,
    ...over,
  });

  async function video(size: number, over: Partial<NewVideo> = {}) {
    seq += 1;
    const path = join(dir, `Video_${seq}.mp4`);
    writeFileSync(path, randomBytes(size));
    const st = statSync(path);
    return h.db
      .insert(videos)
      .values({
        fileHash: await sha256File(path),
        filePath: path,
        filename: `Video_${seq}.mp4`,
        fileSize: st.size,
        fileMtime: Math.trunc(st.mtimeMs),
        durationS: 30,
        specOk: true,
        caption: 'Wait for the end',
        hashtags: ['#drama', '#reels'],
        action: 'POST_NOW',
        state: 'READY',
        ...over,
      })
      .returning()
      .get();
  }
  const row = (id: number) => h.db.select().from(videos).where(eq(videos.id, id)).get()!;
  const steps = (id: number) =>
    h.db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.videoId, id))
      .orderBy(asc(publishAttempts.id))
      .all()
      .map((a) => `${a.step}:${a.outcome}`);

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    h = openDatabase(':memory:');
    clock = NOW.getTime();
    fb = fakeFacebookVideos();
  });
  afterEach(() => {
    h.close();
    cleanup();
  });

  describe('Reels', () => {
    it('publishes now: START → rupload → FINISH → VERIFY, saving ids and permalink', async () => {
      const v = await video(1000);
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out).toMatchObject({ result: 'published' });
      expect(row(v.id)).toMatchObject({
        state: 'PUBLISHED',
        fbVideoId: 'R1',
        fbPostId: `${PAGE_ID}_R1`,
        fbPermalink: 'https://www.facebook.com/reel/R1',
        bytesUploaded: 1000,
        lockedBy: null,
        lastError: null,
      });
      expect(row(v.id).publishedAt).toBeTruthy();
      expect(row(v.id).finishSentAt).toBe(NOW.toISOString());
      expect(steps(v.id)).toEqual(['START:ok', 'TRANSFER:ok', 'FINISH:ok', 'VERIFY:ok']);
      const upload = fb.requests.find((r) => r.host === 'rupload.facebook.com')!;
      expect(upload).toMatchObject({
        bodyBytes: 1000,
        headers: { offset: '0', file_size: '1000', authorization: `OAuth ${TOKEN}` },
      });
      const finish = fb.requests.find((r) => r.params.upload_phase === 'finish')!;
      expect(finish.params).toMatchObject({
        video_state: 'PUBLISHED',
        description: 'Wait for the end\n\n#drama #reels',
      });
    });

    it('schedules natively and drafts privately', async () => {
      const a = await video(500, { action: 'SCHEDULE', scheduledAt: '2026-09-28T14:30:00.000Z' });
      const b = await video(500);
      expect(
        (await publishOne(deps(), a.id, { kind: 'schedule', at: new Date('2026-09-28T14:30:00.000Z') })).result,
      ).toBe('scheduled');
      expect((await publishOne(deps(), b.id, { kind: 'draft' })).result).toBe('draft');
      const finishes = fb.requests
        .filter((r) => r.params.upload_phase === 'finish')
        .map((r) => [r.params.video_state, r.params.scheduled_publish_time]);
      expect(finishes).toEqual([
        ['SCHEDULED', String(Date.parse('2026-09-28T14:30:00.000Z') / 1000)],
        ['DRAFT', undefined],
      ]);
      expect([row(a.id).state, row(b.id).state]).toEqual(['SCHEDULED', 'DRAFT']);
    });

    it('retries transient failures with backoff, then succeeds', async () => {
      const v = await video(800);
      fb.fail.rupload.push(graphError(1, 'An unknown error occurred', 500), 'network-error');
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out.result).toBe('published');
      expect(steps(v.id)).toEqual([
        'START:ok',
        'TRANSFER:transient',
        'TRANSFER:transient',
        'TRANSFER:ok',
        'FINISH:ok',
        'VERIFY:ok',
      ]);
      expect(clock - NOW.getTime()).toBeGreaterThanOrEqual(20_000); // 5s + 15s backoff
    });

    it('fails the video after retries are exhausted, without posting', async () => {
      const v = await video(800);
      fb.fail.rupload.push(...Array.from({ length: 4 }, () => graphError(2, 'Service temporarily unavailable', 503)));
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out).toMatchObject({ result: 'failed', message: 'TRANSFER: Service temporarily unavailable' });
      expect(row(v.id)).toMatchObject({ state: 'FAILED', lastErrorCode: '2', retryCount: 3 });
      expect(fb.finishes()).toBe(0);
    });

    it('stops the run on token errors and leaves the video untouched', async () => {
      const v = await video(800);
      fb.fail.reelStart.push(graphError(190, 'Error validating access token: Session has expired.'));
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out).toMatchObject({ result: 'skipped', stop: 'fatal' });
      expect(row(v.id)).toMatchObject({ state: 'READY', fbVideoId: null, lastErrorCode: '190' });
    });

    it('pauses all publishing on error 368', async () => {
      const v = await video(800);
      fb.fail.reelFinish.push(
        graphError(368, 'The action attempted has been deemed abusive or is otherwise disallowed'),
      );
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out.stop).toBe('pause');
      expect(getAppState(h.db, 'publishing_paused')).toBe('true');
      expect(getAppState(h.db, 'paused_reason')).toContain('368');
      expect(row(v.id).state).toBe('UPLOADING'); // FINISH was rejected, so nothing is public
    });

    it('holds on rate limits and resumes later without re-uploading', async () => {
      const v = await video(800);
      fb.fail.reelFinish.push(graphError(613, 'Calls to this api have exceeded the rate limit.'));
      const first = await publishOne(deps(), v.id, { kind: 'now' });
      expect(first).toMatchObject({ result: 'held', stop: 'rate_limit' });
      expect(row(v.id)).toMatchObject({
        state: 'UPLOADING',
        fbVideoId: 'R1',
        nextAttemptAt: new Date(clock + 3_600_000).toISOString(),
      });

      clock += 2 * 3_600_000;
      const second = await publishOne(deps(), v.id, { kind: 'now' });
      expect(second.result).toBe('published');
      expect(fb.starts()).toBe(1); // never STARTed twice
      expect(fb.requests.filter((r) => r.host === 'rupload.facebook.com')).toHaveLength(1); // no re-upload
    });

    it('resumes an interrupted upload from the byte offset Facebook reports', async () => {
      const v = await video(1000);
      // Simulate a crash mid-upload: START happened and 400 bytes reached Facebook.
      const started = await deps().client.post(
        `${PAGE_ID}/video_reels`,
        { upload_phase: 'start' },
        (await import('zod')).z.any(),
        { token: TOKEN },
      );
      const id = (started as { video_id: string }).video_id;
      fb.videos.get(id)!.bytes = 400;
      fb.videos.get(id)!.fileSize = 1000;
      h.db
        .update(videos)
        .set({
          fbVideoId: id,
          state: 'UPLOADING',
          bytesUploaded: 400,
          lockedBy: 'crashed',
          lockExpiresAt: new Date(clock - 1).toISOString(),
        })
        .where(eq(videos.id, v.id))
        .run();

      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out.result).toBe('published');
      expect(fb.starts()).toBe(1);
      const upload = fb.requests.find((r) => r.host === 'rupload.facebook.com')!;
      expect(upload).toMatchObject({ bodyBytes: 600, headers: { offset: '400', file_size: '1000' } });
    });

    it('FINISH with unknown outcome is never resent; reconcile settles it', async () => {
      const v = await video(700);
      fb.flags.finishAppliedButNetworkDrop = true; // Facebook applied FINISH but the response was lost
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out.result).toBe('unknown');
      expect(row(v.id).state).toBe('FINISHING');
      expect(fb.finishes()).toBe(1);

      // A second publish must not touch it (FINISHING is not claimable)…
      expect((await publishOne(deps(), v.id, { kind: 'now' })).result).toBe('skipped');
      expect(fb.finishes()).toBe(1);
      // …reconcile asks Facebook and finds it published.
      expect((await reconcileOne(deps(), v.id)).result).toBe('published');
      expect(row(v.id).state).toBe('PUBLISHED');
      expect(fb.finishes()).toBe(1);
    });

    it('FINISH that never reached Facebook: reconcile → UPLOADING, next publish resends FINISH only', async () => {
      const v = await video(700);
      fb.fail.reelFinish.push('network-error'); // dropped before Facebook applied it
      expect((await publishOne(deps(), v.id, { kind: 'now' })).result).toBe('unknown');
      expect((await reconcileOne(deps(), v.id)).result).toBe('uploading');
      expect(row(v.id).state).toBe('UPLOADING');
      clock += 31 * 60_000; // lease from the first run has expired anyway
      expect((await publishOne(deps(), v.id, { kind: 'now' })).result).toBe('published');
      expect(fb.starts()).toBe(1);
      expect(fb.requests.filter((r) => r.host === 'rupload.facebook.com')).toHaveLength(1);
      expect(fb.finishes()).toBe(2);
    });

    it('slow processing: stays PROCESSING after the poll window, reconcile finishes later', async () => {
      fb = fakeFacebookVideos({ processingPolls: 50 });
      const v = await video(500);
      expect((await publishOne(deps({ pollTimeoutMs: 20_000 }), v.id, { kind: 'now' })).result).toBe('processing');
      expect(row(v.id).state).toBe('PROCESSING');
      fb.videos.get('R1')!.processingPolls = 0;
      expect((await reconcileOne(deps(), v.id)).result).toBe('published');
    });

    it('marks the video FAILED when Facebook processing rejects it', async () => {
      fb = fakeFacebookVideos({ processingError: 'Reels duration must be between 3 and 90 seconds.' });
      const v = await video(500);
      expect(await publishOne(deps(), v.id, { kind: 'now' })).toMatchObject({ result: 'failed' });
      expect(row(v.id)).toMatchObject({
        state: 'FAILED',
        lastError: 'Reels duration must be between 3 and 90 seconds.',
        lastErrorCode: 'REMOTE',
      });
    });
  });

  describe('Page videos', () => {
    it('uploads in chunks and publishes', async () => {
      const v = await video(1000, { publishTarget: 'VIDEO', durationS: 400 });
      expect((await publishOne(deps(), v.id, { kind: 'now' })).result).toBe('published');
      const transfers = fb.requests
        .filter((r) => r.params.upload_phase === 'transfer')
        .map((r) => [r.params.start_offset, r.params.video_file_chunk]);
      expect(transfers).toEqual([
        ['0', '<blob:400>'],
        ['400', '<blob:400>'],
        ['800', '<blob:200>'],
      ]);
      expect(fb.requests.every((r) => r.host !== 'rupload.facebook.com')).toBe(true);
      expect(row(v.id)).toMatchObject({
        state: 'PUBLISHED',
        fbVideoId: 'V1',
        bytesUploaded: 1000,
        fbPermalink: 'https://www.facebook.com/videos/V1',
      });
    });

    it('schedules up to 6 months ahead (published=false + SCHEDULED)', async () => {
      const at = new Date('2027-01-15T12:00:00.000Z');
      const v = await video(900, { publishTarget: 'VIDEO', action: 'SCHEDULE', scheduledAt: at.toISOString() });
      expect((await publishOne(deps(), v.id, { kind: 'schedule', at })).result).toBe('scheduled');
      expect(fb.requests.find((r) => r.params.upload_phase === 'finish')!.params).toMatchObject({
        published: 'false',
        unpublished_content_type: 'SCHEDULED',
        scheduled_publish_time: String(at.getTime() / 1000),
      });
      expect(row(v.id).state).toBe('SCHEDULED');
    });

    it('an interrupted Page video upload is re-uploaded, not mistaken for published', async () => {
      const at = new Date(clock + 5 * 3_600_000);
      const v = await video(1000, { publishTarget: 'VIDEO', action: 'SCHEDULE', scheduledAt: at.toISOString() });
      fb.fail.videoTransfer.push(graphError(100, 'boom')); // first run dies after START
      h.db.update(videos).set({ state: 'READY' }).where(eq(videos.id, v.id)).run();
      await publishOne(deps(), v.id, { kind: 'schedule', at });
      // simulate the crash state: START done, row left UPLOADING with the stale Facebook id
      h.db.update(videos).set({ state: 'UPLOADING', lastError: null }).where(eq(videos.id, v.id)).run();
      const out = await publishOne(deps(), v.id, { kind: 'schedule', at });
      expect(out.result).toBe('scheduled');
      expect(fb.starts()).toBe(2); // a fresh upload session
      expect(row(v.id)).toMatchObject({ state: 'SCHEDULED', fbVideoId: 'V2', bytesUploaded: 1000 });
    });

    it('retries a failed chunk in the same session', async () => {
      const v = await video(1000, { publishTarget: 'VIDEO' });
      fb.fail.videoTransfer.push('network-error');
      expect((await publishOne(deps(), v.id, { kind: 'now' })).result).toBe('published');
      expect(steps(v.id).filter((s) => s.startsWith('TRANSFER'))).toEqual([
        'TRANSFER:transient',
        'TRANSFER:ok',
        'TRANSFER:ok',
        'TRANSFER:ok',
      ]);
    });
  });

  describe('after FINISH, our-side errors never fail a video', () => {
    it('an unreadable status after FINISH leaves the video PROCESSING (not FAILED), reconcile settles it', async () => {
      const at = new Date(clock + 5 * 3_600_000);
      const v = await video(900, { publishTarget: 'VIDEO', action: 'SCHEDULE', scheduledAt: at.toISOString() });
      fb.fail.status.push({ status: 200, body: { status: 'not-an-object' } }); // unparseable response
      const out = await publishOne(deps(), v.id, { kind: 'schedule', at });
      expect(out.result).toBe('processing');
      expect(row(v.id).state).toBe('PROCESSING');
      expect(row(v.id).lastError).toContain('could not read the status');
      expect((await reconcileOne(deps(), v.id)).result).toBe('scheduled');
      expect(row(v.id).state).toBe('SCHEDULED');
      expect(fb.starts()).toBe(1);
      expect(fb.finishes()).toBe(1);
    });

    it('reconcile keeps a SCHEDULED video SCHEDULED when the status cannot be read', async () => {
      const at = new Date(clock + 3_600_000);
      const v = await video(500, { action: 'SCHEDULE', scheduledAt: at.toISOString() });
      await publishOne(deps(), v.id, { kind: 'schedule', at });
      clock += 2 * 3_600_000;
      fb.fail.status.push(graphError(100, 'Unsupported get request'));
      const out = await reconcileOne(deps(), v.id);
      expect(out.result).toBe('processing');
      expect(row(v.id).state).toBe('SCHEDULED');
    });

    it('a revoked token during VERIFY stops the run but keeps the video PROCESSING', async () => {
      const v = await video(500);
      fb.fail.status.push(graphError(190, 'Error validating access token'));
      const out = await publishOne(deps(), v.id, { kind: 'now' });
      expect(out).toMatchObject({ result: 'processing', stop: 'fatal' });
      expect(row(v.id).state).toBe('PROCESSING');
    });
  });

  describe('safety checks', () => {
    it('refuses to upload a file that changed since the scan', async () => {
      const v = await video(500);
      writeFileSync(v.filePath, randomBytes(500));
      expect(await publishOne(deps(), v.id, { kind: 'now' })).toMatchObject({
        result: 'skipped',
        message: expect.stringContaining('changed since scan'),
      });
      expect(fb.requests).toHaveLength(0);
      expect(row(v.id).state).toBe('READY');
    });

    it('skips videos leased by another run', async () => {
      const v = await video(500);
      claimVideo(h.db, v.id, 'other-run', new Date(clock), ['READY']);
      expect((await publishOne(deps(), v.id, { kind: 'now' })).result).toBe('skipped');
      expect(fb.requests).toHaveLength(0);
    });

    it('publishing twice never posts twice', async () => {
      const v = await video(500);
      await publishOne(deps(), v.id, { kind: 'now' });
      const again = await publishOne(deps(), v.id, { kind: 'now' });
      expect(again.result).toBe('skipped');
      expect(fb.starts()).toBe(1);
      expect(fb.finishes()).toBe(1);
    });

    it('reconcile turns a SCHEDULED Reel into PUBLISHED once it has gone live', async () => {
      const at = new Date(clock + 3_600_000);
      const v = await video(500, { action: 'SCHEDULE', scheduledAt: at.toISOString() });
      await publishOne(deps(), v.id, { kind: 'schedule', at });
      expect((await reconcileOne(deps(), v.id)).result).toBe('scheduled');
      fb.videos.get('R1')!.wants = 'published';
      clock += 2 * 3_600_000;
      expect((await reconcileOne(deps(), v.id)).result).toBe('published');
      expect(row(v.id).state).toBe('PUBLISHED');
    });
  });
});
