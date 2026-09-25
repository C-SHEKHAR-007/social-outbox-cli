import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runFacebookLogin,
  runFacebookLogout,
  runFacebookPages,
  runFacebookVerify,
} from '../../src/cli/commands/facebook.js';
import { runInit } from '../../src/cli/commands/init.js';
import { createContext, type AppContext } from '../../src/cli/context.js';
import { getAppState } from '../../src/db/app-state.js';
import { startCallbackServer } from '../../src/facebook/callback-server.js';
import { resolvePageCredentials } from '../../src/facebook/credentials.js';
import { GraphClient } from '../../src/facebook/graph-client.js';
import { MemoryTokenStore } from '../../src/facebook/token-store.js';
import { UserError } from '../../src/utils/errors.js';
import { ALL_SCOPES, APP, fakeGraph, loginRoutes, PAGE_A, PAGE_B, PAGE_RO } from '../fixtures/fake-graph.js';
import { collectOutput, makeTempDir } from '../helpers.js';

/** Plays the browser: follows the login URL's redirect_uri back to our callback server. */
function fakeBrowser(respond: (redirect: URL, state: string) => URL) {
  const opened: string[] = [];
  const openUrl = async (loginUrl: string) => {
    opened.push(loginUrl);
    const u = new URL(loginUrl);
    const target = respond(new URL(u.searchParams.get('redirect_uri') ?? ''), u.searchParams.get('state') ?? '');
    setTimeout(() => void fetch(target).catch(() => undefined), 10);
    return true;
  };
  return { openUrl, opened };
}
const approve = fakeBrowser((redirect, state) => {
  redirect.searchParams.set('code', 'AUTH-CODE');
  redirect.searchParams.set('state', state);
  return redirect;
});

