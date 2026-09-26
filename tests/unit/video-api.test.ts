import { describe, expect, it } from 'vitest';
import { classifyError, describeError, wasAnswered } from '../../src/facebook/errors.js';
import { FacebookApiError, GraphClient } from '../../src/facebook/graph-client.js';
import {
  getVideoStatus,
  pageVideoFinish,
  pageVideoStart,
  pageVideoTransfer,
  reelFinish,
  reelStart,
  reelTransfer,
} from '../../src/facebook/video-api.js';
import { fakeGraph } from '../fixtures/fake-graph.js';

const PAGE = '101';
const TOKEN = 'PAGE-TOKEN';
const client = (graph: ReturnType<typeof fakeGraph>) =>
  new GraphClient({ version: 'v26.0', appSecret: 's', fetch: graph.fetch });

describe('classifyError', () => {
  const api = (code: number | undefined, httpStatus: number | undefined, isTransient?: boolean) =>
    new FacebookApiError('x', { code, httpStatus, isTransient });
  it.each([
    [api(undefined, undefined), 'transient'], // network / timeout
    [api(190, 400), 'fatal'],
    [api(200, 403), 'fatal'],
    [api(230, 403), 'fatal'],
    [api(10, 403), 'fatal'],
    [api(368, 400), 'pause'],
    [api(613, 400), 'rate_limit'],
    [api(4, 400), 'rate_limit'],
    [api(32, 400), 'rate_limit'],
    [api(1, 500), 'transient'],
    [api(2, 503), 'transient'],
    [api(6000, 400), 'transient'],
    [api(100, 400, true), 'transient'],
    [api(undefined, 502), 'transient'],
    [api(100, 400), 'permanent'],
    [new Error('disk read failed'), 'transient'],
  ] as const)('%s → %s', (err, cls) => {
    expect(classifyError(err)).toBe(cls);
  });

  it('knows whether Facebook answered', () => {
    expect(wasAnswered(api(100, 400))).toBe(true);
    expect(wasAnswered(api(undefined, undefined))).toBe(false);
    expect(wasAnswered(new Error('x'))).toBe(false);
  });

  it('describes errors for logs', () => {
    expect(describeError(new FacebookApiError('Bad token', { code: 190, subcode: 463, httpStatus: 400 }))).toEqual({
      code: '190/463',
      message: 'Bad token',
    });
    expect(describeError(new Error('boom'))).toEqual({ code: null, message: 'boom' });
  });
});

