import { parse } from 'csv-parse/sync';
import { isDeepStrictEqual } from 'node:util';
import { runInTransaction, type Db } from '../db/client.js';
import type { NewVideo, Video } from '../db/schema.js';
import { findVideoById, updateVideoIfVersion } from '../db/video-repository.js';
import { MAX_HASHTAGS, parseHashtags } from '../content/hashtags.js';
import { ACTIONS, PUBLISH_TARGETS, type Action, type PublishTarget, type VideoState } from '../domain/states.js';
import { chooseTarget } from '../media/publish-target.js';
import { isSubmitted, stateAfterActionChange } from '../domain/transitions.js';
import { parseUserDateTime } from '../utils/dates.js';
import { UserError } from '../utils/errors.js';
import { toIso } from '../utils/time.js';
import { CSV_COLUMNS, INSTAGRAM_COLUMNS, parseBool, REQUIRED_COLUMNS, type CsvRow } from './columns.js';
import { findPost, insertPost, updatePostIfVersion } from '../db/platform-post-repository.js';
import { isPostSubmitted, type PostState } from '../domain/platforms.js';
import { instagramBlockers } from '../media/instagram-spec.js';

/** States where `--force` may override a version conflict. */
const FORCEABLE_STATES: readonly VideoState[] = ['NEW', 'READY', 'FAILED', 'SKIPPED'];
const MIN_LEAD_MS = 10 * 60 * 1000;

export interface RowRef {
  row: number; // spreadsheet row number (header = 1)
  id: number | null;
  filename: string | null;
}

export interface RowChange extends RowRef {
  id: number;
  expectedVersion: number;
  fields: string[];
  values: Partial<NewVideo>;
  fromState: VideoState;
  toState: VideoState;
}

/** A change to a video's Instagram post (create, re-time, skip or clear). */
export interface InstagramChange extends RowRef {
  videoId: number;
  postId: number | undefined;
  expectedVersion: number | undefined;
  values: { action: Action | null; scheduledAt: string | null; state: PostState };
}

export interface ImportPlan {
  total: number;
  changes: RowChange[];
  /** Instagram changes (only when the CSV has the ig_* columns). */
  igChanges: InstagramChange[];
  unchanged: number;
  errors: Array<RowRef & { messages: string[] }>;
  warnings: Array<RowRef & { message: string }>;
}

export interface ImportOptions {
  timezone: string;
  now: Date;
  force?: boolean;
  reelMaxDurationS?: number;
}

interface ParsedRow {
  /** null = automatic (by duration) */
  publishTarget: PublishTarget | null;
  caption: string | null;
  hashtags: string[];
  title: string | null;
  action: Action | null;
  scheduledAt: string | null;
  isAiGenerated: boolean;
}

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  let header: string[] = [];
  let records: CsvRow[];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      columns: (h: string[]) => {
        header = h.map((c) => c.trim().toLowerCase());
        return header;
      },
    });
  } catch (err) {
    throw new UserError(`Could not parse CSV: ${(err as Error).message}`);
  }
  return { header, rows: records };
}

const clean = (v: string | undefined): string => (v ?? '').replace(/\r\n?/g, '\n').trim();
const orNull = (v: string): string | null => (v === '' ? null : v);

