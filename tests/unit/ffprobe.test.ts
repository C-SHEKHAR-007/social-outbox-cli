import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanFfprobeError, parseFfprobeOutput, parseFrameRate, ProbeError } from '../../src/media/ffprobe.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/ffprobe/${name}.json`, import.meta.url), 'utf8'));

describe('parseFrameRate', () => {
  it.each([
    ['30/1', 30],
    ['30000/1001', 29.97],
    ['25', 25],
    ['0/0', null],
    ['', null],
    [undefined, null],
    ['abc', null],
  ])('%s → %s', (input, expected) => {
    expect(parseFrameRate(input)).toBe(expected);
  });
});

describe('parseFfprobeOutput', () => {
  it('applies display-matrix rotation to width/height', () => {
    const info = parseFfprobeOutput(fixture('phone-rotated'));
    expect(info.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920, rotation: 270, fps: 30 });
    expect(info.audio).toEqual({ codec: 'aac', profile: 'LC', sampleRate: 48000, channels: 2, bitrate: 192000 });
    expect(info.durationS).toBeCloseTo(12.512);
    expect(info.bitrate).toBe(8_000_000);
  });

  it('ignores cover art and handles N/A duration', () => {
    const info = parseFfprobeOutput(fixture('webm-cover-art'));
    expect(info.video).toMatchObject({ codec: 'vp9', width: 720, height: 1280, fps: 29.97 });
    expect(info.audio?.bitrate).toBeNull();
    expect(info.durationS).toBeNull();
    expect(info.container).toBe('matroska,webm');
  });

  it('supports the legacy rotate tag', () => {
    const info = parseFfprobeOutput({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, tags: { rotate: '90' } }],
    });
    expect(info.video).toMatchObject({ width: 720, height: 1280, rotation: 90 });
  });

  it('returns null video/audio for audio-less, video-less files', () => {
    const info = parseFfprobeOutput({ streams: [], format: { duration: '4' } });
    expect(info).toMatchObject({ video: null, audio: null, durationS: 4 });
  });

  it('rejects malformed output', () => {
    expect(() => parseFfprobeOutput({ streams: 'nope' })).toThrow(ProbeError);
  });
});

describe('cleanFfprobeError', () => {
  it('strips the demuxer address prefix and keeps the first line', () => {
    expect(
      cleanFfprobeError('[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5cab785b5040] moov atom not found\nfile.mp4: Invalid data'),
    ).toBe('moov atom not found');
    expect(cleanFfprobeError('file.mp4: No such file or directory')).toBe('file.mp4: No such file or directory');
    expect(cleanFfprobeError(undefined)).toBe('');
  });
});
