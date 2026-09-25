import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { PACKAGE_ROOT } from '../utils/package-root.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

export const MIGRATIONS_FOLDER = join(PACKAGE_ROOT, 'drizzle');

/** Opens (creating if needed) the SQLite database and applies pending migrations. */
export function openDatabase(file: string): DbHandle {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite, close: () => sqlite.close() };
}

export function appliedMigrationCount(sqlite: Database.Database): number {
  const row = sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number };
  return row.n;
}

/** Runs `fn` in one SQLite transaction; any throw rolls everything back. */
export function runInTransaction<T>(db: Db, fn: (tx: Db) => T): T {
  // Drizzle's transaction handle exposes the same query API as the database itself.
  return db.transaction((tx) => fn(tx as unknown as Db));
}