describe('GraphClient POST', () => {
  it('sends form fields and the token in the body, not the URL', async () => {
    const graph = fakeGraph({ [`${PAGE}/video_reels`]: () => ({ body: { video_id: 'V1', upload_url: 'u' } }) });
    expect(await reelStart(client(graph), PAGE, TOKEN)).toEqual({ videoId: 'V1' });
    const req = graph.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.host).toBe('graph.facebook.com');
    expect(req.params).toMatchObject({ upload_phase: 'start', access_token: TOKEN });
    expect(req.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uploads Reel bytes to rupload with OAuth header, offset and file_size', async () => {
    const graph = fakeGraph({ 'video-upload/V1': () => ({ body: { success: true } }) });
    await reelTransfer(client(graph), 'V1', TOKEN, new Uint8Array(1000), 200, 1200);
    const req = graph.requests[0]!;
    expect(req.host).toBe('rupload.facebook.com');
    expect(req.headers).toMatchObject({ authorization: `OAuth ${TOKEN}`, offset: '200', file_size: '1200' });
    expect(req.bodyBytes).toBe(1000);
  });

  it('finishes a scheduled Reel with a Unix timestamp and optional fields', async () => {
    const graph = fakeGraph({ [`${PAGE}/video_reels`]: () => ({ body: { success: true, post_id: 'P9' } }) });
    const at = new Date('2026-10-01T14:30:00.000Z');
    const res = await reelFinish(client(graph), PAGE, TOKEN, {
      videoId: 'V1',
      state: 'SCHEDULED',
      description: 'Hi #a',
      scheduledAt: at,
      isAiGenerated: true,
    });
    expect(res).toEqual({ postId: 'P9' });
    expect(graph.requests[0]!.params).toMatchObject({
      upload_phase: 'finish',
      video_id: 'V1',
      video_state: 'SCHEDULED',
      description: 'Hi #a',
      scheduled_publish_time: String(at.getTime() / 1000),
      is_ai_generated: 'true',
    });
    expect(graph.requests[0]!.params.title).toBeUndefined();
  });

  it('runs the Page video chunked flow on graph-video with multipart chunks', async () => {
    const graph = fakeGraph({
      [`${PAGE}/videos`]: (p) => {
        if (p.upload_phase === 'start')
          return { body: { upload_session_id: 'S1', video_id: 'PV1', start_offset: '0', end_offset: '600' } };
        if (p.upload_phase === 'transfer') return { body: { start_offset: '600', end_offset: '1000' } };
        return { body: { success: true } };
      },
    });
    const c = client(graph);
    const started = await pageVideoStart(c, PAGE, TOKEN, 1000);
    expect(started).toEqual({ videoId: 'PV1', sessionId: 'S1', next: { start: 0, end: 600 } });
    expect(await pageVideoTransfer(c, PAGE, TOKEN, 'S1', 0, new Uint8Array(600))).toEqual({ start: 600, end: 1000 });
    await pageVideoFinish(c, PAGE, TOKEN, {
      sessionId: 'S1',
      mode: 'schedule',
      description: 'Long one',
      scheduledAt: new Date('2026-12-01T00:00:00Z'),
    });
    expect(graph.requests.every((r) => r.host === 'graph-video.facebook.com')).toBe(true);
    expect(graph.requests[1]!.params).toMatchObject({
      upload_phase: 'transfer',
      start_offset: '0',
      video_file_chunk: '<blob:600>',
    });
    expect(graph.requests[2]!.params).toMatchObject({
      published: 'false',
      unpublished_content_type: 'SCHEDULED',
      scheduled_publish_time: '1796083200',
    });
  });

  it('page video finish: now vs draft', async () => {
    const graph = fakeGraph({ [`${PAGE}/videos`]: () => ({ body: { success: true } }) });
    await pageVideoFinish(client(graph), PAGE, TOKEN, { sessionId: 'S', mode: 'now', description: 'd' });
    await pageVideoFinish(client(graph), PAGE, TOKEN, { sessionId: 'S', mode: 'draft', description: 'd' });
    expect(graph.requests.map((r) => [r.params.published, r.params.unpublished_content_type])).toEqual([
      ['true', undefined],
      ['false', 'DRAFT'],
    ]);
  });

  it('parses video status', async () => {
    const graph = fakeGraph({
      V1: () => ({
        body: {
          id: 'V1',
          permalink_url: '/reel/1',
          status: {
            video_status: 'ready',
            uploading_phase: { status: 'complete', bytes_transferred: 1200 },
            processing_phase: { status: 'complete' },
            publishing_phase: { status: 'complete', publish_status: 'published', publish_time: 1790000000 },
          },
        },
      }),
    });
    const s = await getVideoStatus(client(graph), 'V1', TOKEN);
    expect(s.status?.publishing_phase?.publish_status).toBe('published');
    expect(s.status?.uploading_phase?.bytes_transferred).toBe(1200);
    expect(graph.requests[0]!.params.fields).toBe('status,permalink_url,published');
  });

  it('surfaces network failures as unanswered errors', async () => {
    const graph = fakeGraph({ [`${PAGE}/video_reels`]: () => 'network-error' });
    const err = await reelStart(client(graph), PAGE, TOKEN).catch((e: unknown) => e);
    expect(wasAnswered(err)).toBe(false);
    expect(classifyError(err)).toBe('transient');
  });
});
