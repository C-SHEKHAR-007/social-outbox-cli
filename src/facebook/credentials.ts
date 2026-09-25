import type { AppConfig } from '../config/env.js';
import { getAppState } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import type { TokenStore } from './token-store.js';

export interface PageCredentials {
  pageId: string;
  pageName: string | undefined;
  token: string;
  source: 'env' | TokenStore['kind'];
}

/**
 * The Page token to publish with: `.env` (FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN) overrides
 * the Page selected by `reel-cli facebook login`, whose token lives in the token store.
 */
export function resolvePageCredentials(config: AppConfig, db: Db, store: TokenStore): PageCredentials | undefined {
  const { pageId: envPageId, pageAccessToken: envToken } = config.facebook;
  if (envPageId && envToken) return { pageId: envPageId, pageName: undefined, token: envToken, source: 'env' };
  const pageId = getAppState(db, 'page_id');
  if (!pageId) return undefined;
  const token = store.get(`page:${pageId}`);
  if (!token) return undefined;
  return { pageId, pageName: getAppState(db, 'page_name'), token, source: store.kind };
}
