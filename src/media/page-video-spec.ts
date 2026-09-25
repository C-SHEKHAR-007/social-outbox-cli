import type { MediaInfo, SpecIssue } from '../domain/media.js';

/**
 * Regular Page video (POST /{page-id}/videos). Meta documents no hard spec for this endpoint;
 * the size/duration caps are the commonly cited Facebook video limits (unverified).
 */
export const PAGE_VIDEO_SPEC = {
  minDurationS: 1,
  maxDurationS: 240 * 60,
  maxFileSize: 10 * 1024 ** 3,
  recommendedVideoCodecs: ['h264', 'hevc'],
} as const;

const s = PAGE_VIDEO_SPEC;

export function checkPageVideoSpec(info: MediaInfo, fileSize: number): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const error = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message });

  const d = info.durationS;
  if (d === null) error('DURATION_UNKNOWN', 'duration could not be determined');
  else if (d < s.minDurationS) error('DURATION_TOO_SHORT', `duration ${d.toFixed(1)}s < ${s.minDurationS}s`);
  else if (d > s.maxDurationS)
    error('DURATION_TOO_LONG', `duration ${(d / 60).toFixed(0)} min > ${s.maxDurationS / 60} min`);
  if (fileSize > s.maxFileSize) error('FILE_TOO_LARGE', `file is ${(fileSize / 1024 ** 3).toFixed(1)} GB > 10 GB`);

  const v = info.video;
  if (!v) error('NO_VIDEO', 'no video stream');
  else if (!(s.recommendedVideoCodecs as readonly string[]).includes(v.codec)) {
    warn('VIDEO_CODEC', `video codec ${v.codec}; H.264 recommended (re-encode for best compatibility)`);
  }

  const a = info.audio;
  if (!a) warn('NO_AUDIO', 'no audio stream');
  else if (a.codec !== 'aac') warn('AUDIO_CODEC', `audio codec ${a.codec}; AAC recommended`);

  if (info.container && !/mp4|mov/.test(info.container))
    warn('CONTAINER', `container ${info.container}; mp4 recommended`);
  return issues;
}
