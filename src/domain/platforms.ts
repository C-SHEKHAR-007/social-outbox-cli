/** Platforms published through `platform_posts` (Facebook keeps its own columns on `videos`). */
export const PLATFORMS = ['instagram'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** What is published on the platform. Instagram: Reels for now (photos, carousels, stories later). */
export const POST_KINDS = ['REELS'] as const;
export type PostKind = (typeof POST_KINDS)[number];

/**
 * Lifecycle of one post on one platform:
 * NEW → READY → (HELD) → UPLOADING → UPLOADED → PUBLISHING → PUBLISHED, or FAILED / SKIPPED.
 * UPLOADED = media is on the platform and processed, waiting for its publish time.
 * PUBLISHING = the publish call was sent; if its outcome is unknown, it is reconciled, never resent blindly.
 */
export const POST_STATES = [
  'NEW',
  'READY',
  'HELD',
  'UPLOADING',
  'UPLOADED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'SKIPPED',
] as const;
export type PostState = (typeof POST_STATES)[number];

/** States in which the post exists on the platform (container created): not editable via CSV. */
export const POST_SUBMITTED_STATES: readonly PostState[] = ['UPLOADING', 'UPLOADED', 'PUBLISHING', 'PUBLISHED'];

export function isPostSubmitted(state: PostState): boolean {
  return POST_SUBMITTED_STATES.includes(state);
}
