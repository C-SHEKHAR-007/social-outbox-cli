import { existsSync, statSync } from 'node:fs';
import { inArray } from 'drizzle-orm';
import type { AppConfig } from '../config/env.js';
import { isPublishingPaused } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import { videos, type Video } from '../db/schema.js';
import { buildDescription, DESCRIPTION_SOFT_LIMIT } from '../content/description.js';
import { MAX_HASHTAGS, parseHashtags } from '../content/hashtags.js';
import { isSubmitted } from '../domain/transitions.js';
import type { VideoState } from '../domain/states.js';
import { checkSpecFor, TARGET_LABEL } from '../media/publish-target.js';
import { looksUnchanged, sha256File } from '../scanner/file-identity.js';
import { quotaUsed } from '../scheduling/quota.js';
import { busiestWindow, MAX_NATIVE_SCHEDULE_MS, MIN_SCHEDULE_LEAD_MS } from '../scheduling/windows.js';

/** Rows validated by default: those the publisher would pick up. */
const DEFAULT_STATES: VideoState[] = ['READY', 'HELD'];

export interface VideoValidation {
  id: number;
  filename: string;
  errors: string[];
  warnings: string[];
}

export interface ValidationReport {
  videos: VideoValidation[];
  global: { errors: string[]; warnings: string[] };
  valid: number;
  invalid: number;
}

export interface ValidateOptions {
  config: AppConfig;
  now: Date;
  ids?: number[];
  hash?: (file: string) => Promise<string>;
  /** Whether a Page and token are available (browser login or .env). Defaults to checking .env only. */
  facebookConnected?: boolean;
}

export async function validateVideos(db: Db, opts: ValidateOptions): Promise<ValidationReport> {
  const rows = opts.ids?.length
    ? db.select().from(videos).where(inArray(videos.id, opts.ids)).orderBy(videos.id).all()
    : db.select().from(videos).where(inArray(videos.state, DEFAULT_STATES)).orderBy(videos.id).all();

  const results: VideoValidation[] = [];
  for (const v of rows) results.push(await validateVideo(v, opts));

  if (opts.ids?.length) {
    const found = new Set(rows.map((r) => r.id));
    for (const id of opts.ids.filter((i) => !found.has(i))) {
      results.push({ id, filename: '?', errors: [`Unknown id ${id}`], warnings: [] });
    }
  }

  const global = globalChecks(db, rows, opts);
  const invalid = results.filter((r) => r.errors.length).length;
  return { videos: results, global, valid: results.length - invalid, invalid };
}

export async function validateVideo(v: Video, opts: ValidateOptions): Promise<VideoValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = { id: v.id, filename: v.filename, errors, warnings };

  if (isSubmitted(v.state)) {
    errors.push(`already submitted to Facebook (state ${v.state})`);
    return result;
  }
  if (v.state === 'SKIPPED' || v.action === 'SKIP') {
    warnings.push('skipped; will not be published');
    return result;
  }
  if (v.state === 'FAILED') errors.push('failed earlier; run `reel-cli retry` first');
  if (!v.action) errors.push('no action set (POST_NOW or SCHEDULE)');

  await checkFile(v, opts, errors);

  const rules = { reelMaxDurationS: opts.config.publishing.reelMaxDurationS };
  const spec = v.mediaInfo ? checkSpecFor(v.publishTarget, v.mediaInfo, v.fileSize, rules) : (v.specIssues ?? []);
  if (!v.mediaInfo && !v.specIssues) errors.push('no media metadata; rescan the folder');
  for (const issue of spec) (issue.level === 'error' ? errors : warnings).push(`spec: ${issue.message}`);

  if (!v.caption?.trim()) errors.push('caption is empty');
  const tags = v.hashtags ?? [];
  const { invalid } = parseHashtags(tags.join(' '));
  if (invalid.length) errors.push(`invalid hashtag(s): ${invalid.join(' ')}`);
  if (tags.length === 0) warnings.push('no hashtags');
  if (tags.length > MAX_HASHTAGS) errors.push(`too many hashtags (${tags.length} > ${MAX_HASHTAGS})`);
  const description = buildDescription(v.caption, tags);
  if (description.length > DESCRIPTION_SOFT_LIMIT) {
    warnings.push(
      `description is ${description.length} chars (> ${DESCRIPTION_SOFT_LIMIT}; Meta's exact limit is unverified)`,
    );
  }

  if (v.action === 'SCHEDULE') {
    if (!v.scheduledAt) errors.push('scheduled_at is required for SCHEDULE');
    else {
      const at = Date.parse(v.scheduledAt);
      const now = opts.now.getTime();
      if (at < now + MIN_SCHEDULE_LEAD_MS) errors.push('scheduled_at must be at least 10 minutes in the future');
      else if (at > now + MAX_NATIVE_SCHEDULE_MS[v.publishTarget]) {
        const limit = v.publishTarget === 'REEL' ? '29 days' : '6 months';
        warnings.push(
          `scheduled more than ${limit} ahead (${TARGET_LABEL[v.publishTarget]} limit): held locally, needs \`reel-cli worker\` to hand it to Facebook`,
        );
      }
    }
  }
  return result;
}

async function checkFile(v: Video, opts: ValidateOptions, errors: string[]): Promise<void> {
  if (!existsSync(v.filePath)) {
    errors.push(`file does not exist: ${v.filePath}`);
    return;
  }
  const st = statSync(v.filePath);
  if (!looksUnchanged(st, v)) {
    const hash = await (opts.hash ?? sha256File)(v.filePath);
    if (hash !== v.fileHash) errors.push('file content changed since scan (hash mismatch); rescan the folder');
  }
  if (v.normalizedPath && !existsSync(v.normalizedPath)) errors.push(`normalized file missing: ${v.normalizedPath}`);
}

function globalChecks(db: Db, rows: Video[], opts: ValidateOptions): ValidationReport['global'] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { config, now } = opts;

  if (isPublishingPaused(db)) errors.push('publishing is paused; review the cause, then run `reel-cli resume`');
  const connected = opts.facebookConnected ?? Boolean(config.facebook.pageAccessToken && config.facebook.pageId);
  if (!connected) {
    warnings.push('No Facebook Page connected (`reel-cli facebook login`); needed before `publish`');
  }

  const quota = config.publishing.quotaPer24h;
  const used = quotaUsed(db, now);
  const toSubmit = rows.filter(
    (r) => r.publishTarget === 'REEL' && (r.action === 'POST_NOW' || r.action === 'SCHEDULE'),
  ).length;
  const remaining = Math.max(0, quota - used);
  if (toSubmit > remaining) {
    warnings.push(
      `${toSubmit} Reel(s) to submit but only ${remaining} of ${quota} left in the 24h Reels quota; the rest will be held and submitted later`,
    );
  }

  const busiest = busiestWindow(
    rows
      .filter((r) => r.publishTarget === 'REEL' && r.action === 'SCHEDULE' && r.scheduledAt)
      .map((r) => Date.parse(r.scheduledAt as string)),
  );
  if (busiest.count > quota) {
    warnings.push(
      `${busiest.count} Reels scheduled within 24h from ${new Date(busiest.start).toISOString()} (quota ${quota})`,
    );
  }
  return { errors, warnings };
}
