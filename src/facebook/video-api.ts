import { z } from 'zod';
import { GRAPH_VIDEO_HOST, type GraphClient } from './graph-client.js';

/*
 * Thin, typed wrappers around the two Meta upload flows (docs/plan.md §2.1, §2.8).
 * No retries or state here: the publisher decides what to do with each result.
 */

// ---------- Reels: POST /{page-id}/video_reels + rupload ----------

const ReelStartSchema = z.object({ video_id: z.string().min(1), upload_url: z.string().optional() });
const SuccessSchema = z.object({ success: z.boolean().optional() }).loose();
const ReelFinishSchema = z.object({ success: z.boolean().optional(), post_id: z.string().optional() }).loose();

export type ReelVideoState = 'PUBLISHED' | 'SCHEDULED' | 'DRAFT';

export async function reelStart(client: GraphClient, pageId: string, token: string): Promise<{ videoId: string }> {
  const res = await client.post(`${pageId}/video_reels`, { upload_phase: 'start' }, ReelStartSchema, { token });
  return { videoId: res.video_id };
}

export async function reelTransfer(
  client: GraphClient,
  videoId: string,
  token: string,
  data: Uint8Array,
  offset: number,
  fileSize: number,
): Promise<void> {
  const res = await client.uploadReelBinary(videoId, token, data, offset, fileSize, SuccessSchema);
  if (res.success === false) throw new Error('Reel upload was not accepted (success=false)');
}

export async function reelFinish(
  client: GraphClient,
  pageId: string,
  token: string,
  args: {
    videoId: string;
    state: ReelVideoState;
    description: string;
    title?: string;
    scheduledAt?: Date;
    isAiGenerated?: boolean;
  },
): Promise<{ postId: string | undefined }> {
  const res = await client.post(
    `${pageId}/video_reels`,
    {
      upload_phase: 'finish',
      video_id: args.videoId,
      video_state: args.state,
      description: args.description,
      title: args.title,
      scheduled_publish_time: args.scheduledAt ? String(Math.floor(args.scheduledAt.getTime() / 1000)) : undefined,
      is_ai_generated: args.isAiGenerated ? 'true' : undefined,
    },
    ReelFinishSchema,
    { token },
  );
  if (res.success === false) throw new Error('Facebook rejected the Reel finish step (success=false)');
  return { postId: res.post_id };
}

// ---------- Page videos: chunked POST /{page-id}/videos on graph-video ----------

const OffsetsSchema = z.object({ start_offset: z.coerce.number(), end_offset: z.coerce.number() }).loose();
const VideoStartSchema = OffsetsSchema.extend({ upload_session_id: z.string().min(1), video_id: z.string().min(1) });

export interface ChunkWindow {
  start: number;
  end: number;
}

export async function pageVideoStart(
  client: GraphClient,
  pageId: string,
  token: string,
  fileSize: number,
): Promise<{ videoId: string; sessionId: string; next: ChunkWindow }> {
  const res = await client.post(
    `${pageId}/videos`,
    { upload_phase: 'start', file_size: String(fileSize) },
    VideoStartSchema,
    { token, host: GRAPH_VIDEO_HOST },
  );
  return {
    videoId: res.video_id,
    sessionId: res.upload_session_id,
    next: { start: res.start_offset, end: res.end_offset },
  };
}

/** Sends one chunk; returns the next window Facebook wants (start === end means done). */
export async function pageVideoTransfer(
  client: GraphClient,
  pageId: string,
  token: string,
  sessionId: string,
  startOffset: number,
  chunk: Uint8Array,
): Promise<ChunkWindow> {
  const res = await client.post(
    `${pageId}/videos`,
    {
      upload_phase: 'transfer',
      upload_session_id: sessionId,
      start_offset: String(startOffset),
      video_file_chunk: new Blob([chunk]),
    },
    OffsetsSchema,
    { token, host: GRAPH_VIDEO_HOST },
  );
  return { start: res.start_offset, end: res.end_offset };
}

export async function pageVideoFinish(
  client: GraphClient,
  pageId: string,
  token: string,
  args: {
    sessionId: string;
    mode: 'now' | 'schedule' | 'draft';
    description: string;
    title?: string;
    scheduledAt?: Date;
  },
): Promise<void> {
  const res = await client.post(
    `${pageId}/videos`,
    {
      upload_phase: 'finish',
      upload_session_id: args.sessionId,
      description: args.description,
      title: args.title,
      published: args.mode === 'now' ? 'true' : 'false',
      scheduled_publish_time:
        args.mode === 'schedule' && args.scheduledAt
          ? String(Math.floor(args.scheduledAt.getTime() / 1000))
          : undefined,
      unpublished_content_type: args.mode === 'schedule' ? 'SCHEDULED' : args.mode === 'draft' ? 'DRAFT' : undefined,
    },
    SuccessSchema,
    { token, host: GRAPH_VIDEO_HOST },
  );
  if (res.success === false) throw new Error('Facebook rejected the video finish step (success=false)');
}

// ---------- status (both flows) ----------

/** A number, or a numeric string; anything else becomes undefined instead of failing the whole response. */
const lenientNumber = z.unknown().transform((v): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
});

/**
 * Unix seconds. Facebook returns `publish_time` as an ISO string ("2026-09-26T21:30:00+0000") on the
 * status phases, but as a number elsewhere; accept both.
 */
const unixSeconds = z.unknown().transform((v): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v);
  const ms = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
});

const PhaseSchema = z
  .object({
    status: z.string().optional(),
    bytes_transferred: lenientNumber.optional(),
    publish_status: z.string().optional(),
    publish_time: unixSeconds.optional(),
    errors: z.array(z.object({ code: lenientNumber.optional(), message: z.string().optional() }).loose()).optional(),
    error: z.object({ message: z.string().optional() }).loose().optional(),
  })
  .loose();

export const VideoStatusSchema = z
  .object({
    id: z.string().optional(),
    permalink_url: z.string().optional(),
    published: z.boolean().optional(),
    status: z
      .object({
        video_status: z.string().optional(),
        uploading_phase: PhaseSchema.optional(),
        processing_phase: PhaseSchema.optional(),
        publishing_phase: PhaseSchema.optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type VideoStatus = z.infer<typeof VideoStatusSchema>;

export async function getVideoStatus(client: GraphClient, videoId: string, token: string): Promise<VideoStatus> {
  return client.get(videoId, { fields: 'status,permalink_url,published' }, VideoStatusSchema, { token });
}
