/** Lifecycle state, owned by the system. See docs/plan.md §7. */
export const VIDEO_STATES = [
  'NEW',
  'READY',
  'HELD',
  'UPLOADING',
  'FINISHING',
  'PROCESSING',
  'SCHEDULED',
  'PUBLISHED',
  /** Uploaded as a private draft (`publish --draft`); `retry` makes it publishable again. */
  'DRAFT',
  'FAILED',
  'SKIPPED',
] as const;
export type VideoState = (typeof VIDEO_STATES)[number];

/** Publishing intent, owned by the user (via CSV). */
export const ACTIONS = ['POST_NOW', 'SCHEDULE', 'SKIP'] as const;
export type Action = (typeof ACTIONS)[number];

/** Where a video is published: Reels API (short) or regular Page video (long). */
export const PUBLISH_TARGETS = ['REEL', 'VIDEO'] as const;
export type PublishTarget = (typeof PUBLISH_TARGETS)[number];

export const TARGET_SOURCES = ['auto', 'manual'] as const;
export type TargetSource = (typeof TARGET_SOURCES)[number];

export const CAPTION_SOURCES = ['ai', 'manual'] as const;
export type CaptionSource = (typeof CAPTION_SOURCES)[number];

export const ATTEMPT_STEPS = ['START', 'TRANSFER', 'FINISH', 'VERIFY', 'RECONCILE'] as const;
export type AttemptStep = (typeof ATTEMPT_STEPS)[number];

export const ATTEMPT_OUTCOMES = ['ok', 'transient', 'permanent', 'fatal'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** States in which a row has been handed to Meta and must not be edited or re-published. */
export const SUBMITTED_STATES: readonly VideoState[] = [
  'UPLOADING',
  'FINISHING',
  'PROCESSING',
  'SCHEDULED',
  'PUBLISHED',
  'DRAFT',
];
