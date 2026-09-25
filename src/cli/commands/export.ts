import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { exportVideos } from '../../csv/export-service.js';
import type { AppContext } from '../context.js';

export function runExport(
  ctx: AppContext,
  opts: { out?: string; all?: boolean } = {},
): { path: string; count: number } {
  const path = opts.out ? resolve(ctx.cwd, opts.out) : join(ctx.paths.exports, 'reels.csv');
  return ctx.withDb((db) => {
    const { csv, count } = exportVideos(db, {
      timezone: ctx.config.publishing.timezone,
      includePublished: opts.all ?? false,
    });
    mkdirSync(dirname(path), { recursive: true });
    // Keep one backup so an accidental re-export does not destroy unsaved edits.
    if (existsSync(path)) copyFileSync(path, `${path}.bak`);
    writeFileSync(path, csv, 'utf8');

    const rel = relative(ctx.cwd, path) || path;
    ctx.print(
      `Exported ${count} video(s) to ${rel}${opts.all ? '' : ' (published reels excluded; use --all to include)'}`,
    );
    if (existsSync(`${path}.bak`)) ctx.print(`Previous file kept as ${rel}.bak`);
    ctx.print();
    ctx.print(`Editable columns: publish_target, caption, hashtags, title, action, scheduled_at, is_ai_generated`);
    ctx.print(`Dates are in ${ctx.config.publishing.timezone}, format YYYY-MM-DD HH:mm.`);
    ctx.print(`When done: reel-cli import ${rel} --dry-run`);
    ctx.logger.info({ op: 'export', path, count }, 'csv exported');
    return { path, count };
  });
}
