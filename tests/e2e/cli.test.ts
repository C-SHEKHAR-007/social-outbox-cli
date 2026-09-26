import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PACKAGE_ROOT } from '../../src/utils/package-root.js';
import { HAS_FFMPEG, makeTempDir } from '../helpers.js';

const ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
// Resolve tsx from this project, not from the temp workspace the CLI runs in.
const TSX = import.meta.resolve('tsx');

/** Runs the real CLI entry point (via tsx) in `cwd`; never throws on non-zero exit. */
const cli = (cwd: string, ...args: string[]) =>
  execa('node', ['--import', TSX, ENTRY, ...args], { cwd, reject: false, env: { NO_COLOR: '1' } });

describe('reel-cli binary', () => {
  let dir: string;
  let cleanup: () => void;
  beforeAll(() => ({ dir, cleanup } = makeTempDir()));
  afterAll(() => {
    cleanup();
  });

  it('prints help and version', async () => {
    const help = await cli(dir, '--help');
    expect(help.exitCode).toBe(0);
    for (const cmd of [
      'init',
      'doctor',
      'scan',
      'recheck',
      'schedule',
      'export',
      'import',
      'validate',
      'show',
      'status',
      'publish',
      'reconcile',
      'retry',
      'resume',
      'facebook',
    ]) {
      expect(help.stdout).toContain(cmd);
    }
    expect((await cli(dir, '--version')).stdout).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits 1 with a clear message before init', async () => {
    const r = await cli(dir, 'status');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Workspace not initialized');
  });

  it('exits 1 on an unknown command', async () => {
    const r = await cli(dir, 'publsh');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command 'publsh'");
  });

  it('init, then status/validate succeed on an empty workspace', async () => {
    expect((await cli(dir, 'init')).exitCode).toBe(0);
    const status = await cli(dir, 'status');
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/Total:\s+0/);
    const validate = await cli(dir, 'validate');
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain('Nothing to validate');
  });

  it.skipIf(!HAS_FFMPEG)('doctor exits 0 when required tools are present', async () => {
    const r = await cli(dir, 'doctor');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('All required checks passed');
  });

  it('import of a missing file and a bad --ids exit 1', async () => {
    expect((await cli(dir, 'import', 'nope.csv')).exitCode).toBe(1);
    const ids = await cli(dir, 'validate', '--ids', 'abc');
    expect(ids.exitCode).toBe(1);
    expect(ids.stderr).toContain('Invalid id: abc');
  });
});
