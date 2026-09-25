import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'reel-cli-test-'));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function collectOutput(): { print: (line?: string) => void; text: () => string } {
  const lines: string[] = [];
  return { print: (line = '') => lines.push(line), text: () => lines.join('\n') };
}

export const MIGRATION_COUNT = (
  JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: unknown[] }
).entries.length;

export const HAS_FFMPEG = (() => {
  try {
    execSync('ffmpeg -version && ffprobe -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Generates a small test clip with ffmpeg (lavfi sources, no input files needed). */
export function makeClip(file: string, opts: { size: string; seconds: number; fps?: number; audio?: boolean }): void {
  mkdirSync(dirname(file), { recursive: true });
  const audio = opts.audio === false ? '' : '-f lavfi -i sine=sample_rate=48000 -c:a aac -b:a 128k -ac 2 -shortest';
  execSync(
    `ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=${opts.size}:rate=${opts.fps ?? 30} ${audio} ` +
      `-t ${opts.seconds} -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${file}"`,
  );
}
