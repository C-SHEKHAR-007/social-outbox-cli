import type { Action, PublishTarget } from '../domain/states.js';
import { MAX_NATIVE_SCHEDULE_MS, MIN_SCHEDULE_LEAD_MS } from '../scheduling/windows.js';

export type PublishDecision =
  | { kind: 'now' }
  | { kind: 'schedule'; at: Date }
  | { kind: 'draft' }
  | { kind: 'hold'; reason: string; until: Date | null }
  | { kind: 'skip'; reason: string };

export interface DecisionInput {
  action: Action | null;
  scheduledAt: string | null;
  publishTarget: PublishTarget;
}

export interface DecisionContext {
  now: Date;
  draft?: boolean;
  /** Remaining Reels API submissions in the rolling 24h window. */
  reelQuotaLeft: number;
  /** When the oldest counted Reel leaves the 24h window (for the hold time). */
  reelQuotaFreesAt?: Date | null;
  /** Remaining uploads of any kind in the rolling 24h window (DAILY_UPLOAD_LIMIT). */
  uploadsLeft?: number;
  uploadsFreeAt?: Date | null;
}

const HOUR = 60 * 60 * 1000;

/** Pure: what to do with one READY/HELD video right now (docs/plan.md §10.2). */
export function decidePublish(v: DecisionInput, ctx: DecisionContext): PublishDecision {
  const now = ctx.now.getTime();
  let decision: PublishDecision;
  if (ctx.draft) decision = { kind: 'draft' };
  else if (v.action === 'POST_NOW') decision = { kind: 'now' };
  else if (v.action === 'SCHEDULE') {
    if (!v.scheduledAt) return { kind: 'skip', reason: 'SCHEDULE without scheduled_at' };
    const at = Date.parse(v.scheduledAt);
    const window = MAX_NATIVE_SCHEDULE_MS[v.publishTarget];
    if (at < now + MIN_SCHEDULE_LEAD_MS)
      return { kind: 'skip', reason: 'scheduled_at is in the past or less than 10 minutes away' };
    if (at > now + window) {
      // Submit once it is comfortably inside Meta's window (one hour of slack).
      return { kind: 'hold', reason: 'beyond Facebook’s scheduling window', until: new Date(at - window + HOUR) };
    }
    decision = { kind: 'schedule', at: new Date(at) };
  } else return { kind: 'skip', reason: v.action === 'SKIP' ? 'action is SKIP' : 'no action set' };

  if (ctx.uploadsLeft !== undefined && ctx.uploadsLeft <= 0) {
    return { kind: 'hold', reason: 'daily upload limit reached', until: ctx.uploadsFreeAt ?? new Date(now + HOUR) };
  }
  if (v.publishTarget === 'REEL' && ctx.reelQuotaLeft <= 0) {
    return { kind: 'hold', reason: 'Reels 24h quota reached', until: ctx.reelQuotaFreesAt ?? new Date(now + HOUR) };
  }
  return decision;
}
