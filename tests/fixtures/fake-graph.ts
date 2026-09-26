/**
 * Minimal fake of graph.facebook.com for tests: routes by path, records every request.
 * No real Facebook calls are ever made in automated tests.
 */
export interface FakeGraphRequest {
  method: string;
  host: string;
  /** Path without the version prefix, e.g. "me/accounts", "123/video_reels", "video-upload/999". */
  path: string;
  /** Query params merged with form fields; Blob fields are reported as "<blob:SIZE>". */
  params: Record<string, string>;
  headers: Record<string, string>;
  /** Raw binary body size (rupload), if any. */
  bodyBytes?: number;
}

type RouteResult = { status?: number; body: unknown } | 'network-error';
type Route = (params: Record<string, string>, req: FakeGraphRequest) => RouteResult;

export function fakeGraph(routes: Record<string, Route>) {
  const requests: FakeGraphRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const path = url.pathname
      .replace(/^\/v\d+\.\d+\//, '')
      .replace(/^\/video-upload\/v\d+\.\d+\//, 'video-upload/')
      .replace(/^\//, '');
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    let bodyBytes: number | undefined;
    const body = init.body;
    if (body instanceof URLSearchParams) Object.assign(params, Object.fromEntries(body));
    else if (body instanceof FormData) {
      for (const [k, v] of body.entries()) params[k] = typeof v === 'string' ? v : `<blob:${v.size}>`;
    } else if (body instanceof Uint8Array) bodyBytes = body.byteLength;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req: FakeGraphRequest = { method: init.method ?? 'GET', host: url.host, path, params, headers, bodyBytes };
    requests.push(req);
    const route = routes[path] ?? routes['*'];
    if (!route)
      return new Response(JSON.stringify({ error: { message: `no fake route for ${path}`, code: 100 } }), {
        status: 400,
      });
    const result = route(params, req);
    if (result === 'network-error') throw new TypeError('fetch failed');
    const { status = 200, body: resBody } = result;
    return new Response(JSON.stringify(resBody), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

/** A Graph error body, e.g. graphError(190, 'Invalid OAuth access token.'). */
export function graphError(code: number, message: string, status = 400, extra: Record<string, unknown> = {}) {
  return { status, body: { error: { message, code, type: 'OAuthException', fbtrace_id: 'TRACE', ...extra } } };
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
