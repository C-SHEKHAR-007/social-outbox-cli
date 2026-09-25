import { DateTime } from 'luxon';
import type { PublishTarget } from '../domain/states.js';
import { busiestWindow, DAY_MS, MIN_SCHEDULE_LEAD_MS } from './windows.js';

export interface PlanCandidate {
  id: number;
  target: PublishTarget;
}

export interface PlanInput {
  /** Already in the desired publishing order. */
  candidates: PlanCandidate[];
  /** Times already taken by other rows (epoch ms), per target. */
  occupied: Array<{ target: PublishTarget; at: number }>;
  slots: Record<PublishTarget, string[]>;
  startDate: string; // yyyy-MM-dd, in `timezone`
  timezone: string;
  now: Date;
  quotaPer24h: number;
  maxDays?: number;
}

export interface Assignment {
  id: number;
  target: PublishTarget;
  at: Date;
}

export interface PlanResult {
  assignments: Assignment[];
  unassigned: Array<{ id: number; target: PublishTarget; reason: string }>;
}

const SAFETY_MAX_DAYS = 3650;

/**
 * Pure slot planner: fills each target's daily slots in order, skipping slots that are too soon,
 * already taken, or would put more than `quotaPer24h` Reels into any rolling 24h window.
 */
export function planSchedule(input: PlanInput): PlanResult {
  const result: PlanResult = { assignments: [], unassigned: [] };
  const start = DateTime.fromISO(input.startDate, { zone: input.timezone });
  if (!start.isValid) throw new Error(`invalid start date: ${input.startDate}`);
  const earliest = input.now.getTime() + MIN_SCHEDULE_LEAD_MS;
  const maxDays = Math.min(input.maxDays ?? SAFETY_MAX_DAYS, SAFETY_MAX_DAYS);

  for (const target of ['REEL', 'VIDEO'] as const) {
    const queue = input.candidates.filter((c) => c.target === target);
    if (!queue.length) continue;
    const slots = input.slots[target];
    if (!slots.length) {
      for (const c of queue) result.unassigned.push({ id: c.id, target, reason: 'no posting slots configured' });
      continue;
    }
    const taken = new Set(input.occupied.filter((o) => o.target === target).map((o) => o.at));
    const reelTimes = target === 'REEL' ? input.occupied.filter((o) => o.target === 'REEL').map((o) => o.at) : [];

    let next = 0;
    for (let day = 0; day < maxDays && next < queue.length; day++) {
      const date = start.plus({ days: day });
      for (const slot of slots) {
        if (next >= queue.length) break;
        const [hour, minute] = slot.split(':').map(Number);
        const at = date.set({ hour, minute, second: 0, millisecond: 0 }).toMillis();
        if (at < earliest || taken.has(at)) continue;
        if (target === 'REEL' && wouldExceedQuota(reelTimes, at, input.quotaPer24h)) continue;
        const c = queue[next++] as PlanCandidate;
        result.assignments.push({ id: c.id, target, at: new Date(at) });
        taken.add(at);
        if (target === 'REEL') reelTimes.push(at);
      }
    }
    for (const c of queue.slice(next))
      result.unassigned.push({ id: c.id, target, reason: `beyond the ${maxDays}-day planning horizon` });
  }
  return result;
}

/** True if adding `at` would put more than `quota` items into some 24h window containing it. */
function wouldExceedQuota(times: readonly number[], at: number, quota: number): boolean {
  const near = times.filter((t) => Math.abs(t - at) < DAY_MS);
  return busiestWindow([...near, at]).count > quota;
}
