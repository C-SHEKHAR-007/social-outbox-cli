import { DateTime } from 'luxon';
import { getStatusReport, type StatusReport } from '../../status/status-service.js';
import type { AppContext } from '../context.js';

export function runStatus(ctx: AppContext, now = new Date()): StatusReport {
  return ctx.withDb((db) => {
    const report = getStatusReport(db, {
      now,
      quotaLimit: ctx.config.publishing.quotaPer24h,
      uploadLimit: ctx.config.publishing.dailyUploadLimit,
    });
    render(report, ctx.config.publishing.timezone, ctx.print);
    ctx.logger.info({ op: 'status' }, 'status viewed');
    return report;
  });
}

function render(r: StatusReport, timezone: string, print: (line?: string) => void): void {
  const s = r.byState;
  const rows: Array<[string, number]> = [
    ['Total', r.total],
    ['New', s.NEW],
    ['Ready', s.READY],
    ['Held', s.HELD],
    ['In progress', s.UPLOADING + s.FINISHING + s.PROCESSING],
    ['Scheduled', s.SCHEDULED],
    ['Published', s.PUBLISHED],
    ['Drafts', s.DRAFT],
    ['Failed', s.FAILED],
    ['Skipped', s.SKIPPED],
  ];
  print('Facebook Reel Publisher');
  print('=======================');
  if (r.paused.paused) {
    print();
    print(`⚠ PUBLISHING PAUSED: ${r.paused.reason ?? 'unknown reason'}`);
  }
  print();
  for (const [label, n] of rows) print(`${`${label}:`.padEnd(13)}${String(n).padStart(5)}`);
  print();
  print(`Reels:        ${r.byTarget.REEL}   Page videos: ${r.byTarget.VIDEO}`);
  print(`Uploads (24h): ${r.uploads.used}/${r.uploads.limit} (all videos; DAILY_UPLOAD_LIMIT)`);
  print(`Reels quota:  ${r.quota.used}/${r.quota.limit} used (rolling 24h)`);

  if (r.upcoming.length) {
    print();
    print('Upcoming');
    print('-----------------------');
    for (const u of r.upcoming) {
      const when = DateTime.fromISO(u.scheduledAt).setZone(timezone).toFormat('yyyy-MM-dd HH:mm');
      print(`#${u.id}  ${u.filename}  ${when}  ${u.target}  (${u.state})`);
    }
  }
  if (r.failed.length) {
    print();
    print('Failed');
    print('-----------------------');
    for (const f of r.failed) print(`#${f.id}  ${f.filename}  ${f.error}`);
  }
}