/** Reads the CSV and works out every change without writing anything. */
export function planImport(db: Db, text: string, opts: ImportOptions): ImportPlan {
  const { header, rows } = parseCsv(text);
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new UserError(
      `CSV is missing required column(s): ${missing.join(', ')}. Expected: ${CSV_COLUMNS.join(', ')}`,
    );
  }

  const plan: ImportPlan = { total: rows.length, changes: [], igChanges: [], unchanged: 0, errors: [], warnings: [] };
  const hasInstagram = INSTAGRAM_COLUMNS.every((c) => header.includes(c));
  const seenIds = new Map<number, number>();

  rows.forEach((row, index) => {
    const ref: RowRef = { row: index + 2, id: null, filename: clean(row.filename) || null };
    const messages: string[] = [];
    const fail = () => plan.errors.push({ ...ref, messages });

    const id = Number(clean(row.id));
    if (!Number.isInteger(id) || id <= 0) {
      messages.push(`Invalid id: "${clean(row.id)}"`);
      return fail();
    }
    ref.id = id;
    const dupOf = seenIds.get(id);
    if (dupOf) {
      messages.push(`Duplicate id ${id} (also on row ${dupOf})`);
      return fail();
    }
    seenIds.set(id, ref.row);

    const video = findVideoById(db, id);
    if (!video) {
      messages.push(`Unknown id ${id}`);
      return fail();
    }
    ref.filename = video.filename;

    const parsed = parseRow(row, opts, messages);
    const reelMax = opts.reelMaxDurationS ?? 90;
    if (
      parsed?.publishTarget === 'REEL' &&
      video.durationS !== null &&
      chooseTarget(video.durationS, { reelMaxDurationS: reelMax }) === 'VIDEO'
    ) {
      messages.push(
        `publish_target REEL not possible: ${video.durationS.toFixed(0)}s is longer than the ${reelMax}s Reel limit (use VIDEO)`,
      );
    }
    const version = Number(clean(row.version));
    if (!Number.isInteger(version)) messages.push(`Invalid version: "${clean(row.version)}"`);
    const ig = hasInstagram ? planInstagramRow(db, row, video, ref, opts, messages, plan) : undefined;
    if (!parsed || messages.length) return fail();

    const { fields, values } = diff(video, parsed, reelMax);
    if (!fields.length) {
      if (ig) plan.igChanges.push(ig);
      else plan.unchanged += 1;
      return;
    }

    if (isSubmitted(video.state)) {
      messages.push(`Cannot edit ${fields.join(', ')}: already submitted to Facebook (state ${video.state})`);
      return fail();
    }
    if (version !== video.version && !(opts.force && FORCEABLE_STATES.includes(video.state))) {
      messages.push(
        `Record changed since this CSV was exported (CSV version ${version}, current ${video.version}). ` +
          `Re-export, or use --force to overwrite.`,
      );
      return fail();
    }

    const toState = fields.includes('action') ? stateAfterActionChange(video.state, parsed.action) : video.state;
    if (toState !== video.state) values.state = toState;
    if (fields.some((f) => f === 'caption' || f === 'hashtags' || f === 'title')) values.captionSource = 'manual';

    const effectiveAction = parsed.action;
    if (
      effectiveAction === 'SCHEDULE' &&
      parsed.scheduledAt &&
      Date.parse(parsed.scheduledAt) < opts.now.getTime() + MIN_LEAD_MS
    ) {
      plan.warnings.push({
        ...ref,
        message: 'scheduled_at is in the past or less than 10 minutes away; `validate` will reject it',
      });
    }
    if (effectiveAction === 'SCHEDULE' && video.specOk === false) {
      plan.warnings.push({ ...ref, message: 'video fails the Reel spec check; it cannot be published until fixed' });
    }

    plan.changes.push({ ...ref, id, expectedVersion: video.version, fields, values, fromState: video.state, toState });
    if (ig) plan.igChanges.push(ig);
  });

  return plan;
}

function parseRow(row: CsvRow, opts: ImportOptions, messages: string[]): ParsedRow | null {
  const targetText = clean(row.publish_target).toUpperCase();
  let publishTarget: PublishTarget | null = null;
  if (targetText) {
    if ((PUBLISH_TARGETS as readonly string[]).includes(targetText)) publishTarget = targetText as PublishTarget;
    else
      messages.push(
        `Invalid publish_target: ${clean(row.publish_target)} (use REEL, VIDEO, or leave empty for automatic)`,
      );
  }

  const actionText = clean(row.action).toUpperCase();
  let action: Action | null = null;
  if (actionText) {
    if ((ACTIONS as readonly string[]).includes(actionText)) action = actionText as Action;
    else messages.push(`Invalid action: ${clean(row.action)} (use ${ACTIONS.join(', ')} or leave empty)`);
  }

  const scheduledText = clean(row.scheduled_at);
  let scheduledAt: string | null = null;
  if (scheduledText) {
    const date = parseUserDateTime(scheduledText, opts.timezone);
    if (date) scheduledAt = toIso(date);
    else messages.push(`Invalid scheduled_at: "${scheduledText}" (use YYYY-MM-DD HH:mm, ${opts.timezone})`);
  } else if (action === 'SCHEDULE') {
    messages.push('scheduled_at is required when action is SCHEDULE');
  }

  const { tags, invalid } = parseHashtags(clean(row.hashtags));
  if (invalid.length) messages.push(`Invalid hashtag(s): ${invalid.join(' ')} (letters, numbers and _ only)`);
  if (tags.length > MAX_HASHTAGS) messages.push(`Too many hashtags: ${tags.length} (max ${MAX_HASHTAGS})`);

  const isAiGenerated = parseBool(row.is_ai_generated);
  if (isAiGenerated === null) messages.push(`Invalid is_ai_generated: "${clean(row.is_ai_generated)}" (use yes or no)`);

  if (messages.length) return null;
  return {
    publishTarget,
    caption: orNull(clean(row.caption)),
    hashtags: tags,
    title: orNull(clean(row.title)),
    action,
    scheduledAt,
    isAiGenerated: isAiGenerated ?? false,
  };
}

