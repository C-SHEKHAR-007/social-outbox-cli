import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { runInstagramConnect, runInstagramStatus } from '../../src/cli/commands/instagram.js';
import { createContext, type AppContext } from '../../src/cli/context.js';
import { getAppState, setAppState } from '../../src/db/app-state.js';
import { GraphClient } from '../../src/facebook/graph-client.js';
import { MemoryTokenStore } from '../../src/facebook/token-store.js';
import { APP, fakeGraph, PAGE_A } from '../fixtures/fake-graph.js';
import { collectOutput, makeTempDir } from '../helpers.js';

const IG = '17841400000000001';
const FB_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const IG_SCOPES = ['instagram_basic', 'instagram_content_publish'];

describe('instagram connect / status', () => {
  let dir: string;
  let cleanup: () => void;
  let store: MemoryTokenStore;
  let out: ReturnType<typeof collectOutput>;
  const env = { FACEBOOK_APP_ID: APP.appId, FACEBOOK_APP_SECRET: APP.appSecret };
  const ctx = (): AppContext => {
    out = collectOutput();
    return createContext({ cwd: dir, env, print: out.print, tokenStore: store });
  };
  /** Graph fake: page token scopes are configurable; login flow returns a token with all scopes. */
  function graph(opts: { pageScopes: string[]; linked?: boolean }) {
    let tokenScopes = opts.pageScopes;
    return fakeGraph({
      debug_token: (p) =>
        p.input_token?.startsWith('PAGE-')
          ? { body: { data: { is_valid: true, type: 'PAGE', scopes: tokenScopes } } }
          : { body: { data: { is_valid: true, type: 'USER', scopes: [...FB_SCOPES, ...IG_SCOPES] } } },
      'oauth/access_token': (p) => {
        if (p.grant_type === 'fb_exchange_token') tokenScopes = [...FB_SCOPES, ...IG_SCOPES];
        return { body: { access_token: p.grant_type ? 'LONG-USER' : 'SHORT-USER' } };
      },
      'me/accounts': () => ({ body: { data: [{ ...PAGE_A, access_token: 'PAGE-TOKEN-IG' }] } }),
      [PAGE_A.id]: () => ({
        body:
          opts.linked === false
            ? { id: PAGE_A.id }
            : { id: PAGE_A.id, instagram_business_account: { id: IG, username: 'drama_ig' } },
      }),
      [`${IG}/content_publishing_limit`]: () => ({
        body: { data: [{ quota_usage: 2, config: { quota_total: 100 } }] },
      }),
    });
  }
  const client = (g: ReturnType<typeof fakeGraph>) =>
    new GraphClient({ version: 'v26.0', appSecret: APP.appSecret, fetch: g.fetch });
  const browser = (opened: string[]) => async (url: string) => {
    opened.push(url);
    const u = new URL(url);
    const cb = new URL(u.searchParams.get('redirect_uri') ?? '');
    cb.searchParams.set('code', 'CODE');
    cb.searchParams.set('state', u.searchParams.get('state') ?? '');
    setTimeout(() => void fetch(cb), 10);
    return true;
  };

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    runInit(dir, () => {});
    store = new MemoryTokenStore();
    store.set(`page:${PAGE_A.id}`, 'PAGE-TOKEN-A');
    ctx().withDb((db) => {
      setAppState(db, 'page_id', PAGE_A.id);
      setAppState(db, 'page_name', PAGE_A.name);
    });
  });
  afterEach(() => {
    cleanup();
  });

  it('links the account without a new login when the Page token already has Instagram permissions', async () => {
    const opened: string[] = [];
    const acct = await runInstagramConnect(
      ctx(),
      {},
      { client: client(graph({ pageScopes: [...FB_SCOPES, ...IG_SCOPES] })), openUrl: browser(opened) },
    );
    expect(acct).toEqual({ igUserId: IG, username: 'drama_ig' });
    expect(opened).toEqual([]);
    expect(out.text()).toContain('✓ Instagram connected: @drama_ig');
    expect(ctx().withDb((db) => getAppState(db, 'instagram_user_id'))).toBe(IG);
  });

  it('logs in again with Facebook + Instagram scopes when they are missing, keeping the same Page', async () => {
    const opened: string[] = [];
    await runInstagramConnect(
      ctx(),
      { port: '0' },
      { client: client(graph({ pageScopes: FB_SCOPES })), openUrl: browser(opened) },
    );
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]!).searchParams.get('scope')).toBe([...FB_SCOPES, ...IG_SCOPES].join(','));
    expect(store.get(`page:${PAGE_A.id}`)).toBe('PAGE-TOKEN-IG');
    expect(out.text()).toContain('missing Instagram permissions (instagram_basic, instagram_content_publish)');
  });

  it('explains how to link an Instagram account when none is linked', async () => {
    await expect(
      runInstagramConnect(
        ctx(),
        {},
        { client: client(graph({ pageScopes: [...FB_SCOPES, ...IG_SCOPES], linked: false })) },
      ),
    ).rejects.toThrow(/No Instagram professional account is linked/);
  });

  it('needs a connected Facebook Page first', async () => {
    store = new MemoryTokenStore();
    await expect(runInstagramConnect(ctx(), {}, { client: client(graph({ pageScopes: [] })) })).rejects.toThrow(
      /facebook login/,
    );
  });

  it("status shows the account, local counts and Instagram's own quota", async () => {
    await runInstagramStatus(ctx(), { client: client(graph({ pageScopes: [] })) });
    expect(out.text()).toContain('Not connected. Run: reel-cli instagram connect');
    ctx().withDb((db) => {
      setAppState(db, 'instagram_user_id', IG);
      setAppState(db, 'instagram_username', 'drama_ig');
    });
    await runInstagramStatus(ctx(), { client: client(graph({ pageScopes: [] })) });
    expect(out.text()).toContain('Account:      @drama_ig');
    expect(out.text()).toContain('Posts (24h):  0/25');
    expect(out.text()).toContain("Instagram's own quota: 2/100");
  });
});
