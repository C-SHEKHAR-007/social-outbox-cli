import { existsSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { assertFfprobeAvailable, ffprobe } from '../../media/ffprobe.js';
import { scanDirectory, type ScanSummary } from '../../scanner/scan-service.js';
import { UserError } from '../../utils/errors.js';
import { resolveUserPath, type AppContext } from '../context.js';

const MAX_LISTED = 10;

export async function runScan(
  ctx: AppContext,
  dir: string,
  opts: { dryRun?: boolean; progress?: boolean } = {},
): Promise<ScanSummary> {
  const input = dir;
  dir = resolveUserPath(ctx, input);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UserError(`Not a directory: ${input}`);
  await assertFfprobeAvailable();

  return ctx.withDbAsync(async (db) => {
    ctx.print(`Scanning ${dir}${opts.dryRun ? ' (dry run — nothing will be saved)' : ''}...`);
    const summary = await scanDirectory({
      db: db,
      dir,
      probe: ffprobe,
      rules: { reelMaxDurationS: ctx.config.publishing.reelMaxDurationS },
      dryRun: opts.dryRun ?? false,
      logger: ctx.logger,
      onProgress: opts.progress
        ? (i, total, file) => process.stderr.write(`\r\x1b[K  [${i}/${total}] ${relative(dir, file)}`)
        : undefined,
    });
    if (opts.progress) process.stderr.write('\r\x1b[K');
    render(summary, ctx.print, ctx.cwd);
    ctx.logger.info(
      {
        op: 'scan',
        dir: summary.dir,
        dryRun: !!opts.dryRun,
        found: summary.found,
        new: summary.newVideos.length,
        duplicates: summary.duplicates.length,
        errors: summary.errors.length,
      },
      'scan complete',
    );
    return summary;
  });
}

function render(s: ScanSummary, print: (line?: string) => void, cwd: string): void {
  const rel = (p: string) => (p.startsWith(cwd) ? relative(cwd, p) : p);
  const line = (label: string, n: number) => {
    print(`${`${label}:`.padEnd(17)}${String(n).padStart(5)}`);
  };
  const specBad = s.newVideos.filter((v) => !v.specOk);

  print();
  line('Found', s.found);
  line('New', s.newVideos.length);
  line('Already tracked', s.alreadyTracked);
  if (s.moved.length) line('Moved', s.moved.length);
  if (s.duplicates.length) line('Duplicates', s.duplicates.length);
  if (s.missing.length) line('Missing', s.missing.length);
  if (s.errors.length) line('Errors', s.errors.length);
  if (s.unsupported.length) print(`(${s.unsupported.length} unsupported file(s) ignored)`);
  if (s.skippedSymlinks.length) print(`(${s.skippedSymlinks.length} symlink(s) skipped)`);

  if (s.newVideos.length) {
    print();
    const reels = s.newVideos.filter((v) => v.target === 'REEL').length;
    print(`Targets: ${reels} Reel(s), ${s.newVideos.length - reels} Page video(s) (longer than the Reel limit)`);
    print(`Spec check: ${s.newVideos.length - specBad.length} OK, ${specBad.length} with problems`);
    for (const v of specBad.slice(0, MAX_LISTED)) {
      print(`  ✗ ${v.id ? `#${v.id} ` : ''}${rel(v.path)} (${v.target})`);
      for (const issue of v.issues.filter((i) => i.level === 'error')) print(`      ${issue.message}`);
    }
    if (specBad.length > MAX_LISTED) print(`  … and ${specBad.length - MAX_LISTED} more`);
  }

  section(
    print,
    'Moved',
    s.moved.map((m) => `#${m.id} ${rel(m.from)} → ${rel(m.to)}`),
  );
  section(
    print,
    'Duplicates (same content, not added)',
    s.duplicates.map((d) => `${rel(d.path)} = ${d.existingId ? `#${d.existingId} ` : ''}${rel(d.existingPath)}`),
  );
  section(
    print,
    'Changed content at a tracked path (added as new video)',
    s.changedAtPath.map((c) => `${rel(c.path)} (previous record #${c.oldId})`),
  );
  section(
    print,
    'Missing (tracked, file no longer exists)',
    s.missing.map((m) => `#${m.id} ${rel(m.path)}`),
  );
  section(
    print,
    'Errors',
    s.errors.map((e) => `${rel(e.path)}: ${e.message}`),
  );
}

function section(print: (line?: string) => void, title: string, items: string[]): void {
  if (!items.length) return;
  print();
  print(title);
  for (const item of items.slice(0, MAX_LISTED)) print(`  ${item}`);
  if (items.length > MAX_LISTED) print(`  … and ${items.length - MAX_LISTED} more`);
}
