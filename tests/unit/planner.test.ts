import { describe, expect, it } from 'vitest';
import { planSchedule, type PlanInput } from '../../src/scheduling/planner.js';
import { parseSlots } from '../../src/scheduling/slots.js';

const TZ = 'Asia/Kolkata';
// 2026-09-26 12:00 IST
const NOW = new Date('2026-09-26T06:30:00.000Z');
const ist = (d: Date) => d.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  candidates: [],
  occupied: [],
  slots: { REEL: ['09:00', '14:00', '20:00'], VIDEO: ['12:00', '18:00'] },
  startDate: '2026-09-27',
  timezone: TZ,
  now: NOW,
  quotaPer24h: 25,
  ...over,
});
const reels = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, target: 'REEL' as const }));
const vids = (n: number, from = 100) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, target: 'VIDEO' as const }));

describe('parseSlots', () => {
  it.each([
    ['09:00,14:00,20:00', ['09:00', '14:00', '20:00']],
    ['20:00, 9:30 ,09:30', ['09:30', '20:00']],
    ['none', []],
    ['NONE', []],
    ['', null],
    ['9am', null],
    ['24:00', null],
    ['12:60', null],
  ])('%j → %j', (s, expected) => {
    expect(parseSlots(s)).toEqual(expected);
  });
});

describe('planSchedule', () => {
  it('fills slots day by day in candidate order, in local time', () => {
    const r = planSchedule(input({ candidates: [...reels(4), ...vids(3)] }));
    expect(r.assignments.map((a) => [a.id, ist(a.at)])).toEqual([
      [1, '2026-09-27 09:00'],
      [2, '2026-09-27 14:00'],
      [3, '2026-09-27 20:00'],
      [4, '2026-09-28 09:00'],
      [100, '2026-09-27 12:00'],
      [101, '2026-09-27 18:00'],
      [102, '2026-09-28 12:00'],
    ]);
    expect(r.assignments[0]?.at.toISOString()).toBe('2026-09-27T03:30:00.000Z');
    expect(r.unassigned).toEqual([]);
  });

  it('skips slots in the past or less than 10 minutes away', () => {
    const r = planSchedule(
      input({
        startDate: '2026-09-26',
        candidates: reels(2),
        now: new Date('2026-09-26T08:25:00.000Z') /* 13:55 IST */,
      }),
    );
    expect(r.assignments.map((a) => ist(a.at))).toEqual(['2026-09-26 20:00', '2026-09-27 09:00']);
  });

  it('keeps slots that are already taken by the same target only', () => {
    const occupied = [
      { target: 'REEL' as const, at: Date.parse('2026-09-27T03:30:00.000Z') }, // 09:00 IST reel taken
      { target: 'VIDEO' as const, at: Date.parse('2026-09-27T08:30:00.000Z') }, // 14:00 IST (video) doesn't block reels
    ];
    const r = planSchedule(input({ candidates: reels(2), occupied }));
    expect(r.assignments.map((a) => ist(a.at))).toEqual(['2026-09-27 14:00', '2026-09-27 20:00']);
  });

  it('never puts more than the quota of Reels in a rolling 24h window', () => {
    const slots = { REEL: ['08:00', '10:00', '12:00', '14:00'], VIDEO: [] };
    const r = planSchedule(input({ candidates: reels(6), slots, quotaPer24h: 3 }));
    const times = r.assignments.map((a) => a.at.getTime());
    for (const t of times) expect(times.filter((u) => u >= t && u < t + 86_400_000).length).toBeLessThanOrEqual(3);
    expect(r.assignments.map((a) => ist(a.at))).toEqual([
      '2026-09-27 08:00',
      '2026-09-27 10:00',
      '2026-09-27 12:00',
      '2026-09-28 08:00',
      '2026-09-28 10:00',
      '2026-09-28 12:00',
    ]);
  });

  it('counts existing Reels toward the quota; Page videos are unlimited', () => {
    const occupied = [0, 1].map((i) => ({
      target: 'REEL' as const,
      at: Date.parse('2026-09-26T20:00:00.000Z') + i * 60_000,
    }));
    const r = planSchedule(
      input({
        candidates: [...reels(2), ...vids(2)],
        occupied,
        quotaPer24h: 3,
        slots: { REEL: ['09:00', '14:00'], VIDEO: ['09:00', '09:30'] },
      }),
    );
    // existing 2 reels at ~01:30 IST on the 27th → only one more reel fits before 01:30 IST on the 28th
    expect(r.assignments.filter((a) => a.target === 'REEL').map((a) => ist(a.at))).toEqual([
      '2026-09-27 09:00',
      '2026-09-28 09:00',
    ]);
    expect(r.assignments.filter((a) => a.target === 'VIDEO').map((a) => ist(a.at))).toEqual([
      '2026-09-27 09:00',
      '2026-09-27 09:30',
    ]);
  });

  it('reports candidates it could not place', () => {
    const noSlots = planSchedule(input({ candidates: vids(1), slots: { REEL: ['09:00'], VIDEO: [] } }));
    expect(noSlots.unassigned).toEqual([{ id: 100, target: 'VIDEO', reason: 'no posting slots configured' }]);
    const horizon = planSchedule(input({ candidates: reels(5), maxDays: 1 }));
    expect(horizon.assignments).toHaveLength(3);
    expect(horizon.unassigned.map((u) => u.id)).toEqual([4, 5]);
  });

  it('rejects an invalid start date', () => {
    expect(() => planSchedule(input({ startDate: '2026-02-30', candidates: reels(1) }))).toThrow(/invalid start date/);
  });
});
