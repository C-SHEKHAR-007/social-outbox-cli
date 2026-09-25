import { isDeepStrictEqual } from 'node:util';
import { runInTransaction, type Db } from '../db/client.js';
import { videos } from '../db/schema.js';
import { updateVideo } from '../db/video-repository.js';
import type { PublishTarget } from '../domain/states.js';
import { isSubmitted } from '../domain/transitions.js';
import { checkSpecFor, chooseTarget, type TargetRules } from './publish-target.js';
import { hasSpecErrors } from './reel-spec.js';

export interface RecheckSummary {
  checked: number;
  updated: number;
  targetChanged: Array<{ id: number; filename: string; from: PublishTarget; to: PublishTarget }>;
  byTarget: Record<PublishTarget, { total: number; specOk: number }>;
}

/**
 * Recomputes publish target (unless pinned manually) and spec results from stored media info,
 * e.g. after REEL_MAX_DURATION_S changes or spec rules are updated. Submitted rows are untouched.
 */
export function recheckVideos(db: Db, rules: TargetRules, opts: { dryRun?: boolean } = {}): RecheckSummary {
  const summary: RecheckSummary = {
    checked: 0,
    updated: 0,
    targetChanged: [],
    byTarget: { REEL: { total: 0, specOk: 0 }, VIDEO: { total: 0, specOk: 0 } },
  };
  const run = () => {
    for (const v of db.select().from(videos).orderBy(videos.id).all()) {
      if (isSubmitted(v.state) || !v.mediaInfo) continue;
      summary.checked += 1;
      const target = v.targetSource === 'manual' ? v.publishTarget : chooseTarget(v.durationS, rules);
      const issues = checkSpecFor(target, v.mediaInfo, v.fileSize, rules);
      const specOk = !hasSpecErrors(issues);
      summary.byTarget[target].total += 1;
      if (specOk) summary.byTarget[target].specOk += 1;
      if (target === v.publishTarget && specOk === v.specOk && isDeepStrictEqual(issues, v.specIssues)) continue;
      if (target !== v.publishTarget)
        summary.targetChanged.push({ id: v.id, filename: v.filename, from: v.publishTarget, to: target });
      summary.updated += 1;
      if (!opts.dryRun) updateVideo(db, v.id, { publishTarget: target, specOk, specIssues: issues });
    }
  };
  if (opts.dryRun) run();
  else runInTransaction(db, run);
  return summary;
}
