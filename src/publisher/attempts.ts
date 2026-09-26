import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { publishAttempts } from '../db/schema.js';
import type { AttemptOutcome, AttemptStep } from '../domain/states.js';
import { FacebookApiError } from '../facebook/graph-client.js';
import { nowIso } from '../utils/time.js';

/** Records the start of one publish step; returns an id for finishAttempt(). */
export function startAttempt(db: Db, videoId: number, step: AttemptStep): number {
  return db.insert(publishAttempts).values({ videoId, step }).returning({ id: publishAttempts.id }).get().id;
}

export function finishAttempt(
  db: Db,
  attemptId: number,
  outcome: AttemptOutcome,
  detail?: { error?: unknown; message?: string },
): void {
  const err = detail?.error;
  const fb = err instanceof FacebookApiError ? err.details : undefined;
  db.update(publishAttempts)
    .set({
      endedAt: nowIso(),
      outcome,
      httpStatus: fb?.httpStatus ?? null,
      fbErrorCode: fb?.code ?? null,
      fbErrorSubcode: fb?.subcode ?? null,
      fbTraceId: fb?.fbtraceId ?? null,
      message: detail?.message ?? (err instanceof Error ? err.message : err === undefined ? null : JSON.stringify(err)),
    })
    .where(eq(publishAttempts.id, attemptId))
    .run();
}
