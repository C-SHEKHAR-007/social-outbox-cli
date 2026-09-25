import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';

/** Content identity of a video: SHA-256 of the whole file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Whole-millisecond mtime, the form stored in `videos.file_mtime`. */
export function mtimeOf(stats: Stats): number {
  return Math.trunc(stats.mtimeMs);
}

/** True if size and mtime match what was recorded at scan time (so re-hashing can be skipped). */
export function looksUnchanged(stats: Stats, recorded: { fileSize: number; fileMtime: number }): boolean {
  return stats.size === recorded.fileSize && mtimeOf(stats) === recorded.fileMtime;
}
