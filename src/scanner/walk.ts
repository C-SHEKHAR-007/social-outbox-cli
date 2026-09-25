import { opendir } from 'node:fs/promises';
import { extname, join } from 'node:path';

export const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'];

export interface WalkResult {
  videos: string[];
  unsupported: string[];
  skippedSymlinks: string[];
}

export function isSupportedVideo(file: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(extname(file).toLowerCase());
}

/** Recursive, deterministic (sorted) walk. Hidden entries and symlinks are skipped. */
export async function walkVideos(dir: string): Promise<WalkResult> {
  const result: WalkResult = { videos: [], unsupported: [], skippedSymlinks: [] };
  async function visit(current: string): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(current)) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) result.skippedSymlinks.push(full);
      else if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) (isSupportedVideo(full) ? result.videos : result.unsupported).push(full);
    }
  }
  await visit(dir);
  return result;
}
