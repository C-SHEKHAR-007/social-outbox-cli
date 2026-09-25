import { recheckVideos, type RecheckSummary } from '../../media/recheck-service.js';
import type { AppContext } from '../context.js';

export function runRecheck(ctx: AppContext, opts: { dryRun?: boolean } = {}): RecheckSummary {
  return ctx.withDb((db) => {
    const reelMaxDurationS = ctx.config.publishing.reelMaxDurationS;
    const s = recheckVideos(db, { reelMaxDurationS }, opts);
    const p = ctx.print;
    p(`Rechecked ${s.checked} video(s) (Reel limit: ${reelMaxDurationS}s)${opts.dryRun ? ' (dry run)' : ''}`);
    p();
    p(`Reels:        ${String(s.byTarget.REEL.total).padStart(5)}  (${s.byTarget.REEL.specOk} pass specs)`);
    p(`Page videos:  ${String(s.byTarget.VIDEO.total).padStart(5)}  (${s.byTarget.VIDEO.specOk} pass specs)`);
    p();
    p(
      `${s.updated} record(s) ${opts.dryRun ? 'would be updated' : 'updated'}, ${s.targetChanged.length} changed target.`,
    );
    for (const c of s.targetChanged.slice(0, 10)) p(`  #${c.id} ${c.filename}: ${c.from} → ${c.to}`);
    if (s.targetChanged.length > 10) p(`  … and ${s.targetChanged.length - 10} more`);
    if (s.updated && !opts.dryRun) p('Note: CSVs exported before this are now stale; re-export before editing.');
    ctx.logger.info(
      { op: 'recheck', checked: s.checked, updated: s.updated, targetChanged: s.targetChanged.length },
      'recheck complete',
    );
    return s;
  });
}
