import type { MediaInfo, SpecIssue } from '../domain/media.js';

/** Instagram Reels API requirements (IG User Media reference, checked 2026-10-04). */
export const INSTAGRAM_REEL_SPEC = {
  minDurationS: 3,
  maxDurationS: 15 * 60,
  maxFileSize: 300 * 1024 * 1024,
  videoCodecs: ['h264', 'hevc'],
  audioCodec: 'aac',
  maxAudioSampleRate: 48_000,
  minFps: 23,
  maxFps: 60,
  maxWidth: 1920,
} as const;

const s = INSTAGRAM_REEL_SPEC;

/**
 * Pure. `fixable` issues are solved by re-encoding (normalize); anything else (length) cannot be
 * published to Instagram at all.
 */
export function checkInstagramReelSpec(info: MediaInfo, fileSize: number): Array<SpecIssue & { fixable: boolean }> {
  const issues: Array<SpecIssue & { fixable: boolean }> = [];
  const add = (code: string, message: string, fixable: boolean) =>
    issues.push({ level: 'error', code, message, fixable });

  const d = info.durationS;
  if (d === null) add('DURATION_UNKNOWN', 'duration could not be determined', false);
  else if (d < s.minDurationS) add('DURATION_TOO_SHORT', `duration ${d.toFixed(1)}s < ${s.minDurationS}s`, false);
  else if (d > s.maxDurationS + 0.5)
    add('DURATION_TOO_LONG', `duration ${(d / 60).toFixed(1)} min > 15 min (Instagram limit)`, false);

  const v = info.video;
  if (!v) add('NO_VIDEO', 'no video stream', false);
  else {
    if (!(s.videoCodecs as readonly string[]).includes(v.codec))
      add('VIDEO_CODEC', `video codec ${v.codec}; Instagram needs H.264/HEVC`, true);
    const fps = v.avgFps ?? v.fps;
    if (fps !== null && (fps < s.minFps - 0.1 || fps > s.maxFps + 0.5))
      add('FPS', `frame rate ${fps} outside 23–60 fps`, true);
    if (v.width > s.maxWidth) add('TOO_WIDE', `width ${v.width}px > 1920px`, true);
    if (v.pixFmt && !v.pixFmt.includes('420')) add('CHROMA', `pixel format ${v.pixFmt} is not 4:2:0`, true);
  }
  const a = info.audio;
  if (a) {
    if (a.codec !== s.audioCodec) add('AUDIO_CODEC', `audio codec ${a.codec}; Instagram needs AAC`, true);
    if (a.sampleRate !== null && a.sampleRate > s.maxAudioSampleRate)
      add('AUDIO_SAMPLE_RATE', `audio ${a.sampleRate} Hz > 48 kHz`, true);
  }
  if (info.container && !/mp4|mov/.test(info.container))
    add('CONTAINER', `container ${info.container}; Instagram needs MP4/MOV`, true);
  if (fileSize > s.maxFileSize) add('FILE_TOO_LARGE', `file is ${(fileSize / 1024 ** 2).toFixed(0)} MB > 300 MB`, true);
  return issues;
}

export function needsInstagramTranscode(info: MediaInfo, fileSize: number): boolean {
  return checkInstagramReelSpec(info, fileSize).some((i) => i.fixable);
}

export function instagramBlockers(info: MediaInfo, fileSize: number): string[] {
  return checkInstagramReelSpec(info, fileSize)
    .filter((i) => !i.fixable)
    .map((i) => i.message);
}
