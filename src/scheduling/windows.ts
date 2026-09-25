import type { PublishTarget } from '../domain/states.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Meta rejects schedules less than 10 minutes ahead. */
export const MIN_SCHEDULE_LEAD_MS = 10 * 60 * 1000;
/** Furthest Meta schedules natively: Reels 29 days, Page videos 6 months (180 days to be safe). */
export const MAX_NATIVE_SCHEDULE_MS: Record<PublishTarget, number> = { REEL: 29 * DAY_MS, VIDEO: 180 * DAY_MS };

/** Largest number of timestamps inside any rolling window of `windowMs` (half-open), and where it starts. */
export function busiestWindow(times: readonly number[], windowMs = DAY_MS): { count: number; start: number } {
  const sorted = [...times].sort((a, b) => a - b);
  let best = { count: 0, start: 0 };
  let lo = 0;
  sorted.forEach((t, hi) => {
    while (t - (sorted[lo] ?? t) >= windowMs) lo++;
    if (hi - lo + 1 > best.count) best = { count: hi - lo + 1, start: sorted[lo] ?? t };
  });
  return best;
}
