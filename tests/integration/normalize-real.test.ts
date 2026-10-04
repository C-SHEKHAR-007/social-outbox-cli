import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffprobe } from '../../src/media/ffprobe.js';
import { checkInstagramReelSpec } from '../../src/media/instagram-spec.js';
import { normalizeForInstagram } from '../../src/media/normalize.js';
import { HAS_FFMPEG, makeTempDir } from '../helpers.js';

describe.skipIf(!HAS_FFMPEG)('normalizeForInstagram (real ffmpeg)', () => {
  let dir: string;
  let cleanup: () => void;
  beforeAll(() => ({ dir, cleanup } = makeTempDir()));
  afterAll(() => {
    cleanup();
  });

  it('re-encodes a VP9/Opus WebM into an Instagram-ready H.264/AAC MP4, then reuses the cached file', async () => {
    const src = join(dir, 'clip.webm');
    execSync(
      `ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=540x960:rate=30 -f lavfi -i sine=sample_rate=44100 ` +
        `-t 4 -c:v libvpx-vp9 -deadline realtime -b:v 300k -c:a libopus -shortest "${src}"`,
    );
    const info = await ffprobe(src);
    expect(info.video?.codec).toBe('vp9');
    const video = { fileHash: 'a'.repeat(64), filePath: src, fileSize: statSync(src).size, mediaInfo: info };

    const out = join(dir, 'normalized');
    const first = await normalizeForInstagram(video, out);
    expect(first).toMatchObject({ transcoded: true, cached: false });
    const outInfo = await ffprobe(first.path);
    expect(outInfo.video).toMatchObject({ codec: 'h264', width: 540, height: 960, pixFmt: 'yuv420p' });
    expect(outInfo.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(checkInstagramReelSpec(outInfo, statSync(first.path).size)).toEqual([]);

    const second = await normalizeForInstagram(video, out);
    expect(second).toEqual({ path: first.path, transcoded: true, cached: true });
  }, 60_000);

  it('returns the original file untouched when it already complies', async () => {
    const src = join(dir, 'ok.mp4');
    execSync(
      `ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=540x960:rate=30 -f lavfi -i sine=sample_rate=48000 ` +
        `-t 4 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -shortest "${src}"`,
    );
    const info = await ffprobe(src);
    const res = await normalizeForInstagram(
      { fileHash: 'b'.repeat(64), filePath: src, fileSize: statSync(src).size, mediaInfo: info },
      join(dir, 'n2'),
    );
    expect(res).toEqual({ path: src, transcoded: false, cached: false });
  });
});
