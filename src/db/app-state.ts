import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { appState } from './schema.js';
import { nowIso } from '../utils/time.js';

export type AppStateKey =
  | 'publishing_paused'
  | 'paused_reason'
  | 'page_id'
  | 'page_name'
  | 'token_checked_at'
  | 'instagram_user_id'
  | 'instagram_username'
  | 'instagram_paused'
  | 'instagram_paused_reason';

export function getAppState(db: Db, key: AppStateKey): string | undefined {
  return db.select().from(appState).where(eq(appState.key, key)).get()?.value;
}

export function setAppState(db: Db, key: AppStateKey, value: string): void {
  db.insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: nowIso() } })
    .run();
}

export function deleteAppState(db: Db, key: AppStateKey): void {
  db.delete(appState).where(eq(appState.key, key)).run();
}

export function isPublishingPaused(db: Db): boolean {
  return getAppState(db, 'publishing_paused') === 'true';
}
