import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffprobe, ProbeError } from '../../src/media/ffprobe.js';
import { checkReelSpec } from '../../src/media/reel-spec.js';
import { makeTempDir } from '../helpers.js';

const hasFfmpeg = (() => {
  try {
    execSync('ffmpeg -version && ffprobe -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('ffprobe (real binary)', () => {
  let dir: string;
  let cleanup: () => void;
  const make = (name: string, args: string) => {
    const out = join(dir, name);
    execSync(`ffmpeg -hide_banner -loglevel error -y ${args} "${out}"`);
    return out;
  };

  beforeAll(() => ({ dir, cleanup } = makeTempDir()));
  afterAll(() => {
    cleanup();
  });

  it('reads a compliant vertical clip', async () => {
    const file = make(
      'ok.mp4',
      '-f lavfi -i testsrc2=size=540x960:rate=30 -f lavfi -i sine=sample_rate=48000 -t 3.2 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -shortest',
    );
    const info = await ffprobe(file);
    expect(info.video).toMatchObject({ codec: 'h264', width: 540, height: 960, fps: 30, pixFmt: 'yuv420p' });
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(info.durationS).toBeGreaterThan(3);
    expect(checkReelSpec(info).filter((i) => i.level === 'error')).toEqual([]);
  });

  it('flags a short landscape clip without audio', async () => {
    const file = make('bad.mp4', '-f lavfi -i testsrc2=size=640x360:rate=30 -t 1 -c:v libx264 -pix_fmt yuv420p');
    const codes = checkReelSpec(await ffprobe(file)).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['DURATION_TOO_SHORT', 'ASPECT_RATIO', 'RESOLUTION_TOO_LOW', 'NO_AUDIO']),
    );
  });

  it('throws ProbeError for a non-video file', async () => {
    const file = join(dir, 'fake.mp4');
    execSync(`echo "not a video" > "${file}"`);
    await expect(ffprobe(file)).rejects.toBeInstanceOf(ProbeError);
  });
});
