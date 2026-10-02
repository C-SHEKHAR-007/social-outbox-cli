import { stringify } from 'csv-stringify/sync';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSV_COLUMNS } from '../../src/csv/columns.js';
import { exportVideos } from '../../src/csv/export-service.js';
import { applyImport, parseCsv, planImport } from '../../src/csv/import-service.js';
import { openDatabase, type DbHandle } from '../../src/db/client.js';
import { platformPosts, videos, type NewVideo } from '../../src/db/schema.js';
import { updateVideo } from '../../src/db/video-repository.js';
import { UserError } from '../../src/utils/errors.js';
import { mediaInfo, videoRow } from '../fixtures/factories.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-09-26T06:00:00.000Z');
const opts = { timezone: TZ, now: NOW };

const video = (over: Partial<NewVideo> = {}) => videoRow({ durationS: 12.34, ...over });

describe('CSV export/import', () => {
  let h: DbHandle;
  beforeEach(() => {
    h = openDatabase(':memory:');
  });
  afterEach(() => {
    h.close();
  });

  const insert = (over: Partial<NewVideo> = {}) => h.db.insert(videos).values(video(over)).returning().get();
  const get = (id: number) => h.db.select().from(videos).where(eq(videos.id, id)).get()!;
  const exportRows = () => parseCsv(exportVideos(h.db, { timezone: TZ }).csv).rows;
  /** Export, apply `edit` to the rows, return the CSV text. */
  const edited = (edit: (rows: Record<string, string>[]) => void) => {
    const rows = exportRows() as Record<string, string>[];
    edit(rows);
    return stringify(rows, { header: true, columns: [...CSV_COLUMNS] });
  };

  it('exports with BOM, all columns and local times', () => {
    insert({
      caption: 'Hi',
      hashtags: ['#a', '#b'],
      action: 'SCHEDULE',
      scheduledAt: '2026-09-27T13:00:00.000Z',
      state: 'READY',
    });
    const { csv, count } = exportVideos(h.db, { timezone: TZ });
    expect(count).toBe(1);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const { header, rows } = parseCsv(csv);
    expect(header).toEqual([...CSV_COLUMNS]);
    expect(rows[0]).toMatchObject({
      id: '1',
      version: '1',
      duration_s: '12.3',
      hashtags: '#a #b',
      scheduled_at: '2026-09-27 18:30',
      action: 'SCHEDULE',
      spec_ok: 'yes',
    });
  });

  it('excludes published reels unless includePublished', () => {
    insert();
    insert({ state: 'PUBLISHED' });
    expect(exportVideos(h.db, { timezone: TZ }).count).toBe(1);
    expect(exportVideos(h.db, { timezone: TZ, includePublished: true }).count).toBe(2);
  });

  it('round-trips Hindi, emoji, commas, quotes and multi-line captions with no changes', () => {
    insert({ caption: 'कहानी अभी बाकी है… 💔\nPart 2, "soon"', hashtags: ['#हिंदी', '#drama'], title: 'शीर्षक' });
    insert({ caption: null, hashtags: null });
    const plan = planImport(h.db, exportVideos(h.db, { timezone: TZ }).csv, opts);
    expect(plan.errors).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it('applies edits, normalizes hashtags, converts dates to UTC and moves state', () => {
    const v = insert({ caption: 'old' });
    const csv = edited((rows) => {
      rows[0]!.caption = 'new caption\r\nline 2';
      rows[0]!.hashtags = 'drama, #Reels #drama';
      rows[0]!.action = 'schedule';
      rows[0]!.scheduled_at = '27/09/2026 18:30';
      rows[0]!.is_ai_generated = 'yes';
    });
    const plan = planImport(h.db, csv, opts);
    expect(plan.errors).toEqual([]);
    expect(plan.changes[0]).toMatchObject({
      fields: ['caption', 'hashtags', 'action', 'scheduled_at', 'is_ai_generated'],
      fromState: 'NEW',
      toState: 'READY',
    });
    applyImport(h.db, plan.changes);
    expect(get(v.id)).toMatchObject({
      caption: 'new caption\nline 2',
      hashtags: ['#drama', '#Reels'],
      action: 'SCHEDULE',
      scheduledAt: '2026-09-27T13:00:00.000Z',
      isAiGenerated: true,
      state: 'READY',
      captionSource: 'manual',
      version: 2,
    });
  });

  it('reports every invalid value with its spreadsheet row number', () => {
    for (let i = 0; i < 4; i++) insert();
    const csv = edited((rows) => {
      rows[0]!.action = 'SEND_NOW';
      rows[1]!.action = 'SCHEDULE';
      rows[1]!.scheduled_at = 'tomorrow evening';
      rows[2]!.action = 'SCHEDULE';
      rows[3]!.hashtags = '#ok #bad-tag';
      rows[3]!.is_ai_generated = 'maybe';
    });
    const plan = planImport(h.db, csv, opts);
    expect(plan.errors.map((e) => [e.row, e.messages])).toEqual([
      [2, ['Invalid action: SEND_NOW (use POST_NOW, SCHEDULE, SKIP or leave empty)']],
      [3, ['Invalid scheduled_at: "tomorrow evening" (use YYYY-MM-DD HH:mm, Asia/Kolkata)']],
      [4, ['scheduled_at is required when action is SCHEDULE']],
      [
        5,
        [
          'Invalid hashtag(s): #bad-tag (letters, numbers and _ only)',
          'Invalid is_ai_generated: "maybe" (use yes or no)',
        ],
      ],
    ]);
  });

  it('rejects unknown and duplicate ids', () => {
    insert();
    const csv = edited((rows) => {
      rows.push({ ...rows[0]!, caption: 'dup' });
      rows.push({ ...rows[0]!, id: '999' });
      rows.push({ ...rows[0]!, id: 'abc' });
    });
    const messages = planImport(h.db, csv, opts).errors.flatMap((e) => e.messages);
    expect(messages).toEqual(['Duplicate id 1 (also on row 2)', 'Unknown id 999', 'Invalid id: "abc"']);
  });

  it('fails fast on missing required columns', () => {
    insert();
    const csv = stringify([{ id: '1', caption: 'x' }], { header: true });
    expect(() => planImport(h.db, csv, opts)).toThrow(
      /missing required column\(s\): version, publish_target, hashtags/,
    );
  });

  it('rejects malformed CSV', () => {
    expect(() => planImport(h.db, 'id,version\n"1,2\n', opts)).toThrow(UserError);
  });

  it('detects stale CSVs via version and allows --force only for unsubmitted rows', () => {
    const v = insert();
    const csv = edited((rows) => (rows[0]!.caption = 'from stale csv'));
    updateVideo(h.db, v.id, { caption: 'changed elsewhere' });

    const plan = planImport(h.db, csv, opts);
    expect(plan.errors[0]?.messages[0]).toMatch(/changed since this CSV was exported/);

    const forced = planImport(h.db, csv, { ...opts, force: true });
    expect(forced.errors).toEqual([]);
    applyImport(h.db, forced.changes);
    expect(get(v.id).caption).toBe('from stale csv');
  });

  it('locks rows already submitted to Facebook but tolerates unchanged ones', () => {
    insert({ state: 'SCHEDULED', caption: 'live', action: 'SCHEDULE', scheduledAt: '2026-09-27T13:00:00.000Z' });
    insert({ state: 'PUBLISHED', caption: 'done' });
    const unchanged = planImport(h.db, exportVideos(h.db, { timezone: TZ, includePublished: true }).csv, opts);
    expect(unchanged.errors).toEqual([]);

    const rows = parseCsv(exportVideos(h.db, { timezone: TZ, includePublished: true }).csv).rows as Record<
      string,
      string
    >[];
    rows[0]!.caption = 'edit';
    rows[1]!.action = 'POST_NOW';
    const plan = planImport(h.db, stringify(rows, { header: true, columns: [...CSV_COLUMNS] }), opts);
    expect(plan.errors.map((e) => e.messages[0])).toEqual([
      'Cannot edit caption: already submitted to Facebook (state SCHEDULED)',
      'Cannot edit action: already submitted to Facebook (state PUBLISHED)',
    ]);
  });

  it('warns about past schedules and spec failures without blocking', () => {
    insert({ specOk: false });
    const csv = edited((rows) => {
      rows[0]!.action = 'SCHEDULE';
      rows[0]!.scheduled_at = '2026-09-26 11:35'; // 06:05Z, 5 min after NOW
    });
    const plan = planImport(h.db, csv, opts);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('less than 10 minutes'),
      expect.stringContaining('fails the Reel spec check'),
    ]);
  });

  it('lets the user pin or unpin the publish target', () => {
    const short = insert({ durationS: 30 });
    const long = insert({ durationS: 300, publishTarget: 'VIDEO' });
    const csv = edited((rows) => {
      rows[0]!.publish_target = 'video';
      rows[1]!.publish_target = 'REEL';
    });
    const plan = planImport(h.db, csv, opts);
    expect(plan.errors.map((e) => e.messages[0])).toEqual([
      'publish_target REEL not possible: 300s is longer than the 90s Reel limit (use VIDEO)',
    ]);
    expect(plan.changes).toHaveLength(1);
    applyImport(h.db, plan.changes);
    expect(get(short.id)).toMatchObject({ publishTarget: 'VIDEO', targetSource: 'manual' });

    // empty cell → back to automatic
    const back = edited((rows) => (rows[0]!.publish_target = ''));
    const plan2 = planImport(h.db, back, opts);
    expect(plan2.changes[0]?.fields).toEqual(['publish_target']);
    applyImport(h.db, plan2.changes);
    expect(get(short.id)).toMatchObject({ publishTarget: 'REEL', targetSource: 'auto' });
    expect(get(long.id).publishTarget).toBe('VIDEO');
  });

  it('rejects an invalid publish_target', () => {
    insert();
    const plan = planImport(
      h.db,
      edited((rows) => (rows[0]!.publish_target = 'STORY')),
      opts,
    );
    expect(plan.errors[0]?.messages).toEqual([
      'Invalid publish_target: STORY (use REEL, VIDEO, or leave empty for automatic)',
    ]);
  });

  it('rolls back the whole import when a row changes mid-import', () => {
    const a = insert();
    const b = insert();
    const csv = edited((rows) => {
      rows[0]!.caption = 'A';
      rows[1]!.caption = 'B';
    });
    const plan = planImport(h.db, csv, opts);
    updateVideo(h.db, b.id, { title: 'concurrent' });
    expect(() => {
      applyImport(h.db, plan.changes);
    }).toThrow(/modified during import/);
    expect(get(a.id).caption).toBeNull();
  });

  it('accepts columns in any order and ignores unknown extra columns', () => {
    insert();
    const rows = exportRows() as Record<string, string>[];
    const shuffled = rows.map((r) => ({
      notes: 'mine',
      ...Object.fromEntries(Object.entries(r).reverse()),
      caption: 'x',
    }));
    const plan = planImport(h.db, stringify(shuffled, { header: true }), opts);
    expect(plan.errors).toEqual([]);
    expect(plan.changes[0]?.fields).toEqual(['caption']);
  });

  describe('Instagram columns', () => {
    const ig = (videoId: number) => h.db.select().from(platformPosts).where(eq(platformPosts.videoId, videoId)).get();

    it('exports ig_action, ig_scheduled_at and ig_state', () => {
      const v = insert();
      h.db
        .insert(platformPosts)
        .values({
          videoId: v.id,
          platform: 'instagram',
          action: 'SCHEDULE',
          scheduledAt: '2026-09-27T13:30:00.000Z',
          state: 'UPLOADED',
        })
        .run();
      expect(exportRows()[0]).toMatchObject({
        ig_action: 'SCHEDULE',
        ig_scheduled_at: '2026-09-27 19:00',
        ig_state: 'UPLOADED',
      });
    });

    it('adds Instagram to a video already scheduled on Facebook without touching its Facebook data', () => {
      const v = insert({
        state: 'SCHEDULED',
        action: 'SCHEDULE',
        scheduledAt: '2026-09-27T13:00:00.000Z',
        caption: 'live',
      });
      const before = get(v.id);
      const csv = edited((rows) => {
        rows[0]!.ig_action = 'schedule';
        rows[0]!.ig_scheduled_at = '2026-09-27 19:00';
      });
      const plan = planImport(h.db, csv, opts);
      expect(plan.errors).toEqual([]);
      expect(plan.changes).toEqual([]);
      expect(plan.igChanges).toHaveLength(1);
      applyImport(h.db, plan.changes, plan.igChanges);
      expect(ig(v.id)).toMatchObject({
        platform: 'instagram',
        action: 'SCHEDULE',
        scheduledAt: '2026-09-27T13:30:00.000Z',
        state: 'READY',
      });
      expect(get(v.id)).toEqual(before);
    });

    it('validates Instagram values and Instagram limits', () => {
      insert();
      insert();
      insert({ durationS: 1200, publishTarget: 'VIDEO', mediaInfo: mediaInfo({ durationS: 1200 }) });
      const csv = edited((rows) => {
        rows[0]!.ig_action = 'SEND';
        rows[1]!.ig_action = 'SCHEDULE';
        rows[2]!.ig_action = 'POST_NOW';
      });
      expect(planImport(h.db, csv, opts).errors.map((e) => e.messages[0])).toEqual([
        'Invalid ig_action: SEND (use POST_NOW, SCHEDULE, SKIP or leave empty)',
        'ig_scheduled_at is required when ig_action is SCHEDULE',
        'Not possible on Instagram: duration 20.0 min > 15 min (Instagram limit)',
      ]);
    });

    it('locks posts already sent to Instagram; clearing the action resets an unsent post', () => {
      const sent = insert();
      const unsent = insert();
      h.db
        .insert(platformPosts)
        .values({ videoId: sent.id, platform: 'instagram', action: 'POST_NOW', state: 'PUBLISHED' })
        .run();
      h.db
        .insert(platformPosts)
        .values({ videoId: unsent.id, platform: 'instagram', action: 'POST_NOW', state: 'READY' })
        .run();
      const csv = edited((rows) => {
        rows[0]!.ig_action = 'SKIP';
        rows[1]!.ig_action = '';
      });
      const plan = planImport(h.db, csv, opts);
      expect(plan.errors.map((e) => e.messages[0])).toEqual([
        'Cannot edit Instagram columns: already sent to Instagram (state PUBLISHED)',
      ]);
      const ok = planImport(
        h.db,
        edited((rows) => (rows[1]!.ig_action = '')),
        opts,
      );
      applyImport(h.db, ok.changes, ok.igChanges);
      expect(ig(unsent.id)).toMatchObject({ action: null, state: 'NEW' });
    });

    it('an old CSV without the Instagram columns leaves Instagram posts alone', () => {
      const v = insert();
      h.db
        .insert(platformPosts)
        .values({ videoId: v.id, platform: 'instagram', action: 'POST_NOW', state: 'READY' })
        .run();
      const rows = exportRows().map((r) => {
        const { ig_action: _a, ig_scheduled_at: _b, ig_state: _c, ...rest } = r as Record<string, string>;
        return { ...rest, caption: 'edited' };
      });
      const plan = planImport(h.db, stringify(rows, { header: true }), opts);
      expect(plan.errors).toEqual([]);
      expect(plan.igChanges).toEqual([]);
      applyImport(h.db, plan.changes, plan.igChanges);
      expect(ig(v.id)).toMatchObject({ action: 'POST_NOW', state: 'READY' });
      expect(get(v.id).caption).toBe('edited');
    });
  });
});
