import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface WorkspacePaths {
  root: string;
  videos: string;
  data: string;
  normalized: string;
  exports: string;
  logs: string;
  config: string;
  db: string;
  logFile: string;
  envFile: string;
  pageProfile: string;
}

/** Directories `init` creates, relative to the workspace root. */
export const WORKSPACE_DIRS = ['videos', 'data', 'data/normalized', 'exports', 'logs', 'config'];

/** Folder name used for the workspace when the CLI is run from the project (package) folder itself. */
export const PROJECT_WORKSPACE_DIR = 'workspace';

function real(p: string): string {
  return existsSync(p) ? realpathSync(p) : resolve(p);
}

/**
 * Where runtime data (.env, data/, exports/, logs/, config/, videos/) lives:
 * 1. `REEL_WORKSPACE` (absolute, or relative to the current folder) if set;
 * 2. `<project>/workspace` when run from the project folder, so code and data stay apart;
 * 3. otherwise the current folder (as before).
 */
export function resolveWorkspaceRoot(cwd: string, packageRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.REEL_WORKSPACE?.trim();
  if (override) return resolve(cwd, override);
  if (real(cwd) === real(packageRoot)) return join(real(packageRoot), PROJECT_WORKSPACE_DIR);
  return cwd;
}

export function resolvePaths(root: string, databaseUrl = './data/reels.db'): WorkspacePaths {
  return {
    root,
    videos: join(root, 'videos'),
    data: join(root, 'data'),
    normalized: join(root, 'data', 'normalized'),
    exports: join(root, 'exports'),
    logs: join(root, 'logs'),
    config: join(root, 'config'),
    db: databaseUrl === ':memory:' || isAbsolute(databaseUrl) ? databaseUrl : resolve(root, databaseUrl),
    logFile: join(root, 'logs', 'publisher.log'),
    envFile: join(root, '.env'),
    pageProfile: join(root, 'config', 'page-profile.yaml'),
  };
}
