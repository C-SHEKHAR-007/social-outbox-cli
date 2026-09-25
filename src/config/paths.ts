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
