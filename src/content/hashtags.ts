export const MAX_HASHTAGS = 30;

const VALID_TAG = /^#[\p{L}\p{M}\p{N}_]+$/u;

export interface HashtagParseResult {
  tags: string[];
  invalid: string[];
}

/** Accepts "#a #b", "a, b", "#a,#b"; adds missing '#', dedupes case-insensitively, keeps order. */
export function parseHashtags(input: string | null | undefined): HashtagParseResult {
  const tags: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of (input ?? '').split(/[\s,]+/)) {
    if (!raw) continue;
    const tag = raw.startsWith('#') ? raw : `#${raw}`;
    if (!VALID_TAG.test(tag)) {
      invalid.push(raw);
      continue;
    }
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return { tags, invalid };
}

export function formatHashtags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(' ');
}