describe('callback server', () => {
  it('ignores wrong state, then resolves with the code', async () => {
    const server = await startCallbackServer({ port: 0, state: 'good', timeoutMs: 5000 });
    try {
      const bad = await fetch(`${server.redirectUri}?code=X&state=evil`);
      expect(bad.status).toBe(400);
      expect((await fetch(`http://localhost:${server.port}/other`)).status).toBe(404);
      const ok = await fetch(`${server.redirectUri}?code=THE-CODE&state=good`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain('Logged in to reel-cli');
      expect(await server.waitForCode()).toBe('THE-CODE');
    } finally {
      await server.close();
    }
  });

  it('rejects when the user cancels, and on timeout', async () => {
    const server = await startCallbackServer({ port: 0, state: 's', timeoutMs: 5000 });
    await fetch(
      `${server.redirectUri}?error=access_denied&error_reason=user_denied&error_description=Permissions+error&state=s`,
    );
    await expect(server.waitForCode()).rejects.toThrow('Facebook login was not completed: Permissions error');
    await server.close();

    const slow = await startCallbackServer({ port: 0, state: 's', timeoutMs: 50 });
    await expect(slow.waitForCode()).rejects.toThrow(/Timed out/);
    await slow.close();
  });

  it('reports a busy port clearly', async () => {
    const first = await startCallbackServer({ port: 0, state: 's', timeoutMs: 5000 });
    await expect(startCallbackServer({ port: first.port, state: 's', timeoutMs: 5000 })).rejects.toThrow(
      /already in use/,
    );
    await first.close();
  });
});

describe('facebook commands', () => {
  let dir: string;
  let cleanup: () => void;
  let store: MemoryTokenStore;
  let out: ReturnType<typeof collectOutput>;
  const env = {
    FACEBOOK_APP_ID: APP.appId,
    FACEBOOK_APP_SECRET: APP.appSecret,
    GRAPH_API_VERSION: APP.graphApiVersion,
  };
  const ctx = (extraEnv: Record<string, string> = {}): AppContext => {
    out = collectOutput();
    return createContext({ cwd: dir, env: { ...env, ...extraEnv }, print: out.print, tokenStore: store });
  };
  const client = (graph: ReturnType<typeof fakeGraph>) =>
    new GraphClient({ version: 'v26.0', appSecret: APP.appSecret, fetch: graph.fetch });
  const creds = () => ctx().withDb((db) => resolvePageCredentials(ctx().config, db, store));

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    runInit(dir, () => {});
    store = new MemoryTokenStore();
  });
  afterEach(() => {
    cleanup();
  });

  it('login: browser → code → long-lived token → Page token in the store', async () => {
    const graph = fakeGraph(loginRoutes());
    const result = await runFacebookLogin(ctx(), { port: '0' }, { client: client(graph), openUrl: approve.openUrl });

    expect(result).toEqual({ page: { id: PAGE_A.id, name: PAGE_A.name }, storeKind: 'memory' });
    expect(store.get(`page:${PAGE_A.id}`)).toBe('PAGE-TOKEN-A');
    expect(store.get('user')).toBe('LONG-USER-TOKEN');
    expect(out.text()).toContain('✓ Connected to Page "Drama Page" (101)');
    expect(out.text()).not.toMatch(/PAGE-TOKEN|USER-TOKEN/);
    expect(creds()).toEqual({ pageId: PAGE_A.id, pageName: PAGE_A.name, token: 'PAGE-TOKEN-A', source: 'memory' });

    // exact OAuth sequence
    expect(graph.requests.map((r) => r.path)).toEqual([
      'oauth/access_token',
      'oauth/access_token',
      'debug_token',
      'me/accounts',
    ]);
    expect(graph.requests[0]?.params).toMatchObject({
      code: 'AUTH-CODE',
      client_id: APP.appId,
      redirect_uri: expect.stringMatching(/^http:\/\/localhost:\d+\/callback$/),
    });
    expect(graph.requests[1]?.params).toMatchObject({
      grant_type: 'fb_exchange_token',
      fb_exchange_token: 'SHORT-USER-TOKEN',
    });
    expect(graph.requests[3]?.params.access_token).toBe('LONG-USER-TOKEN');
  });

  it('login: picks via choosePage when several Pages are publishable, skipping read-only ones', async () => {
    const graph = fakeGraph(loginRoutes({ pages: [PAGE_A, PAGE_B, PAGE_RO] }));
    let offered: string[] = [];
    const result = await runFacebookLogin(
      ctx(),
      { port: '0' },
      {
        client: client(graph),
        openUrl: approve.openUrl,
        choosePage: async (pages) => {
          offered = pages.map((p) => p.id);
          return pages[1]!;
        },
      },
    );
    expect(offered).toEqual([PAGE_A.id, PAGE_B.id]);
    expect(result.page.id).toBe(PAGE_B.id);
  });

  it('login: --page selects directly and rejects Pages you cannot publish to', async () => {
    const graph = fakeGraph(loginRoutes({ pages: [PAGE_A, PAGE_RO] }));
    await expect(
      runFacebookLogin(ctx(), { port: '0', page: PAGE_RO.id }, { client: client(graph), openUrl: approve.openUrl }),
    ).rejects.toThrow(/CREATE_CONTENT/);
    await expect(
      runFacebookLogin(ctx(), { port: '0', page: '999' }, { client: client(graph), openUrl: approve.openUrl }),
    ).rejects.toThrow(/Page 999 is not among/);
    expect(store.get(`page:${PAGE_RO.id}`)).toBeUndefined();
  });

  it('login: fails clearly when permissions were declined or the user cancelled', async () => {
    const declined = fakeGraph(loginRoutes({ scopes: ['pages_show_list'] }));
    await expect(
      runFacebookLogin(ctx(), { port: '0' }, { client: client(declined), openUrl: approve.openUrl }),
    ).rejects.toThrow('Facebook did not grant: pages_read_engagement, pages_manage_posts');
    const cancel = fakeBrowser((redirect, state) => {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('state', state);
      return redirect;
    });
    await expect(
      runFacebookLogin(ctx(), { port: '0' }, { client: client(fakeGraph(loginRoutes())), openUrl: cancel.openUrl }),
    ).rejects.toThrow(/not completed: access_denied/);
    expect(store.get('user')).toBeUndefined();
  });

  it('login: prints the URL when no browser can be opened', async () => {
    let printedUrl = '';
    const graph = fakeGraph(loginRoutes());
    const c = ctx();
    const originalPrint = c.print;
    c.print = (line = '') => {
      originalPrint(line);
      if (line.trim().startsWith('https://www.facebook.com/')) {
        printedUrl = line.trim();
        const u = new URL(printedUrl);
        const cb = new URL(u.searchParams.get('redirect_uri') ?? '');
        cb.searchParams.set('code', 'C');
        cb.searchParams.set('state', u.searchParams.get('state') ?? '');
        setTimeout(() => void fetch(cb), 10);
      }
    };
    await runFacebookLogin(c, { port: '0', browser: false }, { client: client(graph), openUrl: async () => true });
    expect(printedUrl).toContain('dialog/oauth');
    expect(out.text()).toContain('Open this URL in your browser');
  });

  it('login: requires app credentials', async () => {
    const c = createContext({ cwd: dir, env: {}, print: () => {}, tokenStore: store });
    await expect(runFacebookLogin(c)).rejects.toThrow(/FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set/);
  });

  it('pages: lists and switches the selected Page', async () => {
    const graph = fakeGraph(loginRoutes({ pages: [PAGE_A, PAGE_B, PAGE_RO] }));
    await expect(runFacebookPages(ctx(), {}, { client: client(graph) })).rejects.toThrow(/Not logged in/);
    store.set('user', 'LONG-USER-TOKEN');
    await runFacebookPages(ctx(), {}, { client: client(graph) });
    expect(out.text()).toContain('303  Read Only Page  (cannot publish');
    await runFacebookPages(ctx(), { select: PAGE_B.id }, { client: client(graph) });
    expect(creds()?.pageId).toBe(PAGE_B.id);
    await expect(runFacebookPages(ctx(), { select: PAGE_RO.id }, { client: client(graph) })).rejects.toThrow(UserError);
  });

  it('verify: accepts a valid never-expiring PAGE token and flags problems', async () => {
    await expect(runFacebookVerify(ctx(), { client: client(fakeGraph(loginRoutes())) })).rejects.toThrow(
      /No Page connected/,
    );
    await runFacebookLogin(
      ctx(),
      { port: '0' },
      { client: client(fakeGraph(loginRoutes())), openUrl: approve.openUrl },
    );

    const good = await runFacebookVerify(ctx(), { client: client(fakeGraph(loginRoutes())) });
    expect(good).toMatchObject({ code: 0, report: { ok: true, expires: 'never', type: 'PAGE' } });
    expect(out.text()).toContain('✓ Token is valid for publishing.');

    const bad = await runFacebookVerify(ctx(), {
      client: client(
        fakeGraph(
          loginRoutes({ pageTokenDebug: { is_valid: false, profile_id: '999', scopes: ALL_SCOPES.slice(0, 1) } }),
        ),
      ),
    });
    expect(bad.code).toBe(1);
    expect(bad.report.problems).toEqual([
      'token is not valid',
      'token belongs to Page 999, not 101',
      'missing permissions: pages_read_engagement, pages_manage_posts',
    ]);
  });

  it('.env Page token overrides the stored login', async () => {
    await runFacebookLogin(
      ctx(),
      { port: '0' },
      { client: client(fakeGraph(loginRoutes())), openUrl: approve.openUrl },
    );
    const c = ctx({ FACEBOOK_PAGE_ID: '555', FACEBOOK_PAGE_ACCESS_TOKEN: 'ENV-TOKEN' });
    expect(c.withDb((db) => resolvePageCredentials(c.config, db, store))).toMatchObject({
      pageId: '555',
      source: 'env',
    });
  });

  it('logout removes tokens and the selected Page', async () => {
    await runFacebookLogin(
      ctx(),
      { port: '0' },
      { client: client(fakeGraph(loginRoutes())), openUrl: approve.openUrl },
    );
    runFacebookLogout(ctx());
    expect(store.get(`page:${PAGE_A.id}`)).toBeUndefined();
    expect(store.get('user')).toBeUndefined();
    expect(ctx().withDb((db) => getAppState(db, 'page_id'))).toBeUndefined();
    runFacebookLogout(ctx());
    expect(out.text()).toContain('Nothing to log out from.');
  });
});
