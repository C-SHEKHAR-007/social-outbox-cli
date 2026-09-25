import { createInterface } from 'node:readline/promises';
import { DateTime } from 'luxon';
import { getAppState, setAppState } from '../../db/app-state.js';
import { canPublish, listManagedPages, type AppCredentials } from '../../facebook/auth-service.js';
import { resolvePageCredentials } from '../../facebook/credentials.js';
import { GraphClient } from '../../facebook/graph-client.js';
import { loginWithBrowser, logout, savePageLogin, type LoginResult } from '../../facebook/login-service.js';
import type { FacebookPage } from '../../facebook/schemas.js';
import { verifyPageToken, type VerifyReport } from '../../facebook/verify-service.js';
import { UserError } from '../../utils/errors.js';
import { openUrl as defaultOpenUrl } from '../../utils/open-url.js';
import { nowIso } from '../../utils/time.js';
import type { AppContext } from '../context.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Injectable for tests; defaults talk to the real browser, terminal and Graph API. */
export interface FacebookCommandDeps {
  client?: GraphClient;
  openUrl?: (url: string) => Promise<boolean>;
  choosePage?: (pages: FacebookPage[]) => Promise<FacebookPage>;
  timeoutMs?: number;
}

export function requireApp(ctx: AppContext): AppCredentials {
  const { appId, appSecret, graphApiVersion } = ctx.config.facebook;
  if (!appId || !appSecret) {
    throw new UserError(
      'FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set in .env first.\n' +
        '  Create an app at https://developers.facebook.com/apps, add the "Facebook Login" product and keep the app\n' +
        '  in Development mode (localhost redirects are then allowed automatically). See docs/facebook-api.md.',
    );
  }
  return { appId, appSecret, graphApiVersion };
}

const clientFor = (app: AppCredentials, deps: FacebookCommandDeps) =>
  deps.client ?? new GraphClient({ version: app.graphApiVersion, appSecret: app.appSecret });

export async function runFacebookLogin(
  ctx: AppContext,
  opts: { page?: string; port?: string; browser?: boolean } = {},
  deps: FacebookCommandDeps = {},
): Promise<LoginResult> {
  const app = requireApp(ctx);
  const port = opts.port === undefined ? ctx.config.facebook.oauthPort : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError(`Invalid --port: ${String(opts.port)}`);
  const store = ctx.tokenStore();

  const result = await ctx.withDbAsync((db) =>
    loginWithBrowser({
      app,
      client: clientFor(app, deps),
      db,
      store,
      port,
      timeoutMs: deps.timeoutMs ?? LOGIN_TIMEOUT_MS,
      openUrl: deps.openUrl ?? defaultOpenUrl,
      choosePage: deps.choosePage ?? promptForPage,
      print: ctx.print,
      pageId: opts.page,
      noBrowser: opts.browser === false,
    }),
  );
  ctx.print();
  ctx.print(`✓ Connected to Page "${result.page.name}" (${result.page.id}).`);
  ctx.print(
    `  Page token saved to the ${result.storeKind === 'keychain' ? 'OS keychain' : `file data/credentials.json (no keychain available)`}.`,
  );
  if (ctx.config.facebook.pageId && ctx.config.facebook.pageAccessToken) {
    ctx.print(
      '  Note: FACEBOOK_PAGE_ID + FACEBOOK_PAGE_ACCESS_TOKEN in .env override this login; remove them to use the keychain token.',
    );
  }
  ctx.logger.info({ op: 'facebook-login', pageId: result.page.id, store: result.storeKind }, 'facebook login');
  return result;
}

