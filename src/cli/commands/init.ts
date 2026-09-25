import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig } from '../../config/env.js';
import { resolvePaths, WORKSPACE_DIRS } from '../../config/paths.js';
import { appliedMigrationCount, openDatabase } from '../../db/client.js';
import { PACKAGE_ROOT } from '../../utils/package-root.js';

export interface InitResult {
  created: string[];
  existing: string[];
  dbPath: string;
  migrations: number;
}

/** Idempotent: creates missing folders/templates, never overwrites existing files. */
export function runInit(cwd: string, print: (line?: string) => void = console.log): InitResult {
  const created: string[] = [];
  const existing: string[] = [];

  for (const dir of WORKSPACE_DIRS) {
    const full = join(cwd, dir);
    if (existsSync(full)) existing.push(`${dir}/`);
    else {
      mkdirSync(full, { recursive: true });
      created.push(`${dir}/`);
    }
  }

  const templates: Array<[source: string, target: string]> = [
    [join(PACKAGE_ROOT, '.env.example'), '.env'],
    [join(PACKAGE_ROOT, 'config', 'page-profile.example.yaml'), join('config', 'page-profile.yaml')],
  ];
  for (const [source, target] of templates) {
    const full = join(cwd, target);
    if (existsSync(full)) existing.push(target);
    else {
      copyFileSync(source, full);
      created.push(target);
    }
  }

  // Config is loaded only now so a freshly-copied .env is picked up.
  const config = loadConfig(cwd);
  const paths = resolvePaths(cwd, config.databaseUrl);
  const handle = openDatabase(paths.db);
  const migrations = appliedMigrationCount(handle.sqlite);
  handle.close();

  print(`Initializing reel-cli workspace in ${cwd}`);
  print();
  for (const item of created) print(`  ✓ created  ${item}`);
  for (const item of existing) print(`  · exists   ${item}`);
  print(`  ✓ database ${relative(cwd, paths.db) || paths.db} (${migrations} migration(s) applied)`);
  print();
  print('Next: fill in .env, then run `reel-cli doctor`.');

  return { created, existing, dbPath: paths.db, migrations };
}
