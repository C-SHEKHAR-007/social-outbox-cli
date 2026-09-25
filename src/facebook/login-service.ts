import { randomBytes } from 'node:crypto';
import { deleteAppState, setAppState } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import { UserError } from '../utils/errors.js';
import { nowIso } from '../utils/time.js';
import {
  buildLoginUrl,
  canPublish,
  debugToken,
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  listManagedPages,
  missingScopes,
  type AppCredentials,
} from './auth-service.js';
import { startCallbackServer } from './callback-server.js';
import type { GraphClient } from './graph-client.js';
import type { FacebookPage } from './schemas.js';
import type { TokenStore } from './token-store.js';

export interface LoginDeps {
  app: AppCredentials;
  client: GraphClient;
  db: Db;
  store: TokenStore;
  port: number;
  timeoutMs: number;
  /** Open the login URL in a browser; return false if it could not. */
  openUrl: (url: string) => Promise<boolean>;
  /** Pick one Page when several are publishable. */
  choosePage: (pages: FacebookPage[]) => Promise<FacebookPage>;
  print: (line?: string) => void;
  pageId?: string;
  noBrowser?: boolean;
}

export interface LoginResult {
  page: { id: string; name: string };
  storeKind: TokenStore['kind'];
}

/**
 * Official browser login (Facebook Login, authorization-code flow):
 * browser → localhost callback → code → user token → long-lived user token → Page token → token store.
 */
export async function loginWithBrowser(deps: LoginDeps): Promise<LoginResult> {
  const state = randomBytes(24).toString('hex');
  const server = await startCallbackServer({ port: deps.port, state, timeoutMs: deps.timeoutMs });
  let userToken: string;
  try {
    const url = buildLoginUrl(deps.app, server.redirectUri, state);
    const opened = !deps.noBrowser && (await deps.openUrl(url));
    deps.print(
      opened
        ? 'Opened Facebook login in your browser. Approve the permissions there.'
        : 'Open this URL in your browser to log in:',
    );
    if (!opened) deps.print(`  ${url}`);
    deps.print(`Waiting for Facebook to redirect back to ${server.redirectUri} …`);
    const code = await server.waitForCode();
    const shortToken = await exchangeCodeForUserToken(deps.client, deps.app, code, server.redirectUri);
    userToken = await exchangeForLongLivedUserToken(deps.client, deps.app, shortToken);
  } finally {
    await server.close();
  }

  const info = await debugToken(deps.client, deps.app, userToken);
  const missing = missingScopes(info.scopes);
  if (missing.length) {
    throw new UserError(
      `Facebook did not grant: ${missing.join(', ')}. Run \`reel-cli facebook login\` again and allow all requested permissions.`,
    );
  }

  const page = await selectPage(await listManagedPages(deps.client, userToken), deps);
  savePageLogin(deps.db, deps.store, page, userToken);
  return { page: { id: page.id, name: page.name }, storeKind: deps.store.kind };
}

export async function selectPage(
  pages: FacebookPage[],
  deps: Pick<LoginDeps, 'pageId' | 'choosePage'>,
): Promise<FacebookPage> {
  if (!pages.length)
    throw new UserError('This Facebook account does not manage any Pages (or did not share them during login).');
  if (deps.pageId) {
    const page = pages.find((p) => p.id === deps.pageId);
    if (!page)
      throw new UserError(
        `Page ${deps.pageId} is not among the Pages shared at login: ${pages.map((p) => `${p.name} (${p.id})`).join(', ')}`,
      );
    if (!canPublish(page))
      throw new UserError(`You cannot publish to "${page.name}": your role lacks the CREATE_CONTENT task.`);
    return page;
  }
  const usable = pages.filter(canPublish);
  if (!usable.length)
    throw new UserError('None of your Pages allow you to create content (CREATE_CONTENT task missing).');
  return usable.length === 1 ? (usable[0] as FacebookPage) : deps.choosePage(usable);
}

/** Stores the Page token (+ user token for switching Pages later) and remembers the selected Page. */
export function savePageLogin(db: Db, store: TokenStore, page: FacebookPage, userToken?: string): void {
  store.set(`page:${page.id}`, page.access_token);
  if (userToken) store.set('user', userToken);
  setAppState(db, 'page_id', page.id);
  setAppState(db, 'page_name', page.name);
  setAppState(db, 'token_checked_at', nowIso());
}

export function logout(db: Db, store: TokenStore, pageId: string | undefined): void {
  if (pageId) store.delete(`page:${pageId}`);
  store.delete('user');
  for (const key of ['page_id', 'page_name', 'token_checked_at'] as const) deleteAppState(db, key);
}
