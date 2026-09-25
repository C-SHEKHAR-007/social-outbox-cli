import { DateTime } from 'luxon';
import type { PublishTarget } from '../../domain/states.js';
import { TARGET_LABEL } from '../../media/publish-target.js';
import {
  applySchedulePlan,
  buildSchedulePlan,
  clearSchedules,
  findClearable,
  SCHEDULE_ORDERS,
  type ScheduleOrder,
  type SchedulePlan,
} from '../../scheduling/schedule-service.js';
import { parseSlots } from '../../scheduling/slots.js';
import { UserError } from '../../utils/errors.js';
import type { AppContext } from '../context.js';

export interface ScheduleCommandOptions {
  start?: string;
  reelSlots?: string;
  videoSlots?: string;
  order?: string;
  seed?: string;
  ids?: number[];
  target?: string;
  reset?: boolean;
  days?: string;
  limit?: string;
  clear?: boolean;
  apply?: boolean;
}

const PREVIEW_HEAD = 10;

export function runSchedule(ctx: AppContext, opts: ScheduleCommandOptions, now = new Date()): SchedulePlan | number {
  const tz = ctx.config.publishing.timezone;
  const targets = parseTarget(opts.target);
  return ctx.withDb((db) => {
    if (opts.clear) return runClear(ctx, db, { ids: opts.ids, targets, apply: !!opts.apply });

    const slots: Record<PublishTarget, string[]> = {
      REEL:
        opts.reelSlots !== undefined ? requireSlots(opts.reelSlots, '--reel-slots') : ctx.config.publishing.slots.REEL,
      VIDEO:
        opts.videoSlots !== undefined
          ? requireSlots(opts.videoSlots, '--video-slots')
          : ctx.config.publishing.slots.VIDEO,
    };
    const startDate = opts.start ?? DateTime.fromJSDate(now).setZone(tz).toFormat('yyyy-MM-dd');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !DateTime.fromISO(startDate, { zone: tz }).isValid) {
      throw new UserError(`Invalid --start: ${startDate} (use YYYY-MM-DD)`);
    }
    const order = (opts.order ?? 'filename') as ScheduleOrder;
    if (!SCHEDULE_ORDERS.includes(order))
      throw new UserError(`Invalid --order: ${order} (use ${SCHEDULE_ORDERS.join(', ')})`);

    const plan = buildSchedulePlan(db, {
      startDate,
      timezone: tz,
      now,
      slots,
      quotaPer24h: ctx.config.publishing.quotaPer24h,
      order,
      seed: positiveInt(opts.seed, '--seed'),
      ids: opts.ids,
      targets,
      reset: !!opts.reset,
      maxDays: positiveInt(opts.days, '--days'),
      limit: positiveInt(opts.limit, '--limit'),
    });
    render(ctx, plan, { startDate, slots, tz });

    ctx.print();
    if (!plan.rows.length) ctx.print('Nothing to schedule.');
    else if (!opts.apply) ctx.print('Preview only. Run again with --apply to save this plan.');
    else {
      const n = applySchedulePlan(db, plan);
      ctx.print(`Saved: ${n} video(s) scheduled. Review with \`reel-cli export\` or \`reel-cli status\`.`);
      ctx.logger.info({ op: 'schedule', count: n, startDate, slots, order }, 'schedule applied');
    }
    return plan;
  });
}

function runClear(
  ctx: AppContext,
  db: Parameters<typeof findClearable>[0],
  o: { ids?: number[]; targets?: PublishTarget[]; apply: boolean },
): number {
  const rows = findClearable(db, o);
  ctx.print(`${rows.length} scheduled video(s) (not yet submitted) would lose their schedule.`);
  if (!rows.length) return 0;
  if (!o.apply) {
    ctx.print('Preview only. Run again with --apply to clear.');
    return 0;
  }
  const n = clearSchedules(db, rows);
  ctx.print(`Cleared ${n} schedule(s); those videos are back to NEW.`);
  ctx.logger.info({ op: 'schedule-clear', count: n }, 'schedules cleared');
  return n;
}

