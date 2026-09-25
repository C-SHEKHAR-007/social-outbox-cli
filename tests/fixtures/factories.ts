import type { NewVideo } from '../../src/db/schema.js';
import type { MediaInfo } from '../../src/domain/media.js';

/** Media info for a fully Reel-compliant 1080x1920, 30 fps, AAC-LC 48 kHz clip. */
export function mediaInfo(over: Partial<MediaInfo> = {}): MediaInfo {
  return {
    durationS: 30,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitrate: 6_000_000,
    video: {
      codec: 'h264',
      profile: 'High',
      width: 1080,
      height: 1920,
      rotation: 0,
      fps: 30,
      avgFps: 30,
      pixFmt: 'yuv420p',
      fieldOrder: 'progressive',
    },
    audio: { codec: 'aac', profile: 'LC', sampleRate: 48000, channels: 2, bitrate: 128000 },
    ...over,
  };
}

let seq = 0;

/** A `videos` row with a unique hash/path; override anything. */
export function videoRow(over: Partial<NewVideo> = {}): NewVideo {
  seq += 1;
  return {
    fileHash: seq.toString(16).padStart(64, '0'),
    filePath: `/videos/Video_${seq}.mp4`,
    filename: `Video_${seq}.mp4`,
    fileSize: 1,
    fileMtime: 1,
    durationS: 30,
    specOk: true,
    ...over,
  };
}
