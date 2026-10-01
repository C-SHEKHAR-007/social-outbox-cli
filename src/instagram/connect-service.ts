import { getAppState, setAppState } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import { debugToken, type AppCredentials } from '../facebook/auth-service.js';
import type { PageCredentials } from '../facebook/credentials.js';
import type { GraphClient } from '../facebook/graph-client.js';
import { UserError } from '../utils/errors.js';
import { igLinkedAccount, INSTAGRAM_SCOPES } from './ig-api.js';

export interface InstagramAccount {
  igUserId: string;
  username: string | undefined;
}

/** Instagram permissions the stored Page token is missing (empty = ready). */
export async function missingInstagramScopes(
  client: GraphClient,
  app: AppCredentials,
  pageToken: string,
): Promise<string[]> {
  const info = await debugToken(client, app, pageToken);
  return INSTAGRAM_SCOPES.filter((s) => !info.scopes.includes(s));
}

/** Looks up the Instagram professional account linked to the Page and remembers it. */
export async function linkInstagramAccount(
  db: Db,
  client: GraphClient,
  page: PageCredentials,
): Promise<InstagramAccount> {
  const acct = await igLinkedAccount(client, page.pageId, page.token);
  if (!acct) {
    throw new UserError(
      `No Instagram professional account is linked to ${page.pageName ? `"${page.pageName}"` : `Page ${page.pageId}`}.\n` +
        '  In the Instagram app: switch to a Professional (Business/Creator) account, then link it to the Page\n' +
        '  (Instagram → Settings → Account Center, or Facebook Page settings → Linked accounts). Then run this again.',
    );
  }
  setAppState(db, 'instagram_user_id', acct.id);
  if (acct.username) setAppState(db, 'instagram_username', acct.username);
  return { igUserId: acct.id, username: acct.username };
}

export function storedInstagramAccount(db: Db): InstagramAccount | undefined {
  const igUserId = getAppState(db, 'instagram_user_id');
  return igUserId ? { igUserId, username: getAppState(db, 'instagram_username') } : undefined;
}

export function isInstagramPaused(db: Db): boolean {
  return getAppState(db, 'instagram_paused') === 'true';
}
