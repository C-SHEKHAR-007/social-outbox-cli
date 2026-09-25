/**
 * Minimal fake of graph.facebook.com for tests: routes by path, records every request.
 * No real Facebook calls are ever made in automated tests.
 */
export interface FakeGraphRequest {
  path: string;
  params: Record<string, string>;
}

type Route = (params: Record<string, string>) => { status?: number; body: unknown };

export function fakeGraph(routes: Record<string, Route>) {
  const requests: FakeGraphRequest[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, '');
    const params = Object.fromEntries(url.searchParams);
    requests.push({ path, params });
    const route = routes[path];
    if (!route)
      return new Response(JSON.stringify({ error: { message: `no fake route for ${path}`, code: 100 } }), {
        status: 400,
      });
    const { status = 200, body } = route(params);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

export const APP = { appId: '1111', appSecret: 'app-secret', graphApiVersion: 'v26.0' };
export const PAGE_A = {
  id: '101',
  name: 'Drama Page',
  access_token: 'PAGE-TOKEN-A',
  tasks: ['CREATE_CONTENT', 'MODERATE'],
};
export const PAGE_B = { id: '202', name: 'Second Page', access_token: 'PAGE-TOKEN-B', tasks: ['CREATE_CONTENT'] };
export const PAGE_RO = { id: '303', name: 'Read Only Page', access_token: 'PAGE-TOKEN-RO', tasks: ['ANALYZE'] };
export const ALL_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];

/** Happy-path routes for the full login flow. */
export function loginRoutes(
  over: { pages?: unknown[]; scopes?: string[]; pageTokenDebug?: Record<string, unknown> } = {},
): Record<string, Route> {
  return {
    'oauth/access_token': (p) =>
      p.grant_type === 'fb_exchange_token'
        ? { body: { access_token: 'LONG-USER-TOKEN', token_type: 'bearer', expires_in: 5_184_000 } }
        : { body: { access_token: 'SHORT-USER-TOKEN', token_type: 'bearer', expires_in: 3600 } },
    debug_token: (p) =>
      p.input_token?.startsWith('PAGE-')
        ? {
            body: {
              data: {
                is_valid: true,
                app_id: APP.appId,
                type: 'PAGE',
                profile_id: PAGE_A.id,
                scopes: ALL_SCOPES,
                expires_at: 0,
                ...over.pageTokenDebug,
              },
            },
          }
        : {
            body: {
              data: {
                is_valid: true,
                app_id: APP.appId,
                type: 'USER',
                scopes: over.scopes ?? ALL_SCOPES,
                expires_at: 1_900_000_000,
              },
            },
          },
    'me/accounts': () => ({ body: { data: over.pages ?? [PAGE_A] } }),
  };
}
