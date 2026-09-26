import { describe, expect, it } from 'vitest';
import { decidePublish, type DecisionInput } from '../../src/publisher/decision.js';
import { interpretStatus } from '../../src/publisher/remote-status.js';

const NOW = new Date('2026-09-27T06:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const reel = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  action: 'POST_NOW',
  scheduledAt: null,
  publishTarget: 'REEL',
  ...over,
});
const ctx = { now: NOW, reelQuotaLeft: 25 };

describe('decidePublish', () => {
  it('POST_NOW publishes now; draft overrides everything', () => {
    expect(decidePublish(reel(), ctx)).toEqual({ kind: 'now' });
    expect(decidePublish(reel({ action: 'SCHEDULE', scheduledAt: at(D) }), { ...ctx, draft: true })).toEqual({
      kind: 'draft',
    });
  });

  it('schedules natively inside the window: 29 days for Reels, 6 months for Page videos', () => {
    expect(decidePublish(reel({ action: 'SCHEDULE', scheduledAt: at(2 * H) }), ctx)).toEqual({
      kind: 'schedule',
      at: new Date(at(2 * H)),
    });
    expect(decidePublish(reel({ action: 'SCHEDULE', scheduledAt: at(28 * D) }), ctx).kind).toBe('schedule');
    const farReel = decidePublish(reel({ action: 'SCHEDULE', scheduledAt: at(40 * D) }), ctx);
    expect(farReel).toEqual({
      kind: 'hold',
      reason: 'beyond Facebook’s scheduling window',
      until: new Date(NOW.getTime() + 11 * D + H),
    });
    expect(decidePublish({ action: 'SCHEDULE', scheduledAt: at(40 * D), publishTarget: 'VIDEO' }, ctx).kind).toBe(
      'schedule',
    );
  });

  it('skips unpublishable rows', () => {
    expect(decidePublish(reel({ action: 'SCHEDULE', scheduledAt: at(5 * 60_000) }), ctx)).toMatchObject({
      kind: 'skip',
    });
    expect(decidePublish(reel({ action: 'SCHEDULE', scheduledAt: null }), ctx)).toMatchObject({ kind: 'skip' });
    expect(decidePublish(reel({ action: null }), ctx)).toEqual({ kind: 'skip', reason: 'no action set' });
    expect(decidePublish(reel({ action: 'SKIP' }), ctx)).toEqual({ kind: 'skip', reason: 'action is SKIP' });
  });

  it('holds Reels (not Page videos) when the quota is used up', () => {
    const frees = new Date(NOW.getTime() + 3 * H);
    expect(decidePublish(reel(), { ...ctx, reelQuotaLeft: 0, reelQuotaFreesAt: frees })).toEqual({
      kind: 'hold',
      reason: 'Reels 24h quota reached',
      until: frees,
    });
    expect(decidePublish({ ...reel(), publishTarget: 'VIDEO' }, { ...ctx, reelQuotaLeft: 0 })).toEqual({ kind: 'now' });
  });
});

describe('interpretStatus', () => {
  const s = (status: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ status, ...extra });

  it('published / scheduled / draft from publishing_phase', () => {
    expect(
      interpretStatus(
        s(
          {
            video_status: 'ready',
            publishing_phase: { status: 'complete', publish_status: 'published', publish_time: 1790000000 },
          },
          { permalink_url: '/reel/123' },
        ),
      ),
    ).toMatchObject({
      outcome: 'published',
      permalink: 'https://www.facebook.com/reel/123',
      publishTime: new Date(1790000000 * 1000),
    });
    expect(interpretStatus(s({ publishing_phase: { publish_status: 'scheduled' } })).outcome).toBe('scheduled');
    expect(interpretStatus(s({ publishing_phase: { publish_status: 'draft' } })).outcome).toBe('draft');
  });

  it('failures from processing errors or bad video_status', () => {
    expect(
      interpretStatus(
        s({
          processing_phase: {
            status: 'error',
            errors: [{ code: 1363, message: 'Reels duration must be between 3 and 90 seconds.' }],
          },
        }),
      ),
    ).toEqual({
      outcome: 'failed',
      message: 'Reels duration must be between 3 and 90 seconds.',
      permalink: undefined,
      bytesTransferred: undefined,
    });
    expect(interpretStatus(s({ video_status: 'expired' })).outcome).toBe('failed');
    expect(interpretStatus(s({ video_status: 'upload_failed' })).message).toBe(
      'Facebook reports video_status=upload_failed',
    );
  });

  it('distinguishes "uploaded, finish never applied" from processing', () => {
    expect(
      interpretStatus(
        s({
          video_status: 'upload_complete',
          uploading_phase: { status: 'complete' },
          processing_phase: { status: 'not_started' },
          publishing_phase: { status: 'not_started' },
        }),
      ),
    ).toMatchObject({ outcome: 'uploaded' });
    expect(
      interpretStatus(
        s({
          video_status: 'processing',
          uploading_phase: { status: 'complete' },
          processing_phase: { status: 'in_progress' },
        }),
      ).outcome,
    ).toBe('processing');
    expect(
      interpretStatus(
        s({ video_status: 'uploading', uploading_phase: { status: 'in_progress', bytes_transferred: 500 } }),
      ),
    ).toMatchObject({
      outcome: 'uploading',
      bytesTransferred: 500,
    });
  });

  it('Page videos: published flag and unpublished-but-processed', () => {
    expect(interpretStatus({ published: true, status: { video_status: 'ready' } }).outcome).toBe('published');
    expect(
      interpretStatus({ published: false, status: { video_status: 'ready', processing_phase: { status: 'complete' } } })
        .outcome,
    ).toBe('unpublished');
    expect(interpretStatus({}).outcome).toBe('processing');
  });
});
