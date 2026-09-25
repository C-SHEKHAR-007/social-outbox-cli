import { describe, expect, it } from 'vitest';
import { parseIds } from '../../src/cli/ids.js';
import { parseBool } from '../../src/csv/columns.js';
import { buildDescription } from '../../src/content/description.js';
import { formatHashtags, parseHashtags } from '../../src/content/hashtags.js';
import { stateAfterActionChange } from '../../src/domain/transitions.js';
import { formatLocal, parseUserDateTime } from '../../src/utils/dates.js';
import { busiestWindow } from '../../src/scheduling/windows.js';
import { UserError } from '../../src/utils/errors.js';

describe('parseHashtags', () => {
  it('normalizes separators, missing #, duplicates', () => {
    expect(parseHashtags('#drama reels, #Story #drama #DRAMA').tags).toEqual(['#drama', '#reels', '#Story']);
  });
  it('accepts Hindi / Devanagari tags', () => {
    expect(parseHashtags('#हिंदी #कहानी #drama_2026').tags).toEqual(['#हिंदी', '#कहानी', '#drama_2026']);
  });
  it('reports invalid tags', () => {
    expect(parseHashtags('#ok #not-ok #wow! ##').invalid).toEqual(['#not-ok', '#wow!', '##']);
  });
  it('handles empty input', () => {
    expect(parseHashtags('')).toEqual({ tags: [], invalid: [] });
    expect(parseHashtags(null)).toEqual({ tags: [], invalid: [] });
    expect(formatHashtags(null)).toBe('');
  });
});

describe('buildDescription', () => {
  it('joins caption and hashtags with a blank line', () => {
    expect(buildDescription(' Hello ', ['#a', '#b'])).toBe('Hello\n\n#a #b');
    expect(buildDescription(null, ['#a'])).toBe('#a');
    expect(buildDescription('Only caption', [])).toBe('Only caption');
  });
});

describe('dates', () => {
  const tz = 'Asia/Kolkata';
  it.each([
    ['2026-09-27 18:30', '2026-09-27T13:00:00.000Z'],
    ['2026-09-27 18:30:00', '2026-09-27T13:00:00.000Z'],
    ['2026-09-27T18:30', '2026-09-27T13:00:00.000Z'],
    ['27/09/2026 18:30', '2026-09-27T13:00:00.000Z'],
    ['27-09-2026 18:30', '2026-09-27T13:00:00.000Z'],
    ['2026-09-27T18:30:00Z', '2026-09-27T18:30:00.000Z'],
    ['2026-09-27T18:30:00+05:30', '2026-09-27T13:00:00.000Z'],
  ])('%s → %s', (input, iso) => {
    expect(parseUserDateTime(input, tz)?.toISOString()).toBe(iso);
  });

  it.each(['tomorrow', '2026-13-01 10:00', '31/02/2026 10:00', '2026-09-27', ''])('rejects %j', (input) => {
    expect(parseUserDateTime(input, tz)).toBeNull();
  });

  it('formats in the configured zone', () => {
    expect(formatLocal('2026-09-27T13:00:00.000Z', tz)).toBe('2026-09-27 18:30');
    expect(formatLocal(null, tz)).toBe('');
  });
});

describe('stateAfterActionChange', () => {
  it.each([
    ['NEW', 'POST_NOW', 'READY'],
    ['NEW', 'SCHEDULE', 'READY'],
    ['NEW', 'SKIP', 'SKIPPED'],
    ['READY', null, 'NEW'],
    ['READY', 'SKIP', 'SKIPPED'],
    ['HELD', 'POST_NOW', 'READY'],
    ['SKIPPED', null, 'NEW'],
    ['SKIPPED', 'SCHEDULE', 'READY'],
    ['FAILED', 'SCHEDULE', 'FAILED'],
    ['FAILED', 'SKIP', 'SKIPPED'],
    ['UPLOADING', 'SKIP', 'UPLOADING'],
    ['SCHEDULED', null, 'SCHEDULED'],
    ['PUBLISHED', 'POST_NOW', 'PUBLISHED'],
  ] as const)('%s + %s → %s', (from, action, to) => {
    expect(stateAfterActionChange(from, action)).toBe(to);
  });
});

describe('parseIds', () => {
  it('parses lists and ranges', () => {
    expect(parseIds('1, 3,5-7,3')).toEqual([1, 3, 5, 6, 7]);
    expect(parseIds(undefined)).toBeUndefined();
  });
  it.each(['a', '5-2', '1;2'])('rejects %s', (s) => {
    expect(() => parseIds(s)).toThrow(UserError);
  });
});

describe('parseBool', () => {
  it.each([
    ['yes', true],
    ['TRUE', true],
    ['1', true],
    ['no', false],
    ['', false],
    ['maybe', null],
  ])('%s → %s', (input, expected) => {
    expect(parseBool(input)).toBe(expected);
  });
});

describe('busiestWindow', () => {
  const h = 60 * 60 * 1000;
  it('finds the densest rolling 24h window', () => {
    expect(busiestWindow([0, 1 * h, 2 * h, 30 * h, 31 * h]).count).toBe(3);
    expect(busiestWindow([0, 24 * h]).count).toBe(1); // exactly 24h apart = different windows
    expect(busiestWindow([]).count).toBe(0);
  });
});
