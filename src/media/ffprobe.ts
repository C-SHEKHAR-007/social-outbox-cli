import { execa } from 'execa';
import { z } from 'zod';
import type { MediaInfo } from '../domain/media.js';
import { UserError } from '../utils/errors.js';

const num = z.union([z.string(), z.number()]).optional();

const StreamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  profile: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  r_frame_rate: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  pix_fmt: z.string().optional(),
  field_order: z.string().optional(),
  sample_rate: num,
  channels: z.number().optional(),
  bit_rate: num,
  duration: num,
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() }).loose()).optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).loose().optional(),
});

export const FfprobeOutputSchema = z.object({
  streams: z.array(StreamSchema).default([]),
  format: z.object({ format_name: z.string().optional(), duration: num, bit_rate: num }).optional(),
});

export type FfprobeOutput = z.infer<typeof FfprobeOutputSchema>;

export class ProbeError extends Error {
  override readonly name = 'ProbeError';
}

function toNumber(v: string | number | undefined): number | null {
  if (v === undefined || v === '' || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parses "30000/1001" → 29.97; "0/0" → null. */
export function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [a, b] = rate.split('/').map(Number);
  if (a === undefined || !Number.isFinite(a)) return null;
  if (b === undefined) return a > 0 ? a : null;
  if (!Number.isFinite(b) || b === 0 || a === 0) return null;
  return Math.round((a / b) * 1000) / 1000;
}

function normalizeRotation(stream: z.infer<typeof StreamSchema>): number {
  const raw =
    stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? toNumber(stream.tags?.rotate) ?? 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

/** Pure: converts raw ffprobe JSON into MediaInfo. */
export function parseFfprobeOutput(raw: unknown): MediaInfo {
  const parsed = FfprobeOutputSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProbeError(`unexpected ffprobe output: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const { streams, format } = parsed.data;

  // Ignore embedded cover art, which ffprobe reports as a video stream.
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');

  let video: MediaInfo['video'] = null;
  if (v && v.width && v.height) {
    const rotation = normalizeRotation(v);
    const swap = rotation === 90 || rotation === 270;
    video = {
      codec: v.codec_name ?? 'unknown',
      profile: v.profile ?? null,
      width: swap ? v.height : v.width,
      height: swap ? v.width : v.height,
      rotation,
      fps: parseFrameRate(v.r_frame_rate),
      avgFps: parseFrameRate(v.avg_frame_rate),
      pixFmt: v.pix_fmt ?? null,
      fieldOrder: v.field_order ?? null,
    };
  }

  const audio: MediaInfo['audio'] = a
    ? {
        codec: a.codec_name ?? 'unknown',
        profile: a.profile ?? null,
        sampleRate: toNumber(a.sample_rate),
        channels: a.channels ?? null,
        bitrate: toNumber(a.bit_rate),
      }
    : null;

  return {
    durationS: toNumber(format?.duration) ?? toNumber(v?.duration),
    container: format?.format_name ?? null,
    bitrate: toNumber(format?.bit_rate),
    video,
    audio,
  };
}

/** "[mov,mp4 @ 0x5c…] moov atom not found" → "moov atom not found". */
export function cleanFfprobeError(stderr: string | undefined): string {
  const first = stderr?.trim().split('\n')[0] ?? '';
  return first.replace(/^\[[^\]]*@ 0x[0-9a-f]+\]\s*/i, '').trim();
}

export type Probe = (file: string) => Promise<MediaInfo>;

export const ffprobe: Probe = async (file) => {
  let stdout: string;
  try {
    ({ stdout } = await execa(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      {
        timeout: 60_000,
      },
    ));
  } catch (err) {
    const e = err as { code?: string; stderr?: string; shortMessage?: string };
    if (e.code === 'ENOENT')
      throw new UserError('ffprobe not found on PATH. Install ffmpeg (e.g. sudo apt install ffmpeg).');
    throw new ProbeError(cleanFfprobeError(e.stderr) || e.shortMessage || 'ffprobe failed');
  }
  return parseFfprobeOutput(JSON.parse(stdout));
};

export async function assertFfprobeAvailable(): Promise<void> {
  try {
    await execa('ffprobe', ['-version'], { timeout: 10_000 });
  } catch {
    throw new UserError('ffprobe not found on PATH. Install ffmpeg (e.g. sudo apt install ffmpeg).');
  }
}
