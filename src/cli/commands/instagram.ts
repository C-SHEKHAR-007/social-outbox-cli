import { getAppState } from '../../db/app-state.js';
import { countPostsByState, postsSentSince } from '../../db/platform-post-repository.js';
import { POST_STATES } from '../../domain/platforms.js';
import { resolvePageCredentials } from '../../facebook/credentials.js';
import { GraphClient } from '../../facebook/graph-client.js';
import { loginWithBrowser } from '../../facebook/login-service.js';
import {
  isInstagramPaused,
  linkInstagramAccount,
  missingInstagramScopes,
  storedInstagramAccount,
  type InstagramAccount,
} from '../../instagram/connect-service.js';
import { igPublishingLimit, INSTAGRAM_SCOPES } from '../../instagram/ig-api.js';
import { UserError } from '../../utils/errors.js';
import { openUrl as defaultOpenUrl } from '../../utils/open-url.js';
import type { AppContext } from '../context.js';
import { requireApp, type FacebookCommandDeps } from './facebook.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Connects the Instagram professional account linked to the Facebook Page. If the stored Page token
 * lacks the Instagram permissions (or --login is given), runs the browser login again asking for the
 * Facebook permissions plus instagram_basic and instagram_content_publish.
 */
export async function runInstagramConnect(
  ctx: AppContext,
  opts: { login?: boolean; port?: string; browser?: boolean } = {},
  deps: FacebookCommandDeps = {},
): Promise<InstagramAccount> {
  const app = requireApp(ctx);
  const client = deps.client ?? new GraphClient({ version: app.graphApiVersion, appSecret: app.appSecret });
  const store = ctx.tokenStore();
  const port = opts.port === undefined ? ctx.config.facebook.oauthPort : Number(opts.port);

  return ctx.withDbAsync(async (db) => {
    let page = resolvePageCredentials(ctx.config, db, store);
    if (!page) throw new UserError('Connect the Facebook Page first: reel-cli facebook login');
    const missing = opts.login ? [...INSTAGRAM_SCOPES] : await missingInstagramScopes(client, app, page.token);

    if (missing.length) {
      ctx.print(
        `The Page token is missing Instagram permissions (${missing.join(', ')}); logging in again to add them.`,
      );
      ctx.print(
        'If the browser shows "Invalid Scopes", add the Instagram permissions to your Meta app first (see README).',
      );
      await loginWithBrowser({
        app,
        client,
        db,
        store,
        port,
        timeoutMs: deps.timeoutMs ?? LOGIN_TIMEOUT_MS,
        openUrl: deps.openUrl ?? defaultOpenUrl,
        choosePage: deps.choosePage ?? (() => Promise.reject(new UserError('Use --page or connect a single Page'))),
        print: ctx.print,
        pageId: page.pageId,
        noBrowser: opts.browser === false,
        extraScopes: INSTAGRAM_SCOPES,
        retryCommand: 'reel-cli instagram connect --login',
      });
      page = resolvePageCredentials(ctx.config, db, store);
      if (!page) throw new UserError('Login did not store a Page token.');
    }

    const acct = await linkInstagramAccount(db, client, page);
    ctx.print();
    ctx.print(
      `✓ Instagram connected: ${acct.username ? `@${acct.username} ` : ''}(${acct.igUserId}), via Page "${page.pageName ?? page.pageId}".`,
    );
    ctx.logger.info({ op: 'instagram-connect', igUserId: acct.igUserId }, 'instagram connected');
    return acct;
  });
}

export async function runInstagramStatus(
  ctx: AppContext,
  deps: FacebookCommandDeps = {},
  now = new Date(),
): Promise<void> {
  const store = ctx.tokenStore();
  await ctx.withDbAsync(async (db) => {
    const acct = storedInstagramAccount(db);
    const p = ctx.print;
    p('Instagram');
    p('=========');
    if (!acct) {
      p('Not connected. Run: reel-cli instagram connect');
      return;
    }
    p(`Account:      ${acct.username ? `@${acct.username} ` : ''}(${acct.igUserId})`);
    if (isInstagramPaused(db))
      p(`⚠ PAUSED: ${getAppState(db, 'instagram_paused_reason') ?? 'unknown reason'} (reel-cli instagram resume)`);
    const byState = countPostsByState(db, 'instagram');
    p();
    for (const s of POST_STATES)
      if (byState[s]) p(`${`${s[0]}${s.slice(1).toLowerCase()}:`.padEnd(14)}${String(byState[s]).padStart(5)}`);
    if (!Object.keys(byState).length) p('No Instagram posts planned yet (set ig_action in the CSV).');
    p();
    p(
      `Posts (24h):  ${postsSentSince(db, 'instagram', now)}/${ctx.config.instagram.dailyLimit} (INSTAGRAM_DAILY_LIMIT)`,
    );

    const page = resolvePageCredentials(ctx.config, db, store);
    const { appId, appSecret, graphApiVersion } = ctx.config.facebook;
    if (page && appId && appSecret) {
      try {
        const client = deps.client ?? new GraphClient({ version: graphApiVersion, appSecret });
        const limit = await igPublishingLimit(client, acct.igUserId, page.token);
        if (limit.used !== undefined) p(`Instagram's own quota: ${limit.used}/${limit.total ?? 100} in the last 24h`);
      } catch (err) {
        p(`(could not read Instagram's quota: ${(err as Error).message})`);
      }
    }
  });
}
