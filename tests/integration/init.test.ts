import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { collectOutput, makeTempDir, MIGRATION_COUNT } from '../helpers.js';

describe('init', () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
  });

  it('creates the workspace and is idempotent', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;

    const first = runInit(tmp.dir, () => {});
    for (const p of [
      'videos',
      'data',
      'data/normalized',
      'exports',
      'logs',
      'config',
      '.env',
      'config/page-profile.yaml',
      'data/reels.db',
    ]) {
      expect(existsSync(join(tmp.dir, p)), p).toBe(true);
    }
    expect(first.created).toContain('.env');
    expect(first.migrations).toBe(MIGRATION_COUNT);

    // user edits .env; a second init must not overwrite it
    writeFileSync(join(tmp.dir, '.env'), 'OLLAMA_MODEL=custom\n');
    const out = collectOutput();
    const second = runInit(tmp.dir, out.print);
    expect(second.created).toEqual([]);
    expect(second.existing).toContain('.env');
    expect(readFileSync(join(tmp.dir, '.env'), 'utf8')).toBe('OLLAMA_MODEL=custom\n');
    expect(out.text()).toContain('exists   .env');
  });
});
