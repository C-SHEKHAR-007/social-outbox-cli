/** Normalized ffprobe result. Width/height are *display* dimensions (rotation applied). */
export interface MediaInfo {
  durationS: number | null;
  container: string | null; // ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
  bitrate: number | null;
  video: {
    codec: string;
    profile: string | null;
    width: number;
    height: number;
    rotation: number; // degrees, normalized to 0/90/180/270
    fps: number | null; // r_frame_rate
    avgFps: number | null; // avg_frame_rate
    pixFmt: string | null;
    fieldOrder: string | null;
  } | null;
  audio: {
    codec: string;
    profile: string | null;
    sampleRate: number | null;
    channels: number | null;
    bitrate: number | null;
  } | null;
}

export type SpecLevel = 'error' | 'warning';

export interface SpecIssue {
  level: SpecLevel;
  code: string;
  message: string;
}
