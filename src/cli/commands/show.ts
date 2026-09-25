import { asc, eq } from 'drizzle-orm';
import { publishAttempts } from '../../db/schema.js';
import { findVideoById } from '../../db/video-repository.js';
import { buildDescription } from '../../content/description.js';
import { formatLocal } from '../../utils/dates.js';
import { UserError } from '../../utils/errors.js';
import type { AppContext } from '../context.js';

export function runShow(ctx: AppContext, id: number): void {
  ctx.withDb((db) => {
    const v = findVideoById(db, id);
    if (!v) throw new UserError(`No video with id ${id}`);
    const tz = ctx.config.publishing.timezone;
    const when = (iso: string | null) => (iso ? `${formatLocal(iso, tz, 'yyyy-MM-dd HH:mm:ss')} (${tz})` : '');
    const print = ctx.print;
    const field = (label: string, value: string | number | null | undefined) => {
      if (value === null || value === undefined || value === '') return;
      print(`  ${`${label}:`.padEnd(16)}${String(value)}`);
    };

    print(`#${v.id} ${v.filename}`);
    print();
    print('File');
    field('path', v.filePath);
    field('size', `${(v.fileSize / 1024 / 1024).toFixed(1)} MB`);
    field('sha256', v.fileHash);
    field('normalized', v.normalizedPath);
    print();
    print('Media');
    field('duration', v.durationS === null ? null : `${v.durationS.toFixed(2)} s`);
    field('resolution', v.width && v.height ? `${v.width}x${v.height}` : null);
    field('fps', v.fps);
    field('video codec', v.videoCodec);
    field(
      'audio',
      v.audioCodec ? `${v.audioCodec} ${v.audioSampleRate ?? '?'} Hz, ${v.audioChannels ?? '?'} ch` : 'none',
    );
    field('container', v.container);
    field('spec', v.specOk === null ? 'not checked' : v.specOk ? 'OK' : 'FAILS');
    for (const i of v.specIssues ?? []) print(`    ${i.level === 'error' ? '✗' : '⚠'} ${i.message}`);
    print();
    print('Content');
    field('caption source', v.captionSource);
    field('title', v.title);
    field('ai generated', v.isAiGenerated ? 'yes' : 'no');
    const description = buildDescription(v.caption, v.hashtags);
    if (description) {
      print('  description:');
      for (const line of description.split('\n')) print(`    ${line}`);
    } else field('description', '(empty)');
    print();
    print('Publishing');
    field('target', `${v.publishTarget === 'REEL' ? 'Reel' : 'Page video'} (${v.targetSource})`);
    field('state', v.state);
    field('action', v.action ?? '(none)');
    field('scheduled at', when(v.scheduledAt));
    field('fb video id', v.fbVideoId);
    field('fb post id', v.fbPostId);
    field('permalink', v.fbPermalink);
    field('published at', when(v.publishedAt));
    field('retries', v.retryCount || null);
    field('last error', v.lastError ? `${v.lastErrorCode ? `[${v.lastErrorCode}] ` : ''}${v.lastError}` : null);
    field('version', v.version);
    field('created', when(v.createdAt));
    field('updated', when(v.updatedAt));

    const attempts = db
      .select()
      .from(publishAttempts)
      .where(eq(publishAttempts.videoId, id))
      .orderBy(asc(publishAttempts.id))
      .all();
    if (attempts.length) {
      print();
      print('Attempts');
      for (const a of attempts) {
        const err = a.fbErrorCode ? ` fb#${a.fbErrorCode}` : '';
        print(
          `  ${formatLocal(a.startedAt, tz, 'yyyy-MM-dd HH:mm:ss')}  ${a.step.padEnd(9)} ${a.outcome ?? 'running'}${err}${a.message ? `  ${a.message}` : ''}`,
        );
      }
    }
  });
}
