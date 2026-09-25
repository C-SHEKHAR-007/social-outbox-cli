import type { MediaInfo, SpecIssue } from '../domain/media.js';

/** Meta Reels API requirements (docs/plan.md §2.4). */
export const REEL_SPEC = {
  minDurationS: 3,
  maxDurationS: 90,
  durationToleranceS: 0.05, // container timestamps often overshoot by a frame
  aspectRatio: 9 / 16,
  aspectTolerance: 0.01,
  minWidth: 540,
  minHeight: 960,
  minFps: 24,
  maxFps: 60,
  videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
  audioCodec: 'aac',
  audioSampleRate: 48_000,
  audioChannels: 2,
  minAudioBitrate: 128_000,
} as const;

const s = REEL_SPEC;

/** Pure: returns every spec problem. Errors block publishing; warnings don't. */
export function checkReelSpec(info: MediaInfo, maxDurationS: number = s.maxDurationS): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const error = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warning', code, message });

  const d = info.durationS;
  if (d === null) error('DURATION_UNKNOWN', 'duration could not be determined');
  else if (d < s.minDurationS - s.durationToleranceS)
    error('DURATION_TOO_SHORT', `duration ${d.toFixed(1)}s < ${s.minDurationS}s`);
  else if (d > maxDurationS + s.durationToleranceS)
    error('DURATION_TOO_LONG', `duration ${d.toFixed(1)}s > ${maxDurationS}s (too long for a Reel)`);

  const v = info.video;
  if (!v) {
    error('NO_VIDEO', 'no video stream');
  } else {
    const ratio = v.width / v.height;
    if (Math.abs(ratio - s.aspectRatio) / s.aspectRatio > s.aspectTolerance) {
      error('ASPECT_RATIO', `aspect ratio ${v.width}x${v.height} is not 9:16`);
    }
    if (v.width < s.minWidth || v.height < s.minHeight) {
      error('RESOLUTION_TOO_LOW', `resolution ${v.width}x${v.height} < ${s.minWidth}x${s.minHeight}`);
    }
    if (!(s.videoCodecs as readonly string[]).includes(v.codec)) {
      error('VIDEO_CODEC', `video codec ${v.codec} not supported (use ${s.videoCodecs.join('/')})`);
    }
    const fps = v.avgFps ?? v.fps;
    if (fps === null) warn('FPS_UNKNOWN', 'frame rate could not be determined');
    else if (fps < s.minFps - 0.5 || fps > s.maxFps + 0.5)
      error('FPS_OUT_OF_RANGE', `frame rate ${fps} outside ${s.minFps}–${s.maxFps} fps`);
    if (v.fps && v.avgFps && Math.abs(v.fps - v.avgFps) / v.fps > 0.01) {
      warn('VARIABLE_FRAME_RATE', `variable frame rate (${v.avgFps} avg vs ${v.fps} nominal); constant is required`);
    }
    if (v.pixFmt === null) warn('PIXEL_FORMAT_UNKNOWN', 'pixel format unknown');
    else if (!v.pixFmt.includes('420')) error('CHROMA_SUBSAMPLING', `pixel format ${v.pixFmt} is not 4:2:0`);
    if (v.fieldOrder && !['progressive', 'unknown'].includes(v.fieldOrder)) {
      error('INTERLACED', `interlaced video (${v.fieldOrder}); progressive is required`);
    }
  }

  const a = info.audio;
  if (!a) {
    warn('NO_AUDIO', 'no audio stream');
  } else {
    if (a.codec !== s.audioCodec) error('AUDIO_CODEC', `audio codec ${a.codec}; AAC is required`);
    else if (a.profile && a.profile !== 'LC') warn('AUDIO_PROFILE', `AAC profile ${a.profile}; AAC-LC recommended`);
    if (a.sampleRate !== null && a.sampleRate !== s.audioSampleRate)
      warn('AUDIO_SAMPLE_RATE', `audio sample rate ${a.sampleRate} Hz; 48000 Hz required`);
    if (a.channels !== null && a.channels !== s.audioChannels)
      warn('AUDIO_CHANNELS', `${a.channels} audio channel(s); stereo required`);
    if (a.bitrate !== null && a.bitrate < s.minAudioBitrate - 1000)
      warn('AUDIO_BITRATE', `audio bitrate ${Math.round(a.bitrate / 1000)} kbps < 128 kbps`);
  }

  if (info.container && !/mp4|mov/.test(info.container)) {
    warn('CONTAINER', `container ${info.container}; mp4 recommended`);
  }
  return issues;
}

export function hasSpecErrors(issues: SpecIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
