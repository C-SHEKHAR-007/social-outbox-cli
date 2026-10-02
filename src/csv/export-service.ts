import { stringify } from 'csv-stringify/sync';
import type { Db } from '../db/client.js';
import { listPosts } from '../db/platform-post-repository.js';
import type { PlatformPost, Video } from '../db/schema.js';
import { listVideos } from '../db/video-repository.js';
import { formatHashtags } from '../content/hashtags.js';
import { formatLocal } from '../utils/dates.js';
import { CSV_COLUMNS, formatBool, type CsvColumn } from './columns.js';

const BOM = '﻿';

export function videoToCsvRow(v: Video, timezone: string, ig?: PlatformPost): Record<CsvColumn, string> {
  return {
    id: String(v.id),
    version: String(v.version),
    filename: v.filename,
    duration_s: v.durationS === null ? '' : v.durationS.toFixed(1),
    spec_ok: formatBool(v.specOk),
    state: v.state,
    publish_target: v.publishTarget,
    caption: v.caption ?? '',
    hashtags: formatHashtags(v.hashtags),
    title: v.title ?? '',
    action: v.action ?? '',
    scheduled_at: formatLocal(v.scheduledAt, timezone),
    is_ai_generated: formatBool(v.isAiGenerated),
    last_error: v.lastError ?? '',
    ig_action: ig?.action ?? '',
    ig_scheduled_at: formatLocal(ig?.scheduledAt, timezone),
    ig_state: ig?.state ?? '',
  };
}

/** UTF-8 with BOM so spreadsheet apps show Hindi/emoji correctly. */
export function renderCsv(
  rows: Video[],
  timezone: string,
  instagram: ReadonlyMap<number, PlatformPost> = new Map(),
): string {
  return (
    BOM +
    stringify(
      rows.map((v) => videoToCsvRow(v, timezone, instagram.get(v.id))),
      { header: true, columns: [...CSV_COLUMNS], quoted_string: true, record_delimiter: 'windows' },
    )
  );
}

export function exportVideos(
  db: Db,
  opts: { timezone: string; includePublished?: boolean },
): { csv: string; count: number } {
  const rows = listVideos(db, { includePublished: opts.includePublished ?? false });
  const instagram = new Map(listPosts(db, 'instagram').map((p) => [p.videoId, p]));
  return { csv: renderCsv(rows, opts.timezone, instagram), count: rows.length };
}
