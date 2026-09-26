import type { VideoStatus } from '../facebook/video-api.js';

export type RemoteOutcome =
  | 'published'
  | 'scheduled'
  | 'draft'
  /** Upload finished but FINISH was never applied: safe to (re)send FINISH. */
  | 'uploaded'
  | 'uploading'
  | 'processing'
  /** Page video that is not public, when Facebook does not say whether it is a draft or scheduled. */
  | 'unpublished'
  | 'failed';

export interface RemoteState {
  outcome: RemoteOutcome;
  message?: string;
  permalink?: string;
  bytesTransferred?: number;
  publishTime?: Date;
}

const FAILED_VIDEO_STATUSES = new Set(['error', 'upload_failed', 'expired']);

/** Pure: interprets GET /{video-id}?fields=status,permalink_url,published for both Reels and Page videos. */
export function interpretStatus(s: VideoStatus): RemoteState {
  const st = s.status ?? {};
  const upload = st.uploading_phase;
  const processing = st.processing_phase;
  const publishing = st.publishing_phase;
  const permalink = s.permalink_url ? absolutePermalink(s.permalink_url) : undefined;
  const base = { permalink, bytesTransferred: upload?.bytes_transferred };

  const phaseError =
    processing?.status === 'error' ? processing : publishing?.status === 'error' ? publishing : undefined;
  if (
    phaseError ||
    (st.video_status && FAILED_VIDEO_STATUSES.has(st.video_status)) ||
    publishing?.publish_status === 'error'
  ) {
    const message =
      phaseError?.errors?.[0]?.message ??
      phaseError?.error?.message ??
      `Facebook reports video_status=${st.video_status ?? 'error'}`;
    return { ...base, outcome: 'failed', message };
  }

  const publishTime = publishing?.publish_time ? new Date(publishing.publish_time * 1000) : undefined;
  switch (publishing?.publish_status) {
    case 'published':
      return { ...base, outcome: 'published', publishTime };
    case 'scheduled':
      return { ...base, outcome: 'scheduled', publishTime };
    case 'draft':
      return { ...base, outcome: 'draft' };
  }
  // Upload state first: Facebook reports `published: true` as a default flag even on an unfinished
  // upload (verified 2026-09-27), so that flag alone never means the video is live.
  if (st.video_status === 'uploading' || (upload?.status && upload.status !== 'complete')) {
    return { ...base, outcome: 'uploading' };
  }
  const notStarted = (p?: { status?: string }) => !p?.status || p.status === 'not_started';
  if (st.video_status === 'upload_complete' && notStarted(processing) && notStarted(publishing)) {
    return { ...base, outcome: 'uploaded' };
  }
  const processed = processing?.status === 'complete' || st.video_status === 'ready';
  if (s.published === true && processed) return { ...base, outcome: 'published' };
  if (s.published === false && processed) return { ...base, outcome: 'unpublished' };
  return { ...base, outcome: 'processing' };
}

function absolutePermalink(p: string): string {
  return p.startsWith('http') ? p : `https://www.facebook.com${p.startsWith('/') ? '' : '/'}${p}`;
}
