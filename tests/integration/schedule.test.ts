import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { videos, type NewVideo } from '../../src/db/schema.js';
import { updateVideo } from '../../src/db/video-repository.js';
import {
  applySchedulePlan,
  buildSchedulePlan,
  clearSchedules,
  findClearable,
  type ScheduleOptions,
} from '../../src/scheduling/schedule-service.js';
import { videoRow } from '../fixtures/factories.js';

const NOW = new Date('2026-09-26T06:30:00.000Z');
const base: ScheduleOptions = {
  startDate: '2026-09-27',
  timezone: 'Asia/Kolkata',
  now: NOW,
  slots: { REEL: ['09:00', '20:00'], VIDEO: ['12:00'] },
  quotaPer24h: 25,
};

describe('schedule service', () => {
  let h: DbHandle;
  beforeEach(() => {
    h = openDatabase(':memory:');
  });
  afterEach(() => {
    h.close();
  });

  const insert = (over: Partial<NewVideo> = {}) => {
    return h.db.insert(videos).values(videoRow(over)).returning().get();
  };
  const get = (id: number) => h.db.select().from(videos).where(eq(videos.id, id)).get()!;

  it('plans only eligible rows and reports why others were skipped', () => {
    const ok = insert({ filename: 'Video_10.mp4' });
    const ok2 = insert({ filename: 'Video_9.mp4' });
    insert({ specOk: false });
    insert({ action: 'POST_NOW', state: 'READY' });
    insert({ action: 'SCHEDULE', state: 'READY', scheduledAt: '2026-10-01T03:30:00.000Z' });
    insert({ action: 'SKIP', state: 'SKIPPED' });
    insert({ state: 'PUBLISHED' });
    insert({ state: 'FAILED' });
    const plan = buildSchedulePlan(h.db, base);
    // natural filename order: Video_9 before Video_10
    expect(plan.rows.map((r) => r.id)).toEqual([ok2.id, ok.id]);
    expect(plan.skipped).toMatchObject({ alreadyScheduled: 1, postNow: 1, limited: 0 });
    expect(plan.skipped.specFailed).toHaveLength(1);
  });

  it('applies: sets SCHEDULE, scheduled_at and READY, bumps version', () => {
    const v = insert();
    applySchedulePlan(h.db, buildSchedulePlan(h.db, base));
    expect(get(v.id)).toMatchObject({
      action: 'SCHEDULE',
      scheduledAt: '2026-09-27T03:30:00.000Z',
      state: 'READY',
      version: 2,
    });
  });

  it('is idempotent: a second run schedules nothing and does not reuse taken slots with --reset off', () => {
    insert();
    applySchedulePlan(h.db, buildSchedulePlan(h.db, base));
    const again = buildSchedulePlan(h.db, base);
    expect(again.rows).toEqual([]);
    expect(again.skipped.alreadyScheduled).toBe(1);

    insert();
    const next = buildSchedulePlan(h.db, base);
    expect(next.rows[0]?.at.toISOString()).toBe('2026-09-27T14:30:00.000Z'); // 20:00 IST, 09:00 is taken
  });

  it('--reset re-plans existing schedules from the new start date', () => {
    const v = insert({ action: 'SCHEDULE', state: 'READY', scheduledAt: '2026-12-01T03:30:00.000Z' });
    const plan = buildSchedulePlan(h.db, { ...base, reset: true });
    expect(plan.rows.map((r) => [r.id, r.at.toISOString()])).toEqual([[v.id, '2026-09-27T03:30:00.000Z']]);
  });

  it('respects --target, --ids and --limit', () => {
    const r1 = insert();
    const r2 = insert();
    const long = insert({ publishTarget: 'VIDEO', durationS: 400 });
    expect(buildSchedulePlan(h.db, { ...base, targets: ['VIDEO'] }).rows.map((r) => r.id)).toEqual([long.id]);
    expect(buildSchedulePlan(h.db, { ...base, ids: [r2.id] }).rows.map((r) => r.id)).toEqual([r2.id]);
    const limited = buildSchedulePlan(h.db, { ...base, limit: 1 });
    expect(limited.rows.map((r) => r.id).sort()).toEqual([r1.id, long.id].sort());
    expect(limited.skipped.limited).toBe(1);
  });

  it('random order is reproducible with a seed', () => {
    for (let i = 0; i < 10; i++) insert();
    const a = buildSchedulePlan(h.db, { ...base, order: 'random', seed: 42 }).rows.map((r) => r.id);
    const b = buildSchedulePlan(h.db, { ...base, order: 'random', seed: 42 }).rows.map((r) => r.id);
    const c = buildSchedulePlan(h.db, { ...base, order: 'random', seed: 7 }).rows.map((r) => r.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('flags items beyond the native scheduling window', () => {
    for (let i = 0; i < 70; i++) insert(); // 2 reels/day → 35 days
    const plan = buildSchedulePlan(h.db, base);
    expect(plan.beyondNativeWindow.REEL).toBeGreaterThan(0);
    expect(plan.beyondNativeWindow.VIDEO).toBe(0);
  });

  it('aborts the whole apply if a row changed after planning', () => {
    const a = insert();
    const b = insert();
    const plan = buildSchedulePlan(h.db, base);
    updateVideo(h.db, b.id, { caption: 'edited meanwhile' });
    expect(() => applySchedulePlan(h.db, plan)).toThrow(/changed while planning/);
    expect(get(a.id).scheduledAt).toBeNull();
  });

  it('--clear removes schedules from unsubmitted rows only', () => {
    const a = insert({ action: 'SCHEDULE', state: 'READY', scheduledAt: '2026-10-01T03:30:00.000Z' });
    insert({ action: 'SCHEDULE', state: 'SCHEDULED', scheduledAt: '2026-10-01T08:30:00.000Z' });
    insert({ action: 'POST_NOW', state: 'READY' });
    const rows = findClearable(h.db, {});
    expect(rows.map((r) => r.id)).toEqual([a.id]);
    clearSchedules(h.db, rows);
    expect(get(a.id)).toMatchObject({ action: null, scheduledAt: null, state: 'NEW' });
  });
});
