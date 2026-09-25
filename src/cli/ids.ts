import { UserError } from '../utils/errors.js';

/** Parses "1,2,5-8" into [1,2,5,6,7,8]. */
export function parseIds(input: string | undefined): number[] | undefined {
  if (input === undefined) return undefined;
  const ids = new Set<number>();
  for (const part of input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (from > to || to - from > 10_000) throw new UserError(`Invalid id range: ${part}`);
      for (let i = from; i <= to; i++) ids.add(i);
    } else if (/^\d+$/.test(part)) ids.add(Number(part));
    else throw new UserError(`Invalid id: ${part} (use e.g. 1,2,5-8)`);
  }
  return [...ids];
}
