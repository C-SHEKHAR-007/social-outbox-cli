import { describe, expect, it } from 'vitest';
import type { MediaInfo } from '../../src/domain/media.js';
import { checkPageVideoSpec } from '../../src/media/page-video-spec.js';
import { checkSpecFor, chooseTarget } from '../../src/media/publish-target.js';

const info = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  durationS: 420,
  container: 'mov,mp4',
  bitrate: 1,
  video: {
    codec: 'h264',
    profile: null,
    width: 1920,
    height: 1080,
    rotation: 0,
    fps: 30,
    avgFps: 30,
    pixFmt: 'yuv420p',
    fieldOrder: 'progressive',
  },
  audio: { codec: 'aac', profile: 'HE-AAC', sampleRate: 44100, channels: 2, bitrate: 50000 },
  ...over,
});
const rules = { reelMaxDurationS: 90 };

describe('chooseTarget', () => {
  it.each([
    [30, 'REEL'],
    [90, 'REEL'],
    [90.04, 'REEL'],
    [90.2, 'VIDEO'],
    [435, 'VIDEO'],
    [null, 'REEL'],
  ] as const)('%s s → %s', (d, target) => {
    expect(chooseTarget(d, rules)).toBe(target);
  });

  it('respects a raised Reel limit', () => {
    expect(chooseTarget(435, { reelMaxDurationS: 900 })).toBe('REEL');
  });
});

describe('checkPageVideoSpec', () => {
  it('accepts long landscape videos with any AAC audio', () => {
    expect(checkPageVideoSpec(info(), 50 * 1024 ** 2)).toEqual([]);
  });
  it('warns (not errors) about AV1/VP9 and non-AAC audio', () => {
    const issues = checkPageVideoSpec(
      info({ video: { ...info().video!, codec: 'av1' }, audio: { ...info().audio!, codec: 'opus' } }),
      1,
    );
    expect(issues.map((i) => `${i.level}:${i.code}`)).toEqual(['warning:VIDEO_CODEC', 'warning:AUDIO_CODEC']);
  });
  it('errors on missing video, > 240 min, > 10 GB', () => {
    const codes = checkPageVideoSpec(info({ video: null, durationS: 5 * 3600 }), 11 * 1024 ** 3).map((i) => i.code);
    expect(codes).toEqual(['DURATION_TOO_LONG', 'FILE_TOO_LARGE', 'NO_VIDEO']);
  });
});

describe('checkSpecFor', () => {
  it('applies Reel rules (with configured max) to REEL and Page rules to VIDEO', () => {
    const vertical = info({
      video: { ...info().video!, width: 1080, height: 1920 },
      audio: { ...info().audio!, profile: 'LC', sampleRate: 48000, bitrate: 128000 },
    });
    expect(checkSpecFor('REEL', vertical, 1, rules).map((i) => i.code)).toEqual(['DURATION_TOO_LONG']);
    expect(checkSpecFor('REEL', vertical, 1, { reelMaxDurationS: 900 })).toEqual([]);
    expect(checkSpecFor('VIDEO', vertical, 1, rules)).toEqual([]);
  });
});
