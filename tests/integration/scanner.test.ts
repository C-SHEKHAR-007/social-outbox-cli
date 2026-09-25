import { mkdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { videos } from '../../src/db/schema.js';
import { ProbeError, type Probe } from '../../src/media/ffprobe.js';
import { scanDirectory } from '../../src/scanner/scan-service.js';
import { makeTempDir } from '../helpers.js';
import { mediaInfo } from '../fixtures/factories.js';

const goodInfo = mediaInfo({ durationS: 10 });

describe('scanDirectory', () => {
  let h: DbHandle;
  let dir: string;
  let cleanup: () => void;
  let probeCalls: string[];
  let hashCalls: string[];
  let probe: Probe;

  const write = (rel: string, content: string) => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  const scan = (dryRun = false) =>
    scanDirectory({
      db: h.db,
      dir,
      probe,
      dryRun,
      hash: async (f) => {
        hashCalls.push(f);
        const { sha256File } = await import('../../src/scanner/file-identity.js');
        return sha256File(f);
      },
    });
  const count = () => h.db.select().from(videos).all().length;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    h = openDatabase(':memory:');
    probeCalls = [];
    hashCalls = [];
    probe = async (f) => {
      probeCalls.push(f);
      return goodInfo;
    };
  });
  afterEach(() => {
    h.close();
    cleanup();
  });

  it('adds a single video with metadata and spec result', async () => {
    const path = write('reel001.mp4', 'video-1');
    const s = await scan();
    expect(s.found).toBe(1);
    expect(s.newVideos).toHaveLength(1);
    const row = h.db.select().from(videos).get();
    expect(row).toMatchObject({
      filename: 'reel001.mp4',
      filePath: path,
      width: 1080,
      height: 1920,
      durationS: 10,
      specOk: true,
      state: 'NEW',
    });
    expect(row?.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.mediaInfo).toEqual(goodInfo);
  });

  it('adds 10 videos in nested folders and ignores unsupported files', async () => {
    for (let i = 0; i < 10; i++)
      write(`${i < 5 ? 'a' : 'b/c'}/reel${i}.${['mp4', 'MOV', 'webm', 'm4v'][i % 4]}`, `v${i}`);
    write('notes.txt', 'x');
    write('thumb.jpg', 'x');
    write('.hidden/secret.mp4', 'hidden');
    const s = await scan();
    expect(s.found).toBe(10);
    expect(s.newVideos).toHaveLength(10);
    expect(s.unsupported).toHaveLength(2);
    expect(count()).toBe(10);
  });

  it('is idempotent: rescanning adds nothing and does not re-hash unchanged files', async () => {
    write('a.mp4', 'A');
    write('b.mp4', 'B');
    await scan();
    hashCalls = [];
    probeCalls = [];
    const s = await scan();
    expect(s.newVideos).toHaveLength(0);
    expect(s.alreadyTracked).toBe(2);
    expect(hashCalls).toEqual([]);
    expect(probeCalls).toEqual([]);
    expect(count()).toBe(2);
  });

  it('reports duplicate content within one scan and against the DB', async () => {
    write('a.mp4', 'SAME');
    write('copy/a-copy.mp4', 'SAME');
    const first = await scan();
    expect(first.newVideos).toHaveLength(1);
    expect(first.duplicates).toHaveLength(1);
    expect(count()).toBe(1);

    write('later-copy.mp4', 'SAME');
    const second = await scan();
    expect(second.duplicates.map((d) => d.existingId)).toContain(1);
    expect(count()).toBe(1);
  });

  it('detects a moved/renamed file and updates its path instead of duplicating', async () => {
    const from = write('old/reel.mp4', 'MOVE-ME');
    await scan();
    const to = join(dir, 'new-name.mp4');
    renameSync(from, to);
    const s = await scan();
    expect(s.moved).toEqual([{ id: 1, from, to }]);
    expect(s.newVideos).toHaveLength(0);
    expect(s.missing).toHaveLength(0);
    const row = h.db.select().from(videos).get();
    expect(row).toMatchObject({ filePath: to, filename: 'new-name.mp4', version: 2 });
  });

  it('reports missing files without deleting records', async () => {
    const path = write('gone.mp4', 'G');
    await scan();
    rmSync(path);
    const s = await scan();
    expect(s.missing).toEqual([{ id: 1, path }]);
    expect(count()).toBe(1);
  });

  it('re-hashes a touched file but keeps it as the same video', async () => {
    const path = write('t.mp4', 'T');
    await scan();
    utimesSync(path, new Date(), new Date(Date.now() + 60_000));
    hashCalls = [];
    const s = await scan();
    expect(hashCalls).toEqual([path]);
    expect(s.alreadyTracked).toBe(1);
    expect(s.newVideos).toHaveLength(0);
  });

  it('adds replaced content at a tracked path as a new video and flags it', async () => {
    const path = write('same-name.mp4', 'v1');
    await scan();
    writeFileSync(path, 'v2 different content');
    const s = await scan();
    expect(s.newVideos).toHaveLength(1);
    expect(s.changedAtPath).toEqual([{ path, oldId: 1 }]);
    expect(count()).toBe(2);
  });

  it('dry-run writes nothing but reports the same outcome', async () => {
    write('a.mp4', 'A');
    write('dup.mp4', 'A');
    const s = await scan(true);
    expect(s.newVideos).toHaveLength(1);
    expect(s.newVideos[0]?.id).toBeNull();
    expect(s.duplicates).toHaveLength(1);
    expect(count()).toBe(0);
  });

  it('assigns Page video target to long videos and checks them with Page video rules', async () => {
    probe = async (f) => ({ ...goodInfo, durationS: f.endsWith('long.mp4') ? 420 : 30 });
    write('long.mp4', 'L');
    write('short.mp4', 'S');
    const s = await scanDirectory({ db: h.db, dir, probe, rules: { reelMaxDurationS: 90 } });
    expect(s.newVideos.map((v) => [v.path.split('/').pop(), v.target, v.specOk])).toEqual([
      ['long.mp4', 'VIDEO', true],
      ['short.mp4', 'REEL', true],
    ]);
  });

  it('records spec failures but still tracks the video', async () => {
    probe = async () => ({ ...goodInfo, durationS: 1 });
    write('short.mp4', 'S');
    const s = await scan();
    expect(s.newVideos[0]?.specOk).toBe(false);
    const row = h.db.select().from(videos).get();
    expect(row?.specOk).toBe(false);
    expect(row?.specIssues?.map((i) => i.code)).toContain('DURATION_TOO_SHORT');
  });

  it('continues past unreadable files and retries them on the next scan', async () => {
    write('bad.mp4', 'corrupt');
    write('good.mp4', 'fine');
    probe = async (f) => {
      if (f.endsWith('bad.mp4')) throw new ProbeError('Invalid data found when processing input');
      return goodInfo;
    };
    const s = await scan();
    expect(s.errors).toEqual([{ path: join(dir, 'bad.mp4'), message: 'Invalid data found when processing input' }]);
    expect(count()).toBe(1);

    probe = async () => goodInfo;
    const again = await scan();
    expect(again.newVideos).toHaveLength(1);
    expect(count()).toBe(2);
  });

  it('skips symlinks', async () => {
    const target = write('real.mp4', 'R');
    symlinkSync(target, join(dir, 'link.mp4'));
    const s = await scan();
    expect(s.found).toBe(1);
    expect(s.skippedSymlinks).toHaveLength(1);
  });
});
