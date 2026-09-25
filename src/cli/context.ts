import { existsSync } from 'node:fs';
import { loadConfig, type AppConfig } from '../config/env.js';
import { resolvePaths, type WorkspacePaths } from '../config/paths.js';
import { openDatabase, type Db, type DbHandle } from '../db/client.js';
import { UserError } from '../utils/errors.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { createTokenStore, type TokenStore } from '../facebook/token-store.js';
import { join } from 'node:path';

export interface AppContext {
  cwd: string;
  config: AppConfig;
  paths: WorkspacePaths;
  logger: Logger;
  print: (line?: string) => void;
  /** Opens the workspace database; fails if `init` has not been run. Caller must close it. */
  openDb(): DbHandle;
  /** Runs `fn` with an open database and always closes it afterwards. */
  withDb<T>(fn: (db: Db) => T): T;
  withDbAsync<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** OS keychain, or a 0600 file in data/ when no keychain is available. Created on first use. */
  tokenStore(): TokenStore;
}

export function createContext(opts: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  print?: (line?: string) => void;
  /** Override the token store (tests use MemoryTokenStore so the real keychain is never touched). */
  tokenStore?: TokenStore;
}): AppContext {
  const config = loadConfig(opts.cwd, opts.env);
  const paths = resolvePaths(opts.cwd, config.databaseUrl);
  const logger = createLogger({ level: config.logLevel, file: paths.logFile });
  const openDb = (): DbHandle => {
    if (paths.db !== ':memory:' && !existsSync(paths.db)) {
      throw new UserError(`Workspace not initialized (no database at ${paths.db}). Run: reel-cli init`);
    }
    return openDatabase(paths.db);
  };
  let tokens: TokenStore | undefined = opts.tokenStore;
  return {
    cwd: opts.cwd,
    config,
    paths,
    logger,
    print:
      opts.print ??
      ((line = '') => {
        console.log(line);
      }),
    openDb,
    tokenStore: () => (tokens ??= createTokenStore(join(paths.data, 'credentials.json'))),
    withDb(fn) {
      const handle = openDb();
      try {
        return fn(handle.db);
      } finally {
        handle.close();
      }
    },
    async withDbAsync(fn) {
      const handle = openDb();
      try {
        return await fn(handle.db);
      } finally {
        handle.close();
      }
    },
  };
}
