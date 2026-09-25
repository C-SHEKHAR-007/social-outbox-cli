import { debugToken, missingScopes, type AppCredentials } from './auth-service.js';
import type { PageCredentials } from './credentials.js';
import type { GraphClient } from './graph-client.js';

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  type: string | undefined;
  scopes: string[];
  expires: 'never' | Date | undefined;
}

/** Checks the Page token is valid, is a PAGE token for the selected Page, and has the required permissions. */
export async function verifyPageToken(
  client: GraphClient,
  app: AppCredentials,
  creds: PageCredentials,
): Promise<VerifyReport> {
  const data = await debugToken(client, app, creds.token);
  const problems: string[] = [];
  if (!data.is_valid) problems.push(`token is not valid${data.error?.message ? `: ${data.error.message}` : ''}`);
  if (data.type && data.type !== 'PAGE') problems.push(`token type is ${data.type}, expected PAGE`);
  if (data.profile_id && data.profile_id !== creds.pageId)
    problems.push(`token belongs to Page ${data.profile_id}, not ${creds.pageId}`);
  if (data.app_id && data.app_id !== app.appId)
    problems.push(`token was issued for app ${data.app_id}, not FACEBOOK_APP_ID`);
  const missing = missingScopes(data.scopes);
  if (missing.length) problems.push(`missing permissions: ${missing.join(', ')}`);
  const expires =
    data.expires_at === undefined ? undefined : data.expires_at === 0 ? 'never' : new Date(data.expires_at * 1000);
  return { ok: problems.length === 0, problems, type: data.type, scopes: data.scopes, expires };
}
