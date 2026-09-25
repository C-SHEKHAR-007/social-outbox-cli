import { and, inArray, isNotNull } from 'drizzle-orm';
import { runInTransaction, type Db } from '../db/client.js';
import { videos, type Video } from '../db/schema.js';
import { updateVideoIfVersion } from '../db/video-repository.js';
import type { PublishTarget, VideoState } from '../domain/states.js';
import { stateAfterActionChange } from '../domain/transitions.js';
import { UserError } from '../utils/errors.js';
import { toIso } from '../utils/time.js';
import { planSchedule, type Assignment } from './planner.js';
import { MAX_NATIVE_SCHEDULE_MS } from './windows.js';

export const SCHEDULE_ORDERS = ['filename', 'id', 'duration', 'random'] as const;
export type ScheduleOrder = (typeof SCHEDULE_ORDERS)[number];

/** Rows the planner may (re)schedule. */
const PLANNABLE_STATES: VideoState[] = ['NEW', 'READY', 'HELD'];

export interface ScheduleOptions {
  startDate: string;
  timezone: string;
  now: Date;
  slots: Record<PublishTarget, string[]>;
  quotaPer24h: number;
  order?: ScheduleOrder;
  seed?: number;
  ids?: number[];
  targets?: PublishTarget[];
  reset?: boolean;
  maxDays?: number;
  limit?: number;
}

export interface PlannedRow extends Assignment {
  filename: string;
  version: number;
  state: VideoState;
}

export interface SchedulePlan {
  rows: PlannedRow[];
  unassigned: Array<{ id: number; filename: string; target: PublishTarget; reason: string }>;
  skipped: {
    specFailed: Video[];
    alreadyScheduled: number;
    postNow: number;
    limited: number;
  };
  beyondNativeWindow: Record<PublishTarget, number>;
}

export function buildSchedulePlan(db: Db, opts: ScheduleOptions): SchedulePlan {
  const all = db.select().from(videos).all();
  const inScope = (v: Video) =>
    PLANNABLE_STATES.includes(v.state) &&
    v.action !== 'SKIP' &&
    (!opts.ids || opts.ids.includes(v.id)) &&
    (!opts.targets || opts.targets.includes(v.publishTarget));

  const skipped: SchedulePlan['skipped'] = { specFailed: [], alreadyScheduled: 0, postNow: 0, limited: 0 };
  let candidates: Video[] = [];
  for (const v of all.filter(inScope)) {
    if (v.action === 'POST_NOW') skipped.postNow += 1;
    else if (v.scheduledAt && !opts.reset) skipped.alreadyScheduled += 1;
    else if (v.specOk !== true) skipped.specFailed.push(v);
    else candidates.push(v);
  }
  candidates = sortCandidates(candidates, opts.order ?? 'filename', opts.seed ?? 1);
  if (opts.limit !== undefined) {
    const kept: Video[] = [];
    const perTarget: Record<PublishTarget, number> = { REEL: 0, VIDEO: 0 };
    for (const c of candidates) {
      if (perTarget[c.publishTarget] < opts.limit) {
        kept.push(c);
        perTarget[c.publishTarget] += 1;
      } else skipped.limited += 1;
    }
    candidates = kept;
  }

  const candidateIds = new Set(candidates.map((c) => c.id));
  const occupied = all
    .filter(
      (v) =>
        !candidateIds.has(v.id) &&
        v.scheduledAt &&
        v.state !== 'SKIPPED' &&
        v.state !== 'FAILED' &&
        v.action !== 'SKIP',
    )
    .map((v) => ({ target: v.publishTarget, at: Date.parse(v.scheduledAt as string) }));

  const result = planSchedule({
    candidates: candidates.map((c) => ({ id: c.id, target: c.publishTarget })),
    occupied,
    slots: opts.slots,
    startDate: opts.startDate,
    timezone: opts.timezone,
    now: opts.now,
    quotaPer24h: opts.quotaPer24h,
    maxDays: opts.maxDays,
  });

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rows = result.assignments
    .map((a) => {
      const v = byId.get(a.id) as Video;
      return { ...a, filename: v.filename, version: v.version, state: v.state };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);

  const beyondNativeWindow: Record<PublishTarget, number> = { REEL: 0, VIDEO: 0 };
  for (const r of rows)
    if (r.at.getTime() > opts.now.getTime() + MAX_NATIVE_SCHEDULE_MS[r.target]) beyondNativeWindow[r.target] += 1;

  return {
    rows,
    unassigned: result.unassigned.map((u) => ({ ...u, filename: byId.get(u.id)?.filename ?? '?' })),
    skipped,
    beyondNativeWindow,
  };
}

/** Saves the plan in one transaction; aborts entirely if any row changed since planning. */
export function applySchedulePlan(db: Db, plan: SchedulePlan): number {
  runInTransaction(db, (tx) => {
    for (const r of plan.rows) {
      const ok = updateVideoIfVersion(tx, r.id, r.version, {
        action: 'SCHEDULE',
        scheduledAt: toIso(r.at),
        state: stateAfterActionChange(r.state, 'SCHEDULE'),
      });
      if (!ok)
        throw new UserError(`#${r.id} ${r.filename} changed while planning; nothing was saved. Run the command again.`);
    }
  });
  return plan.rows.length;
}

/** Rows whose SCHEDULE would be removed by `schedule --clear`. */
export function findClearable(db: Db, opts: { ids?: number[]; targets?: PublishTarget[] }): Video[] {
  return db
    .select()
    .from(videos)
    .where(and(inArray(videos.state, PLANNABLE_STATES), isNotNull(videos.scheduledAt)))
    .all()
    .filter(
      (v) =>
        v.action === 'SCHEDULE' &&
        (!opts.ids || opts.ids.includes(v.id)) &&
        (!opts.targets || opts.targets.includes(v.publishTarget)),
    );
}

export function clearSchedules(db: Db, rows: Video[]): number {
  runInTransaction(db, (tx) => {
    for (const v of rows) {
      const ok = updateVideoIfVersion(tx, v.id, v.version, {
        action: null,
        scheduledAt: null,
        state: stateAfterActionChange(v.state, null),
      });
      if (!ok)
        throw new UserError(`#${v.id} ${v.filename} changed meanwhile; nothing was cleared. Run the command again.`);
    }
  });
  return rows.length;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function sortCandidates(rows: Video[], order: ScheduleOrder, seed: number): Video[] {
  const copy = [...rows];
  switch (order) {
    case 'filename':
      return copy.sort((a, b) => collator.compare(a.filename, b.filename) || a.id - b.id);
    case 'id':
      return copy.sort((a, b) => a.id - b.id);
    case 'duration':
      return copy.sort((a, b) => (a.durationS ?? 0) - (b.durationS ?? 0) || a.id - b.id);
    case 'random':
      return shuffle(
        copy.sort((a, b) => a.id - b.id),
        seed,
      );
  }
}

/** Deterministic Fisher–Yates (mulberry32) so a seeded plan is reproducible. */
function shuffle<T>(items: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}
