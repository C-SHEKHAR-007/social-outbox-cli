import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runExport } from '../../src/cli/commands/export.js';
import { runImport } from '../../src/cli/commands/import.js';
import { runInit } from '../../src/cli/commands/init.js';
import { runRecheck } from '../../src/cli/commands/recheck.js';
import { runScan } from '../../src/cli/commands/scan.js';
import { runSchedule } from '../../src/cli/commands/schedule.js';
import { runShow } from '../../src/cli/commands/show.js';
import { runStatus } from '../../src/cli/commands/status.js';
import { runValidate } from '../../src/cli/commands/validate.js';
import { createContext, type AppContext } from '../../src/cli/context.js';
import { CSV_COLUMNS } from '../../src/csv/columns.js';
import { parseCsv } from '../../src/csv/import-service.js';
import { MemoryTokenStore } from '../../src/facebook/token-store.js';
import { UserError } from '../../src/utils/errors.js';
import { collectOutput, HAS_FFMPEG, makeClip, makeTempDir } from '../helpers.js';

/**
 * The whole CLI workflow in-process against a real temp workspace and real ffmpeg clips:
 * init → scan → recheck → export → edit → import → validate → schedule → status → show.
 */
describe.skipIf(!HAS_FFMPEG)('CLI commands (workflow)', () => {
  let dir: string;
  let cleanup: () => void;
  let out: ReturnType<typeof collectOutput>;
  let ctx: AppContext;
  const videos = () => join(dir, 'videos');
  const fresh = () => {
    out = collectOutput();
    ctx = createContext({
      cwd: dir,
      env: { TIMEZONE: 'Asia/Kolkata' },
      print: out.print,
      tokenStore: new MemoryTokenStore(),
    });
    return ctx;
  };
  const csvPath = () => join(dir, 'exports', 'reels.csv');
  const editCsv = (edit: (rows: Record<string, string>[]) => void) => {
    const rows = parseCsv(readFileSync(csvPath(), 'utf8')).rows as Record<string, string>[];
    edit(rows);
    writeFileSync(csvPath(), stringify(rows, { header: true, columns: [...CSV_COLUMNS] }));
  };

  beforeAll(() => {
    ({ dir, cleanup } = makeTempDir());
    runInit(dir, () => {});
    makeClip(join(videos(), 'Video_1.mp4'), { size: '540x960', seconds: 3.5 });
    makeClip(join(videos(), 'sub', 'Video_2.mp4'), { size: '540x960', seconds: 4 });
    makeClip(join(videos(), 'Video_3.mp4'), { size: '320x568', seconds: 95, fps: 25 });
    writeFileSync(join(videos(), 'broken.mp4'), 'not a video');
    writeFileSync(join(videos(), 'notes.txt'), 'ignore me');
  }, 60_000);
  afterAll(() => {
    cleanup();
  });

  it('scan --dry-run reports without saving', async () => {
    const s = await runScan(fresh(), videos(), { dryRun: true });
    expect(s.newVideos).toHaveLength(3);
    expect(s.errors).toHaveLength(1);
    expect(out.text()).toContain('dry run');
    expect(runStatus(fresh()).total).toBe(0);
  });

  it('scan adds videos with targets, and rescanning is a no-op', async () => {
    await runScan(fresh(), videos());
    expect(out.text()).toContain('Targets: 2 Reel(s), 1 Page video(s)');
    expect(out.text()).toContain('broken.mp4');
    const again = await runScan(fresh(), videos());
    expect(again.newVideos).toHaveLength(0);
    expect(again.alreadyTracked).toBe(3);
  });

  it('recheck finds nothing to change right after a scan', () => {
    expect(runRecheck(fresh()).updated).toBe(0);
    expect(out.text()).toMatch(/Reels:\s+2/);
  });

  it('export writes a CSV and keeps a backup on re-export', () => {
    expect(runExport(fresh()).count).toBe(3);
    runExport(fresh());
    expect(out.text()).toContain('reels.csv.bak');
    const { rows } = parseCsv(readFileSync(csvPath(), 'utf8'));
    expect(rows.map((r) => r.publish_target)).toEqual(['REEL', 'REEL', 'VIDEO']);
  });

  it('import rejects an invalid CSV as a whole, then applies a valid one', () => {
    editCsv((rows) => {
      rows[0]!.caption = 'First reel';
      rows[0]!.action = 'SEND_NOW';
    });
    const bad = runImport(fresh(), csvPath());
    expect(bad).toMatchObject({ applied: false, code: 1 });
    expect(out.text()).toContain('Invalid action: SEND_NOW');

    editCsv((rows) => {
      rows[0]!.action = 'POST_NOW';
      rows[1]!.caption = 'दूसरी रील 💔';
      rows[1]!.hashtags = 'drama reels';
      rows[1]!.action = 'SCHEDULE';
      rows[1]!.scheduled_at = '2099-01-01 10:00';
      rows[2]!.caption = 'Long one';
      rows[2]!.action = 'SKIP';
    });
    const dry = runImport(fresh(), csvPath(), { dryRun: true });
    expect(dry).toMatchObject({ applied: false, code: 0 });
    expect(dry.plan.changes).toHaveLength(3);
    const ok = runImport(fresh(), csvPath());
    expect(ok).toMatchObject({ applied: true, code: 0 });
    expect(runStatus(fresh()).byState).toMatchObject({ READY: 2, SKIPPED: 1 });
  });

  it('validate passes READY videos and exits 0 (Facebook not configured is only a warning)', async () => {
    const { report, code } = await runValidate(fresh());
    expect(code).toBe(0);
    expect(report.videos.map((v) => v.errors)).toEqual([[], []]);
    expect(out.text()).toContain('No Facebook Page connected');
  });

  it('schedule previews, applies with --reset, and clears', () => {
    runSchedule(fresh(), { start: '2099-02-01', reset: true });
    expect(out.text()).toContain('Preview only');
    const plan = runSchedule(fresh(), { start: '2099-02-01', reset: true, apply: true });
    // scan order is alphabetical: sub/Video_2 (#1), Video_1 (#2), Video_3 (#3); only #2 is SCHEDULE
    expect(plan).toMatchObject({ rows: [{ id: 2, filename: 'Video_1.mp4' }] }); // POST_NOW and SKIP are left alone
    expect(out.text()).toContain('Saved: 1 video(s) scheduled');

    expect(runSchedule(fresh(), { clear: true, apply: true })).toBe(1);
    expect(runStatus(fresh()).byState.NEW).toBe(1);
  });

  it('schedule rejects bad options with a clear message', () => {
    expect(() => runSchedule(fresh(), { start: '01-02-2099' })).toThrow(/Invalid --start/);
    expect(() => runSchedule(fresh(), { reelSlots: '9am' })).toThrow(/Invalid --reel-slots/);
    expect(() => runSchedule(fresh(), { order: 'size' })).toThrow(/Invalid --order/);
    expect(() => runSchedule(fresh(), { target: 'story' })).toThrow(/Invalid --target/);
    expect(() => runSchedule(fresh(), { days: '0' })).toThrow(/Invalid --days/);
  });

  it('show prints one video in full', () => {
    runShow(fresh(), 2);
    const text = out.text();
    expect(text).toContain('#2 Video_1.mp4');
    expect(text).toContain('Reel (auto)');
    expect(text).toContain('दूसरी रील 💔');
    expect(text).toContain('#drama #reels');
  });

  it('commands fail with user-friendly errors', async () => {
    await expect(runScan(fresh(), join(dir, 'nope'))).rejects.toThrow(UserError);
    expect(() => runImport(fresh(), join(dir, 'missing.csv'))).toThrow(/File not found/);
    expect(() => {
      runShow(fresh(), 999);
    }).toThrow(/No video with id 999/);
  });
});