export async function runFacebookPages(
  ctx: AppContext,
  opts: { select?: string } = {},
  deps: FacebookCommandDeps = {},
): Promise<FacebookPage[]> {
  const app = requireApp(ctx);
  const store = ctx.tokenStore();
  const userToken = store.get('user');
  if (!userToken) throw new UserError('Not logged in. Run: reel-cli facebook login');
  const pages = await listManagedPages(clientFor(app, deps), userToken);

  return ctx.withDb((db) => {
    if (opts.select) {
      const page = pages.find((p) => p.id === opts.select);
      if (!page)
        throw new UserError(`Page ${opts.select} not found. Run \`reel-cli facebook pages\` to list your Pages.`);
      if (!canPublish(page)) throw new UserError(`You cannot publish to "${page.name}" (CREATE_CONTENT task missing).`);
      savePageLogin(db, store, page);
      ctx.print(`✓ Selected Page "${page.name}" (${page.id}).`);
      return pages;
    }
    const current = getAppState(db, 'page_id');
    ctx.print('Pages you manage:');
    for (const p of pages) {
      const mark = p.id === current ? '●' : ' ';
      const note = canPublish(p) ? '' : '  (cannot publish: CREATE_CONTENT missing)';
      ctx.print(`  ${mark} ${p.id}  ${p.name}${note}`);
    }
    ctx.print();
    ctx.print('Switch with: reel-cli facebook pages --select <id>');
    return pages;
  });
}

export async function runFacebookVerify(
  ctx: AppContext,
  deps: FacebookCommandDeps = {},
): Promise<{ report: VerifyReport; code: number }> {
  const app = requireApp(ctx);
  const store = ctx.tokenStore();
  return ctx.withDbAsync(async (db) => {
    const creds = resolvePageCredentials(ctx.config, db, store);
    if (!creds) throw new UserError('No Page connected. Run: reel-cli facebook login');
    const report = await verifyPageToken(clientFor(app, deps), app, creds);
    const p = ctx.print;
    p(`Page:        ${creds.pageName ? `${creds.pageName} ` : ''}(${creds.pageId})`);
    p(`Token from:  ${creds.source === 'env' ? '.env (FACEBOOK_PAGE_ACCESS_TOKEN)' : creds.source}`);
    p(`Type:        ${report.type ?? 'unknown'}`);
    p(
      `Expires:     ${report.expires === 'never' ? 'never' : report.expires ? DateTime.fromJSDate(report.expires).toFormat('yyyy-MM-dd HH:mm') : 'unknown'}`,
    );
    p(`Permissions: ${report.scopes.join(', ') || '(none)'}`);
    p();
    if (report.ok) {
      setAppState(db, 'token_checked_at', nowIso());
      p('✓ Token is valid for publishing.');
    } else {
      for (const problem of report.problems) p(`✗ ${problem}`);
      p('Fix: run `reel-cli facebook login` again.');
    }
    ctx.logger.info({ op: 'facebook-verify', pageId: creds.pageId, ok: report.ok }, 'facebook token verified');
    return { report, code: report.ok ? 0 : 1 };
  });
}

export function runFacebookLogout(ctx: AppContext): void {
  const store = ctx.tokenStore();
  ctx.withDb((db) => {
    const pageId = getAppState(db, 'page_id');
    logout(db, store, pageId);
    ctx.print(
      pageId ? `✓ Logged out; tokens for Page ${pageId} removed from the ${store.kind}.` : 'Nothing to log out from.',
    );
  });
  ctx.logger.info({ op: 'facebook-logout' }, 'facebook logout');
}

async function promptForPage(pages: FacebookPage[]): Promise<FacebookPage> {
  if (!process.stdin.isTTY) {
    throw new UserError(
      `Several Pages are available; choose one with --page <id>: ${pages.map((p) => `${p.name} (${p.id})`).join(', ')}`,
    );
  }
  console.log('Which Page should reel-cli publish to?');
  pages.forEach((p, i) => {
    console.log(`  ${i + 1}) ${p.name} (${p.id})`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = Number((await rl.question(`Enter 1-${pages.length}: `)).trim());
      const page = pages[answer - 1];
      if (Number.isInteger(answer) && page) return page;
    }
  } finally {
    rl.close();
  }
}
