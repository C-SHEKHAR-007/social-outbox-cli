import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { Db } from '../db/client.js';
import type { Video } from '../db/schema.js';
import {
  findVideoByHash,
  findVideosByPath,
  insertVideo,
  listVideosUnder,
  updateVideo,
} from '../db/video-repository.js';
import type { SpecIssue } from '../domain/media.js';
import type { Probe } from '../media/ffprobe.js';
import { hasSpecErrors } from '../media/reel-spec.js';
import { checkSpecFor, chooseTarget, type TargetRules } from '../media/publish-target.js';
import type { PublishTarget } from '../domain/states.js';
import type { Logger } from '../utils/logger.js';
import { mtimeOf, sha256File } from './file-identity.js';
import { walkVideos } from './walk.js';

export interface ScanOptions {
  db: Db;
  dir: string;
  probe: Probe;
  rules?: TargetRules;
  hash?: (file: string) => Promise<string>;
  dryRun?: boolean;
  logger?: Logger;
  onProgress?: (index: number, total: number, file: string) => void;
}

export interface NewVideoReport {
  id: number | null; // null in dry-run
  path: string;
  target: PublishTarget;
  specOk: boolean;
  issues: SpecIssue[];
}

export interface ScanSummary {
  dir: string;
  found: number;
  newVideos: NewVideoReport[];
  alreadyTracked: number;
  moved: Array<{ id: number; from: string; to: string }>;
  duplicates: Array<{ path: string; existingId: number | null; existingPath: string }>;
  changedAtPath: Array<{ path: string; oldId: number }>;
  missing: Array<{ id: number; path: string }>;
  unsupported: string[];
  skippedSymlinks: string[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * Idempotent scan. A file is identified by its SHA-256; (path, size, mtime) is used as a
 * cache so unchanged files are not re-hashed.
 */
export async function scanDirectory(opts: ScanOptions): Promise<ScanSummary> {
  const { db, probe, dryRun = false, logger } = opts;
  const rules = opts.rules ?? { reelMaxDurationS: 90 };
  const hash = opts.hash ?? sha256File;
  const dir = resolve(opts.dir);
  const walk = await walkVideos(dir);

  const summary: ScanSummary = {
    dir,
    found: walk.videos.length,
    newVideos: [],
    alreadyTracked: 0,
    moved: [],
    duplicates: [],
    changedAtPath: [],
    missing: [],
    unsupported: walk.unsupported,
    skippedSymlinks: walk.skippedSymlinks,
    errors: [],
  };
  // Hashes seen in this run but not (yet) in the DB — needed for dry-run duplicate detection.
  const seenThisRun = new Map<string, string>();
  const seenPaths = new Set<string>();

  for (const [i, path] of walk.videos.entries()) {
    opts.onProgress?.(i + 1, walk.videos.length, path);
    seenPaths.add(path);
    try {
      const st = await stat(path);
      const size = st.size;
      const mtime = mtimeOf(st);
      const atPath = findVideosByPath(db, path);

      if (atPath.some((v) => v.fileSize === size && v.fileMtime === mtime)) {
        summary.alreadyTracked += 1;
        continue;
      }

      const fileHash = await hash(path);
      const existing = findVideoByHash(db, fileHash);

      if (existing) {
        if (existing.filePath === path) {
          // Same content, only mtime changed (e.g. touched/copied back).
          if (!dryRun) updateVideo(db, existing.id, { fileMtime: mtime, fileSize: size });
          summary.alreadyTracked += 1;
        } else if (!existsSync(existing.filePath)) {
          if (!dryRun) updateVideo(db, existing.id, { filePath: path, filename: basename(path), fileMtime: mtime });
          summary.moved.push({ id: existing.id, from: existing.filePath, to: path });
          logger?.info({ op: 'scan', videoId: existing.id, from: existing.filePath, to: path }, 'video moved');
        } else {
          summary.duplicates.push({ path, existingId: existing.id, existingPath: existing.filePath });
        }
        continue;
      }

      const earlier = seenThisRun.get(fileHash);
      if (earlier) {
        summary.duplicates.push({ path, existingId: null, existingPath: earlier });
        continue;
      }
      seenThisRun.set(fileHash, path);

      for (const old of atPath) summary.changedAtPath.push({ path, oldId: old.id });

      const info = await probe(path);
      const target = chooseTarget(info.durationS, rules);
      const issues = checkSpecFor(target, info, size, rules);
      const specOk = !hasSpecErrors(issues);
      let id: number | null = null;
      if (!dryRun) {
        const row = insertVideo(db, {
          fileHash,
          filePath: path,
          filename: basename(path),
          fileSize: size,
          fileMtime: mtime,
          durationS: info.durationS,
          width: info.video?.width ?? null,
          height: info.video?.height ?? null,
          fps: info.video?.avgFps ?? info.video?.fps ?? null,
          videoCodec: info.video?.codec ?? null,
          audioCodec: info.audio?.codec ?? null,
          audioSampleRate: info.audio?.sampleRate ?? null,
          audioChannels: info.audio?.channels ?? null,
          container: info.container,
          bitrate: info.bitrate,
          mediaInfo: info,
          publishTarget: target,
          specOk,
          specIssues: issues,
        });
        id = row.id;
        logger?.info({ op: 'scan', videoId: id, filename: row.filename, target, specOk }, 'video added');
      }
      summary.newVideos.push({ id, path, target, specOk, issues });
    } catch (err) {
      const message = (err as Error).message;
      if ((err as Error).name === 'UserError') throw err; // e.g. ffprobe missing: abort the whole scan
      summary.errors.push({ path, message });
      logger?.warn({ op: 'scan', path, error: message }, 'scan failed for file');
    }
  }

  summary.missing = findMissing(listVideosUnder(db, dir + sep), seenPaths, summary.moved);
  return summary;
}

function findMissing(tracked: Video[], seen: Set<string>, moved: ScanSummary['moved']): ScanSummary['missing'] {
  const movedIds = new Set(moved.map((m) => m.id));
  return tracked
    .filter((v) => !seen.has(v.filePath) && !movedIds.has(v.id) && !existsSync(v.filePath))
    .map((v) => ({ id: v.id, path: v.filePath }));
}
