import { formatHashtags } from './hashtags.js';

/** Soft limit: Meta's exact Reel description limit is unverified (docs/plan.md §2.7 Q5). */
export const DESCRIPTION_SOFT_LIMIT = 2200;

/** The text sent to Meta as `description`. */
export function buildDescription(
  caption: string | null | undefined,
  hashtags: readonly string[] | null | undefined,
): string {
  const parts = [caption?.trim() ?? '', formatHashtags(hashtags)].filter(Boolean);
  return parts.join('\n\n');
}
