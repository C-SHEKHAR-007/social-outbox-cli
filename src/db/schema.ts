import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  ACTIONS,
  ATTEMPT_OUTCOMES,
  ATTEMPT_STEPS,
  CAPTION_SOURCES,
  PUBLISH_TARGETS,
  TARGET_SOURCES,
  VIDEO_STATES,
} from '../domain/states.js';
import type { MediaInfo, SpecIssue } from '../domain/media.js';

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const videos = sqliteTable(
  'videos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // File identity
    fileHash: text('file_hash').notNull().unique(),
    filePath: text('file_path').notNull(),
    filename: text('filename').notNull(),
    fileSize: integer('file_size').notNull(),
    fileMtime: integer('file_mtime').notNull(),

    // Media metadata (ffprobe)
    durationS: real('duration_s'),
    width: integer('width'),
    height: integer('height'),
    fps: real('fps'),
    videoCodec: text('video_codec'),
    audioCodec: text('audio_codec'),
    audioSampleRate: integer('audio_sample_rate'),
    audioChannels: integer('audio_channels'),
    container: text('container'),
    bitrate: integer('bitrate'),
    specOk: integer('spec_ok', { mode: 'boolean' }),
    specIssues: text('spec_issues', { mode: 'json' }).$type<SpecIssue[]>(),
    mediaInfo: text('media_info', { mode: 'json' }).$type<MediaInfo>(),
    normalizedPath: text('normalized_path'),

    // Content
    transcript: text('transcript'),
    transcriptLang: text('transcript_lang'),
    caption: text('caption'),
    hashtags: text('hashtags', { mode: 'json' }).$type<string[]>(),
    title: text('title'),
    captionSource: text('caption_source', { enum: CAPTION_SOURCES }),
    aiModel: text('ai_model'),
    generatedAt: text('generated_at'),
    isAiGenerated: integer('is_ai_generated', { mode: 'boolean' }).notNull().default(false),

    // Intent + lifecycle
    publishTarget: text('publish_target', { enum: PUBLISH_TARGETS }).notNull().default('REEL'),
    targetSource: text('target_source', { enum: TARGET_SOURCES }).notNull().default('auto'),
    action: text('action', { enum: ACTIONS }),
    scheduledAt: text('scheduled_at'), // ISO-8601 UTC
    state: text('state', { enum: VIDEO_STATES }).notNull().default('NEW'),

    // Facebook
    fbVideoId: text('fb_video_id').unique(),
    fbPostId: text('fb_post_id'),
    fbPermalink: text('fb_permalink'),
    bytesUploaded: integer('bytes_uploaded').notNull().default(0),
    finishSentAt: text('finish_sent_at'),
    publishedAt: text('published_at'),

    // Retry / errors
    retryCount: integer('retry_count').notNull().default(0),
    nextAttemptAt: text('next_attempt_at'),
    lastErrorCode: text('last_error_code'),
    lastError: text('last_error'),

    // Lease lock
    lockedBy: text('locked_by'),
    lockExpiresAt: text('lock_expires_at'),

    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (t) => [
    index('videos_state_idx').on(t.state),
    index('videos_scheduled_at_idx').on(t.scheduledAt),
    index('videos_finish_sent_at_idx').on(t.finishSentAt),
    index('videos_file_path_idx').on(t.filePath),
  ],
);

export const publishAttempts = sqliteTable(
  'publish_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    videoId: integer('video_id')
      .notNull()
      .references(() => videos.id),
    step: text('step', { enum: ATTEMPT_STEPS }).notNull(),
    startedAt: text('started_at').notNull().default(nowIso),
    endedAt: text('ended_at'),
    outcome: text('outcome', { enum: ATTEMPT_OUTCOMES }),
    httpStatus: integer('http_status'),
    fbErrorCode: integer('fb_error_code'),
    fbErrorSubcode: integer('fb_error_subcode'),
    message: text('message'),
    fbTraceId: text('fb_trace_id'),
  },
  (t) => [index('publish_attempts_video_id_idx').on(t.videoId)],
);

export const appState = sqliteTable('app_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(nowIso),
});

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;
export type PublishAttempt = typeof publishAttempts.$inferSelect;
