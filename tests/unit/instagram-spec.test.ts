import { describe, expect, it } from 'vitest';
import { checkInstagramReelSpec, instagramBlockers, needsInstagramTranscode } from '../../src/media/instagram-spec.js';
import { instagramTranscodeArgs } from '../../src/media/normalize.js';
import { mediaInfo } from '../fixtures/factories.js';

const MB = 1024 * 1024;

describe('Instagram Reel spec', () => {
  it('accepts an H.264/AAC 1080x1920 30 fps clip as-is', () => {
    expect(checkInstagramReelSpec(mediaInfo(), 50 * MB)).toEqual([]);
    expect(needsInstagramTranscode(mediaInfo(), 50 * MB)).toBe(false);
  });

  it('marks codec/audio/fps/width/container/size problems as fixable by re-encoding', () => {
    const av1 = mediaInfo({
      container: 'matroska,webm',
      video: { ...mediaInfo().video!, codec: 'av1', avgFps: 20, fps: 20, width: 2160, height: 3840 },
      audio: { codec: 'opus', profile: null, sampleRate: 96000, channels: 2, bitrate: 128000 },
    });
    const codes = checkInstagramReelSpec(av1, 400 * MB).map((i) => [i.code, i.fixable]);
    expect(codes).toEqual([
      ['VIDEO_CODEC', true],
      ['FPS', true],
      ['TOO_WIDE', true],
      ['AUDIO_CODEC', true],
      ['AUDIO_SAMPLE_RATE', true],
      ['CONTAINER', true],
      ['FILE_TOO_LARGE', true],
    ]);
    expect(needsInstagramTranscode(av1, 400 * MB)).toBe(true);
    expect(instagramBlockers(av1, 400 * MB)).toEqual([]);
  });

  it('length outside 3 s – 15 min cannot be fixed', () => {
    expect(instagramBlockers(mediaInfo({ durationS: 16 * 60 }), MB)).toEqual([
      'duration 16.0 min > 15 min (Instagram limit)',
    ]);
    expect(instagramBlockers(mediaInfo({ durationS: 2 }), MB)).toEqual(['duration 2.0s < 3s']);
    expect(instagramBlockers(mediaInfo({ durationS: 15 * 60 }), MB)).toEqual([]);
  });
});

describe('instagramTranscodeArgs', () => {
  const args = (over = {}) => instagramTranscodeArgs('in.webm', 'out.mp4', mediaInfo(over)).join(' ');

  it('produces H.264 4:2:0, closed GOP, AAC 48 kHz stereo, faststart MP4', () => {
    const a = args();
    for (const part of [
      '-c:v libx264',
      '-profile:v high',
      'format=yuv420p',
      '+cgop',
      '-c:a aac',
      '-ar 48000',
      '-ac 2',
      '+faststart',
      '-f mp4',
    ]) {
      expect(a).toContain(part);
    }
    expect(a).toContain('fps=30');
    expect(a).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  });

  it('clamps frame rate, limits width, drops audio when there is none', () => {
    expect(args({ video: { ...mediaInfo().video!, avgFps: 20, fps: 20 } })).toContain('fps=24');
    expect(args({ video: { ...mediaInfo().video!, avgFps: 120, fps: 120 } })).toContain('fps=30');
    expect(args({ video: { ...mediaInfo().video!, width: 3840, height: 2160 } })).toContain('scale=1920:-2');
    expect(args({ audio: null })).toContain('-an');
  });

  it('caps the bitrate so long videos stay under 300 MB', () => {
    const maxrate = (d: number) => Number(/-maxrate (\d+)k/.exec(args({ durationS: d }))?.[1]);
    expect(maxrate(30)).toBe(8000); // short: quality cap
    const long = maxrate(14 * 60);
    expect(long).toBeLessThan(3000);
    expect(((long + 128) * 1000 * 14 * 60) / 8 / MB).toBeLessThan(300);
  });
});
