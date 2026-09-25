import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '../../src/domain/media.js';
import { checkReelSpec, hasSpecErrors } from '../../src/media/reel-spec.js';
import { mediaInfo } from '../fixtures/factories.js';

const compliant = () => mediaInfo({ durationS: 15 });

function codes(mutate: (i: MediaInfo) => void) {
  const info = compliant();
  mutate(info);
  return checkReelSpec(info).map((i) => `${i.level}:${i.code}`);
}

describe('checkReelSpec', () => {
  it('accepts a compliant 1080x1920 reel', () => {
    expect(checkReelSpec(compliant())).toEqual([]);
  });

  it('accepts 720x1280 and the exact duration boundaries', () => {
    expect(codes((i) => ((i.video!.width = 720), (i.video!.height = 1280)))).toEqual([]);
    expect(codes((i) => (i.durationS = 3))).toEqual([]);
    expect(codes((i) => (i.durationS = 90.04))).toEqual([]);
  });

  it.each<[string, (i: MediaInfo) => void, string]>([
    ['too short', (i) => (i.durationS = 2.5), 'error:DURATION_TOO_SHORT'],
    ['too long', (i) => (i.durationS = 91), 'error:DURATION_TOO_LONG'],
    ['unknown duration', (i) => (i.durationS = null), 'error:DURATION_UNKNOWN'],
    ['landscape', (i) => ((i.video!.width = 1920), (i.video!.height = 1080)), 'error:ASPECT_RATIO'],
    ['4:5', (i) => ((i.video!.width = 1080), (i.video!.height = 1350)), 'error:ASPECT_RATIO'],
    ['low res', (i) => ((i.video!.width = 360), (i.video!.height = 640)), 'error:RESOLUTION_TOO_LOW'],
    ['codec', (i) => (i.video!.codec = 'mpeg4'), 'error:VIDEO_CODEC'],
    ['fps low', (i) => ((i.video!.fps = 15), (i.video!.avgFps = 15)), 'error:FPS_OUT_OF_RANGE'],
    ['fps high', (i) => ((i.video!.fps = 120), (i.video!.avgFps = 120)), 'error:FPS_OUT_OF_RANGE'],
    ['vfr', (i) => (i.video!.avgFps = 27.3), 'warning:VARIABLE_FRAME_RATE'],
    ['chroma', (i) => (i.video!.pixFmt = 'yuv444p'), 'error:CHROMA_SUBSAMPLING'],
    ['interlaced', (i) => (i.video!.fieldOrder = 'tt'), 'error:INTERLACED'],
    ['no video', (i) => (i.video = null), 'error:NO_VIDEO'],
    ['no audio', (i) => (i.audio = null), 'warning:NO_AUDIO'],
    ['opus audio', (i) => (i.audio!.codec = 'opus'), 'error:AUDIO_CODEC'],
    ['HE-AAC', (i) => (i.audio!.profile = 'HE-AAC'), 'warning:AUDIO_PROFILE'],
    ['44.1k', (i) => (i.audio!.sampleRate = 44100), 'warning:AUDIO_SAMPLE_RATE'],
    ['mono', (i) => (i.audio!.channels = 1), 'warning:AUDIO_CHANNELS'],
    ['low audio bitrate', (i) => (i.audio!.bitrate = 96000), 'warning:AUDIO_BITRATE'],
    ['webm container', (i) => (i.container = 'matroska,webm'), 'warning:CONTAINER'],
  ])('%s', (_name, mutate, expected) => {
    expect(codes(mutate)).toContain(expected);
  });

  it('only errors block publishing', () => {
    const warningsOnly = compliant();
    warningsOnly.audio = null;
    expect(hasSpecErrors(checkReelSpec(warningsOnly))).toBe(false);
    const bad = compliant();
    bad.durationS = 1;
    expect(hasSpecErrors(checkReelSpec(bad))).toBe(true);
  });
});
