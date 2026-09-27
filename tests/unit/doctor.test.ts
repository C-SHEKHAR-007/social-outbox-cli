import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { MemoryTokenStore } from '../../src/facebook/token-store.js';
import { checkNode, runChecks, type RunCommand } from '../../src/doctor/checks.js';
import { collectOutput, makeTempDir, MIGRATION_COUNT } from '../helpers.js';

const allBinaries: RunCommand = async (cmd) => `${cmd} version 1.0\nmore`;
const noBinaries: RunCommand = async () => {
  throw new Error('ENOENT');
};
const ollamaWith = (models: string[]) =>
  (async () => new Response(JSON.stringify({ models: models.map((name) => ({ name })) }))) as unknown as typeof fetch;
const ollamaDown = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

const byName = (results: Awaited<ReturnType<typeof runChecks>>) => Object.fromEntries(results.map((r) => [r.name, r]));

describe('checkNode', () => {
  it.each([
    ['20.5.0', 'ok'],
    ['20.20.2', 'ok'],
    ['22.1.0', 'ok'],
    ['20.4.9', 'fail'],
    ['18.19.0', 'fail'],
  ])('%s → %s', (v, status) => {
    expect(checkNode(v).status).toBe(status);
  });
});

describe('runChecks', () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
  });

  it('reports an uninitialized workspace and missing ffmpeg as failures', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const r = byName(
      await runChecks({
        cwd: tmp.dir,
        env: {},
        run: noBinaries,
        fetch: ollamaDown,
        nodeVersion: '20.20.2',
        tokenStore: new MemoryTokenStore(),
      }),
    );
    expect(r.ffprobe?.status).toBe('fail');
    expect(r.ffmpeg?.status).toBe('fail');
    expect(r.database?.status).toBe('fail');
    expect(r.database?.detail).toContain('reel-cli init');
    expect(r.ollama?.status).toBe('warn');
    expect(r.whisper?.status).toBe('warn');
  });

  it('passes required checks on an initialized workspace', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    runInit(tmp.dir, () => {});
    const r = byName(
      await runChecks({
        cwd: tmp.dir,
        env: {},
        run: allBinaries,
        fetch: ollamaWith(['qwen3:8b']),
        nodeVersion: '20.20.2',
        tokenStore: new MemoryTokenStore(),
      }),
    );
    expect(Object.values(r).filter((c) => c.status === 'fail')).toEqual([]);
    expect(r.database?.detail).toBe(`0 video(s), ${MIGRATION_COUNT} migration(s)`);
    expect(r.ollama?.status).toBe('ok');
    expect(r.facebook?.status).toBe('warn');
  });

  it('warns when the Ollama model is not pulled', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const r = byName(
      await runChecks({
        cwd: tmp.dir,
        env: {},
        run: allBinaries,
        fetch: ollamaWith(['llama3:latest']),
        nodeVersion: '20.20.2',
        tokenStore: new MemoryTokenStore(),
      }),
    );
    expect(r.ollama?.status).toBe('warn');
    expect(r.ollama?.detail).toContain('ollama pull qwen3:8b');
  });

  it('stops after a config failure', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    writeFileSync(join(tmp.dir, '.env'), 'TIMEZONE=Nowhere/Land\n');
    const results = await runChecks({
      cwd: tmp.dir,
      env: {},
      run: allBinaries,
      fetch: ollamaDown,
      nodeVersion: '20.20.2',
      tokenStore: new MemoryTokenStore(),
    });
    expect(results.map((r) => r.name)).toEqual(['node', 'workspace', 'config']);
    expect(results[2]?.status).toBe('fail');
  });
});

describe('runDoctor', () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
  });

  it('prints one line per check and returns exit code 1 on failures', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const out = collectOutput();
    const code = await runDoctor(
      {
        cwd: tmp.dir,
        env: {},
        run: noBinaries,
        fetch: ollamaDown,
        nodeVersion: '20.20.2',
        tokenStore: new MemoryTokenStore(),
      },
      out.print,
    );
    expect(code).toBe(1);
    expect(out.text()).toMatch(/✗ ffprobe\s+not found/);
    expect(out.text()).toMatch(/3 problem\(s\), 3 warning\(s\)\./);
  });

  it('returns 0 when only warnings remain', async () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    runInit(tmp.dir, () => {});
    const out = collectOutput();
    const code = await runDoctor(
      {
        cwd: tmp.dir,
        env: {},
        run: allBinaries,
        fetch: ollamaDown,
        nodeVersion: '20.20.2',
        tokenStore: new MemoryTokenStore(),
      },
      out.print,
    );
    expect(code).toBe(0);
    expect(out.text()).toContain('All required checks passed');
  });
});
