import { resolvePageCredentials } from '../../facebook/credentials.js';
import { validateVideos, type ValidationReport } from '../../validation/validate-service.js';
import type { AppContext } from '../context.js';

/** Returns exit code: 1 if any video or global check has errors. */
export async function runValidate(
  ctx: AppContext,
  opts: { ids?: number[] } = {},
  now = new Date(),
): Promise<{ report: ValidationReport; code: number }> {
  return ctx.withDbAsync(async (db) => {
    const facebookConnected = resolvePageCredentials(ctx.config, db, ctx.tokenStore()) !== undefined;
    const report = await validateVideos(db, { config: ctx.config, now, ids: opts.ids, facebookConnected });
    render(report, ctx.print);
    ctx.logger.info({ op: 'validate', valid: report.valid, invalid: report.invalid }, 'validation run');
    const code = report.invalid || report.global.errors.length ? 1 : 0;
    return { report, code };
  });
}

function render(r: ValidationReport, print: (line?: string) => void): void {
  if (!r.videos.length) {
    print('Nothing to validate: no videos are READY. Set an action in the CSV and import it, or pass --ids.');
  }
  for (const v of r.videos) {
    print(`${v.errors.length ? '✗' : '✓'} #${v.id} ${v.filename}`);
    for (const e of v.errors) print(`    ✗ ${e}`);
    for (const w of v.warnings) print(`    ⚠ ${w}`);
  }
  if (r.global.errors.length || r.global.warnings.length) {
    print();
    for (const e of r.global.errors) print(`✗ ${e}`);
    for (const w of r.global.warnings) print(`⚠ ${w}`);
  }
  print();
  print(`${r.valid} valid, ${r.invalid} invalid`);
}