function diff(v: Video, p: ParsedRow, reelMaxDurationS: number): { fields: string[]; values: Partial<NewVideo> } {
  const fields: string[] = [];
  const values: Partial<NewVideo> = {};
  if (p.publishTarget === null) {
    // Empty cell = automatic. Only a change if the row was manually pinned.
    if (v.targetSource === 'manual') {
      fields.push('publish_target');
      values.targetSource = 'auto';
      values.publishTarget = chooseTarget(v.durationS, { reelMaxDurationS });
    }
  } else if (p.publishTarget !== v.publishTarget) {
    fields.push('publish_target');
    values.publishTarget = p.publishTarget;
    values.targetSource = 'manual';
  }
  const set = <K extends keyof NewVideo>(field: string, key: K, value: NewVideo[K]) => {
    fields.push(field);
    values[key] = value;
  };
  if ((v.caption?.trim() || null) !== p.caption) set('caption', 'caption', p.caption);
  if (!isDeepStrictEqual(v.hashtags ?? [], p.hashtags)) set('hashtags', 'hashtags', p.hashtags);
  if ((v.title?.trim() || null) !== p.title) set('title', 'title', p.title);
  if (v.action !== p.action) set('action', 'action', p.action);
  if (!sameInstant(v.scheduledAt, p.scheduledAt)) set('scheduled_at', 'scheduledAt', p.scheduledAt);
  if (v.isAiGenerated !== p.isAiGenerated) set('is_ai_generated', 'isAiGenerated', p.isAiGenerated);
  return { fields, values };
}

/** CSV has minute precision, so compare to the minute. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.floor(Date.parse(a) / 60_000) === Math.floor(Date.parse(b) / 60_000);
}

export class ImportConflictError extends UserError {}

/** Applies every change in one transaction; any concurrent modification rolls back everything. */
export function applyImport(db: Db, changes: RowChange[], igChanges: InstagramChange[] = []): void {
  runInTransaction(db, (tx) => {
    for (const c of igChanges) {
      if (c.postId === undefined) insertPost(tx, { videoId: c.videoId, platform: 'instagram', ...c.values });
      else if (!updatePostIfVersion(tx, c.postId, c.expectedVersion ?? -1, { ...c.values, lastError: null })) {
        throw new ImportConflictError(
          `Row ${c.row} (#${c.videoId}) Instagram post changed during import; nothing was changed. Try again.`,
        );
      }
    }
    for (const c of changes) {
      if (!updateVideoIfVersion(tx, c.id, c.expectedVersion, c.values)) {
        throw new ImportConflictError(
          `Row ${c.row} (#${c.id}) was modified during import; nothing was changed. Try again.`,
        );
      }
    }
  });
}

/**
 * Plans the Instagram columns of one row. Facebook columns are handled separately and are not affected:
 * an Instagram edit is allowed even when the video is already scheduled on Facebook.
 */
function planInstagramRow(
  db: Db,
  row: CsvRow,
  video: Video,
  ref: RowRef,
  opts: ImportOptions,
  messages: string[],
  plan: ImportPlan,
): InstagramChange | undefined {
  const actionText = clean(row.ig_action).toUpperCase();
  let action: Action | null = null;
  if (actionText) {
    if ((ACTIONS as readonly string[]).includes(actionText)) action = actionText as Action;
    else {
      messages.push(`Invalid ig_action: ${clean(row.ig_action)} (use ${ACTIONS.join(', ')} or leave empty)`);
      return undefined;
    }
  }
  const timeText = clean(row.ig_scheduled_at);
  let scheduledAt: string | null = null;
  if (timeText) {
    const date = parseUserDateTime(timeText, opts.timezone);
    if (!date) {
      messages.push(`Invalid ig_scheduled_at: "${timeText}" (use YYYY-MM-DD HH:mm, ${opts.timezone})`);
      return undefined;
    }
    scheduledAt = toIso(date);
  } else if (action === 'SCHEDULE') {
    messages.push('ig_scheduled_at is required when ig_action is SCHEDULE');
    return undefined;
  }

  const existing = findPost(db, video.id, 'instagram');
  if (!existing && action === null) return undefined;
  if (existing && existing.action === action && sameInstant(existing.scheduledAt, scheduledAt)) return undefined;
  if (existing && isPostSubmitted(existing.state)) {
    messages.push(`Cannot edit Instagram columns: already sent to Instagram (state ${existing.state})`);
    return undefined;
  }
  if ((action === 'POST_NOW' || action === 'SCHEDULE') && video.mediaInfo) {
    const blockers = instagramBlockers(video.mediaInfo, video.fileSize);
    if (blockers.length) {
      messages.push(`Not possible on Instagram: ${blockers.join('; ')}`);
      return undefined;
    }
  }
  if (action === 'SCHEDULE' && scheduledAt && Date.parse(scheduledAt) < opts.now.getTime() + MIN_LEAD_MS) {
    plan.warnings.push({ ...ref, message: 'ig_scheduled_at is in the past or less than 10 minutes away' });
  }
  const state: PostState =
    action === 'SKIP' ? 'SKIPPED' : existing?.state === 'FAILED' ? 'FAILED' : action === null ? 'NEW' : 'READY';
  return {
    ...ref,
    videoId: video.id,
    postId: existing?.id,
    expectedVersion: existing?.version,
    values: { action, scheduledAt, state },
  };
}
