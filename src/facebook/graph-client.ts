import { createHmac } from 'node:crypto';
import type { z } from 'zod';

export const GRAPH_HOST = 'https://graph.facebook.com';

/** A Graph API error response, or a network failure (code undefined). Never contains tokens. */
export class FacebookApiError extends Error {
  override readonly name = 'FacebookApiError';
  constructor(
    message: string,
    readonly details: {
      httpStatus?: number;
      code?: number;
      subcode?: number;
      type?: string;
      fbtraceId?: string;
    } = {},
  ) {
    super(message);
  }
}

export interface GraphClientOptions {
  version: string;
  /** When set, `appsecret_proof` is sent with user/page-token calls (required if the app enforces it). */
  appSecret?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface GraphRequest {
  /** Access token to send. Tokens are passed as query params and never logged. */
  token?: string;
  /** Skip appsecret_proof (e.g. when `token` is the app token itself). */
  noProof?: boolean;
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

export class GraphClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: GraphClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** GET /{version}/{path}, validated against `schema`. */
  async get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>, req: GraphRequest = {}): Promise<T> {
    const url = new URL(`${GRAPH_HOST}/${this.opts.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (req.token) {
      url.searchParams.set('access_token', req.token);
      if (this.opts.appSecret && !req.noProof)
        url.searchParams.set('appsecret_proof', appSecretProof(req.token, this.opts.appSecret));
    }
    return this.request(url, schema);
  }

  private async request<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    } catch (err) {
      throw new FacebookApiError(`Network error calling Facebook: ${(err as Error).message}`);
    }
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok || (body as GraphErrorBody).error) {
      const e = (body as GraphErrorBody).error ?? {};
      throw new FacebookApiError(e.message ?? `HTTP ${res.status}`, {
        httpStatus: res.status,
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        fbtraceId: e.fbtrace_id,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new FacebookApiError(
        `Unexpected Facebook response for ${url.pathname}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    return parsed.data;
  }
}

/** HMAC-SHA256 of the access token keyed by the app secret. */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}
