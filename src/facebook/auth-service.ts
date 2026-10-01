import { z } from 'zod';
import type { GraphClient } from './graph-client.js';
import {
  AccountsResponseSchema,
  DebugTokenSchema,
  REQUIRED_SCOPES,
  TokenResponseSchema,
  type DebugTokenData,
  type FacebookPage,
} from './schemas.js';

export interface AppCredentials {
  appId: string;
  appSecret: string;
  graphApiVersion: string;
}

/** Facebook Login dialog URL (authorization-code flow). */
export function buildLoginUrl(
  app: AppCredentials,
  redirectUri: string,
  state: string,
  extraScopes: readonly string[] = [],
): string {
  const url = new URL(`https://www.facebook.com/${app.graphApiVersion}/dialog/oauth`);
  url.searchParams.set('client_id', app.appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', [...REQUIRED_SCOPES, ...extraScopes].join(','));
  url.searchParams.set('auth_type', 'rerequest'); // re-ask for any permission declined earlier
  return url.toString();
}

export async function exchangeCodeForUserToken(
  client: GraphClient,
  app: AppCredentials,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await client.get(
    'oauth/access_token',
    { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code },
    TokenResponseSchema,
  );
  return res.access_token;
}

/** Short-lived (~1-2h) user token → long-lived (~60 days). */
export async function exchangeForLongLivedUserToken(
  client: GraphClient,
  app: AppCredentials,
  shortToken: string,
): Promise<string> {
  const res = await client.get(
    'oauth/access_token',
    {
      grant_type: 'fb_exchange_token',
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: shortToken,
    },
    TokenResponseSchema,
  );
  return res.access_token;
}

const MAX_PAGES_OF_ACCOUNTS = 10;
const PagingSchema = z.object({
  next: z.string().optional(),
  cursors: z.object({ after: z.string().optional() }).optional(),
});

/** Pages the user manages. Page tokens obtained with a long-lived user token do not expire. */
export async function listManagedPages(client: GraphClient, userToken: string): Promise<FacebookPage[]> {
  const pages: FacebookPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES_OF_ACCOUNTS; i++) {
    const params: Record<string, string> = { fields: 'id,name,access_token,tasks', limit: '100' };
    if (after) params.after = after;
    const res = await client.get(
      'me/accounts',
      params,
      AccountsResponseSchema.extend({ paging: PagingSchema.optional() }),
      { token: userToken },
    );
    pages.push(...res.data);
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return pages;
}

export function canPublish(page: FacebookPage): boolean {
  return page.tasks.includes('CREATE_CONTENT');
}

/** Inspects any token using the app token (app_id|app_secret). */
export async function debugToken(client: GraphClient, app: AppCredentials, token: string): Promise<DebugTokenData> {
  const res = await client.get('debug_token', { input_token: token }, DebugTokenSchema, {
    token: `${app.appId}|${app.appSecret}`,
    noProof: true,
  });
  return res.data;
}

export function missingScopes(granted: readonly string[], extraScopes: readonly string[] = []): string[] {
  return [...REQUIRED_SCOPES, ...extraScopes].filter((s) => !granted.includes(s));
}
