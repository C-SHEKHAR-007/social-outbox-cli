import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { MediaInfo } from '../domain/media.js';
import { ffprobe, type Probe } from './ffprobe.js';
import { checkInstagramReelSpec, INSTAGRAM_REEL_SPEC, needsInstagramTranscode } from './instagram-spec.js';

/** Keep re-encoded files under Instagram's 300 MB with some margin. */
const TARGET_MAX_BYTES = 280 * 1024 * 1024;

/**
 * ffmpeg arguments that turn any input into an Instagram-ready MP4: H.264 High, 4:2:0, constant frame
 * rate (23–60), width ≤ 1920 (even dimensions), closed GOP, AAC 48 kHz stereo, moov atom first, and a
 * bitrate cap so long videos stay under 300 MB.
 */
export function instagramTranscodeArgs(input: string, output: string, info: MediaInfo): string[] {
  const fpsIn = info.video?.avgFps ?? info.video?.fps ?? 30;
  const fps = fpsIn < INSTAGRAM_REEL_SPEC.minFps ? 24 : fpsIn > INSTAGRAM_REEL_SPEC.maxFps ? 30 : Math.round(fpsIn);
  const width = info.video?.width ?? 0;
  const scale =
    width > INSTAGRAM_REEL_SPEC.maxWidth
      ? `scale=${INSTAGRAM_REEL_SPEC.maxWidth}:-2`
      : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const duration = Math.max(1, info.durationS ?? 60);
  const maxKbps = Math.max(800, Math.min(8000, Math.floor(((TARGET_MAX_BYTES * 8) / duration / 1000) * 0.9) - 160));
  const audio = info.audio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an'];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-map',
    '0:v:0',
    ...audio,
    '-vf',
    `${scale},fps=${fps},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-profile:v',
    'high',
    '-maxrate',
    `${maxKbps}k`,
    '-bufsize',
    `${maxKbps * 2}k`,
    '-g',
    String(fps * 2),
    '-keyint_min',
    String(fps * 2),
    '-sc_threshold',
    '0',
    '-flags',
    '+cgop',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

export interface NormalizeInput {
  fileHash: string;
  filePath: string;
  fileSize: number;
  mediaInfo: MediaInfo;
}

export interface NormalizeResult {
  path: string;
  transcoded: boolean;
  /** true when an earlier run already produced the file */
  cached: boolean;
}

export type RunFfmpeg = (args: string[]) => Promise<void>;

const defaultFfmpeg: RunFfmpeg = async (args) => {
  await execa('ffmpeg', args, { timeout: 60 * 60_000 });
};

/**
 * Returns a file Instagram accepts: the original if it already complies, otherwise an H.264/AAC copy in
 * `outDir` (cached by content hash, written atomically). The original file is never modified.
 */
export async function normalizeForInstagram(
  video: NormalizeInput,
  outDir: string,
  deps: { ffmpeg?: RunFfmpeg; probe?: Probe } = {},
): Promise<NormalizeResult> {
  if (!needsInstagramTranscode(video.mediaInfo, video.fileSize))
    return { path: video.filePath, transcoded: false, cached: false };
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${video.fileHash.slice(0, 16)}.instagram.mp4`);
  if (existsSync(out) && statSync(out).size > 0) return { path: out, transcoded: true, cached: true };

  const part = `${out}.part`;
  rmSync(part, { force: true });
  try {
    await (deps.ffmpeg ?? defaultFfmpeg)(instagramTranscodeArgs(video.filePath, part, video.mediaInfo));
  } catch (err) {
    rmSync(part, { force: true });
    throw new Error(`re-encoding for Instagram failed: ${(err as Error).message.split('\n')[0] ?? 'ffmpeg error'}`);
  }
  const info = await (deps.probe ?? ffprobe)(part);
  const left = checkInstagramReelSpec(info, statSync(part).size).filter((i) => i.fixable);
  if (left.length) {
    rmSync(part, { force: true });
    throw new Error(`re-encoded file still not Instagram-ready: ${left.map((i) => i.message).join('; ')}`);
  }
  renameSync(part, out);
  return { path: out, transcoded: true, cached: false };
}