function render(
  ctx: AppContext,
  plan: SchedulePlan,
  o: { startDate: string; slots: Record<PublishTarget, string[]>; tz: string },
): void {
  const p = ctx.print;
  const fmt = (d: Date) => DateTime.fromJSDate(d).setZone(o.tz).toFormat('yyyy-MM-dd HH:mm');
  p(`Schedule plan (${o.tz}), starting ${o.startDate}`);
  p();
  for (const target of ['REEL', 'VIDEO'] as const) {
    const rows = plan.rows.filter((r) => r.target === target);
    const label = `${TARGET_LABEL[target]}s:`.padEnd(13);
    const first = rows.at(0)?.at;
    const last = rows.at(-1)?.at;
    if (!first || !last) {
      p(`  ${label}   0`);
      continue;
    }
    const day = (d: Date) => DateTime.fromJSDate(d).setZone(o.tz).startOf('day');
    const days = Math.round(day(last).diff(day(first), 'days').days) + 1;
    p(
      `  ${label}${String(rows.length).padStart(4)}  at ${o.slots[target].join(', ')}  →  ${fmt(first)} … ${fmt(last)} (${days} days)`,
    );
  }

  const { specFailed, alreadyScheduled, postNow, limited } = plan.skipped;
  const notes: string[] = [];
  if (specFailed.length) {
    notes.push(
      `${specFailed.length} fail spec checks (fix, or set action SKIP): ${specFailed
        .slice(0, 8)
        .map((v) => `#${v.id}`)
        .join(' ')}${specFailed.length > 8 ? ' …' : ''}`,
    );
  }
  if (alreadyScheduled) notes.push(`${alreadyScheduled} already have a schedule (use --reset to re-plan them)`);
  if (postNow) notes.push(`${postNow} are set to POST_NOW`);
  if (limited) notes.push(`${limited} left out by --limit`);
  const byReason = new Map<string, number>();
  for (const u of plan.unassigned) {
    const key = `${TARGET_LABEL[u.target]}(s) ${u.reason}`;
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [reason, n] of byReason) notes.push(`${n} ${reason}`);
  if (notes.length) {
    p();
    p('Not scheduled:');
    for (const n of notes) p(`  ${n}`);
  }

  const held = plan.beyondNativeWindow;
  if (held.REEL || held.VIDEO) {
    p();
    if (held.REEL)
      p(
        `Note: ${held.REEL} Reel(s) are more than 29 days out; they stay local until \`reel-cli worker\` submits them.`,
      );
    if (held.VIDEO)
      p(
        `Note: ${held.VIDEO} Page video(s) are more than 6 months out; they stay local until \`reel-cli worker\` submits them.`,
      );
  }

  if (plan.rows.length) {
    p();
    const show =
      plan.rows.length <= PREVIEW_HEAD + 3
        ? plan.rows
        : [...plan.rows.slice(0, PREVIEW_HEAD), null, ...plan.rows.slice(-3)];
    for (const r of show) {
      if (!r) p('  …');
      else p(`  ${fmt(r.at)}  ${r.target.padEnd(5)}  #${r.id} ${r.filename}`);
    }
  }
}

function parseTarget(input: string | undefined): PublishTarget[] | undefined {
  if (!input || input.toLowerCase() === 'all') return undefined;
  const t = input.toUpperCase();
  if (t === 'REEL' || t === 'VIDEO') return [t];
  throw new UserError(`Invalid --target: ${input} (use reel, video or all)`);
}

function requireSlots(input: string, flag: string): string[] {
  const slots = parseSlots(input);
  if (slots === null) throw new UserError(`Invalid ${flag}: ${input} (use e.g. 09:00,14:00 or "none")`);
  return slots;
}

function positiveInt(input: string | undefined, flag: string): number | undefined {
  if (input === undefined) return undefined;
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) throw new UserError(`Invalid ${flag}: ${input} (must be a positive integer)`);
  return n;
}
