import { and, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { findPost, insertPost, updatePost } from '../db/platform-post-repository.js';
import { videos, type Video } from '../db/schema.js';
import { runInTransaction } from '../db/client.js';
import { instagramBlockers } from '../media/instagram-spec.js';
import { toIso } from '../utils/time.js';

export interface PlanFromFacebookOptions {
  now: Date;
  offsetMinutes: number;
  ids?: number[];
  apply?: boolean;
}

export interface PlannedInstagramPost {
  video: Video;
  at: Date;
  /** created = new Instagram post; updated = existing unsent one re-timed */
  change: 'created' | 'updated' | 'unchanged';
}

export interface PlanFromFacebookReport {
  planned: PlannedInstagramPost[];
  skipped: Array<{ video: Video; reason: string }>;
}

/** Facebook states whose video still has a Facebook post coming (or just made) to mirror. */
const MIRRORABLE: Array<Video['state']> = ['READY', 'HELD', 'UPLOADING', 'FINISHING', 'PROCESSING', 'SCHEDULED'];

/**
 * Gives Instagram the same videos and times as Facebook (shifted by `offsetMinutes`). Only future
 * Facebook times are mirrored; videos Instagram can't take (> 15 min) are reported, and Instagram
 * posts already sent to Instagram are never changed.
 */
export function planInstagramFromFacebook(db: Db, opts: PlanFromFacebookOptions): PlanFromFacebookReport {
  const report: PlanFromFacebookReport = { planned: [], skipped: [] };
  const rows = db
    .select()
    .from(videos)
    .where(and(inArray(videos.state, MIRRORABLE), inArray(videos.action, ['SCHEDULE'])))
    .all()
    .filter((v) => !opts.ids || opts.ids.includes(v.id))
    .sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));

  for (const v of rows) {
    if (!v.scheduledAt) continue;
    const at = new Date(Date.parse(v.scheduledAt) + opts.offsetMinutes * 60_000);
    if (at.getTime() <= opts.now.getTime() + 10 * 60_000) {
      report.skipped.push({ video: v, reason: 'Facebook time already passed' });
      continue;
    }
    const blockers = v.mediaInfo ? instagramBlockers(v.mediaInfo, v.fileSize) : ['no metadata'];
    if (blockers.length) {
      report.skipped.push({ video: v, reason: blockers.join('; ') });
      continue;
    }
    const existing = findPost(db, v.id, 'instagram');
    if (existing && !['NEW', 'READY', 'HELD', 'SKIPPED'].includes(existing.state)) {
      report.skipped.push({ video: v, reason: `already on Instagram (${existing.state})` });
      continue;
    }
    const same = existing?.action === 'SCHEDULE' && existing.scheduledAt === toIso(at) && existing.state === 'READY';
    report.planned.push({ video: v, at, change: !existing ? 'created' : same ? 'unchanged' : 'updated' });
  }

  if (opts.apply) {
    runInTransaction(db, (tx) => {
      for (const p of report.planned) {
        if (p.change === 'unchanged') continue;
        const existing = findPost(tx, p.video.id, 'instagram');
        const values = {
          action: 'SCHEDULE' as const,
          scheduledAt: toIso(p.at),
          state: 'READY' as const,
          lastError: null,
        };
        if (existing) updatePost(tx, existing.id, values);
        else insertPost(tx, { videoId: p.video.id, platform: 'instagram', ...values });
      }
    });
  }
  return report;
}
