import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { runStatus } from '../../src/cli/commands/status.js';
import { createContext } from '../../src/cli/context.js';
import { setAppState } from '../../src/db/app-state.js';
import { videos, type NewVideo } from '../../src/db/schema.js';
import { UserError } from '../../src/utils/errors.js';
import { videoRow } from '../fixtures/factories.js';
import { collectOutput, makeTempDir } from '../helpers.js';

const video = (over: Partial<NewVideo>) => videoRow(over);

describe('status', () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
  });

  it('fails clearly when the workspace is not initialized', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const ctx = createContext({ cwd: tmp.dir, env: {}, print: () => {} });
    expect(() => runStatus(ctx)).toThrow(UserError);
  });

  it('counts states, quota, upcoming and failures', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    runInit(tmp.dir, () => {});
    const out = collectOutput();
    const ctx = createContext({ cwd: tmp.dir, env: { TIMEZONE: 'Asia/Kolkata' }, print: out.print });
    const now = new Date('2026-09-26T06:00:00.000Z');

    const h = ctx.openDb();
    h.db
      .insert(videos)
      .values([
        video({}),
        video({ state: 'READY', action: 'SCHEDULE', scheduledAt: '2026-09-27T13:00:00.000Z' }),
        video({
          state: 'SCHEDULED',
          action: 'SCHEDULE',
          scheduledAt: '2026-09-26T13:00:00.000Z',
          finishSentAt: '2026-09-26T05:00:00.000Z',
        }),
        video({ state: 'PUBLISHED', finishSentAt: '2026-09-25T07:00:00.000Z' }), // inside 24h window
        video({ state: 'PUBLISHED', finishSentAt: '2026-09-24T07:00:00.000Z' }), // outside
        video({ state: 'FAILED', lastError: 'Upload timeout' }),
      ])
      .run();
    setAppState(h.db, 'publishing_paused', 'true');
    setAppState(h.db, 'paused_reason', 'error 368');
    h.close();

    const report = runStatus(ctx, now);
    expect(report.total).toBe(6);
    expect(report.byState).toMatchObject({ NEW: 1, READY: 1, SCHEDULED: 1, PUBLISHED: 2, FAILED: 1 });
    expect(report.quota).toEqual({ used: 2, limit: 25 });
    expect(report.upcoming.map((u) => u.state)).toEqual(['SCHEDULED', 'READY']);
    expect(report.failed[0]?.error).toBe('Upload timeout');

    const text = out.text();
    expect(text).toContain('PUBLISHING PAUSED: error 368');
    expect(text).toContain('2026-09-26 18:30'); // 13:00Z shown in IST
    expect(text).toContain('Reels quota:  2/25 used');
    expect(report.byTarget).toEqual({ REEL: 6, VIDEO: 0 });
  });
});
