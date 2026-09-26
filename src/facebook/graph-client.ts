import { createHmac } from 'node:crypto';
import type { z } from 'zod';

export const GRAPH_HOST = 'https://graph.facebook.com';
/** Host for Page video uploads (`POST /{page-id}/videos`). */
export const GRAPH_VIDEO_HOST = 'https://graph-video.facebook.com';
/** Host for Reel binary uploads (`POST /video-upload/{ver}/{video-id}`). */
export const RUPLOAD_HOST = 'https://rupload.facebook.com';

export interface FacebookErrorDetails {
  /** Set when Facebook answered; undefined for network failures/timeouts (outcome unknown). */
  httpStatus?: number;
  code?: number;
  subcode?: number;
  type?: string;
  fbtraceId?: string;
  /** Facebook's own hint that retrying may succeed. */
  isTransient?: boolean;
}

/** A Graph API error response, or a network failure (httpStatus undefined). Never contains tokens. */
export class FacebookApiError extends Error {
  override readonly name = 'FacebookApiError';
  constructor(
    message: string,
    readonly details: FacebookErrorDetails = {},
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
  /** Timeout for binary uploads (default 15 min). */
  uploadTimeoutMs?: number;
}

export interface GraphRequest {
  /** Access token to send. Never logged; sent in the body for POST requests. */
  token?: string;
  /** Skip appsecret_proof (e.g. when `token` is the app token itself). */
  noProof?: boolean;
  /** Override the host, e.g. GRAPH_VIDEO_HOST for Page video uploads. */
  host?: string;
}

export type FormValue = string | Blob;

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    is_transient?: boolean;
    error_user_msg?: string;
  };
}

export class GraphClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: GraphClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  get version(): string {
    return this.opts.version;
  }

  /** GET /{version}/{path}, validated against `schema`. */
  async get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>, req: GraphRequest = {}): Promise<T> {
    const url = this.url(path, req.host);
    for (const [k, v] of Object.entries({ ...params, ...this.auth(req) })) url.searchParams.set(k, v);
    return this.send(url, { method: 'GET' }, schema, this.opts.timeoutMs ?? 30_000);
  }

  /** POST /{version}/{path} as form data (multipart when a Blob is included). */
  async post<T>(
    path: string,
    fields: Record<string, FormValue | undefined>,
    schema: z.ZodType<T>,
    req: GraphRequest = {},
  ): Promise<T> {
    const all: Record<string, FormValue> = { ...this.auth(req) };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) all[k] = v;
    const hasBlob = Object.values(all).some((v) => v instanceof Blob);
    let body: FormData | URLSearchParams;
    if (hasBlob) {
      const form = new FormData();
      for (const [k, v] of Object.entries(all)) form.append(k, v);
      body = form;
    } else {
      body = new URLSearchParams(all as Record<string, string>);
    }
    const timeout = hasBlob ? (this.opts.uploadTimeoutMs ?? 15 * 60_000) : (this.opts.timeoutMs ?? 60_000);
    return this.send(this.url(path, req.host), { method: 'POST', body }, schema, timeout);
  }

  /** Reel binary upload to rupload.facebook.com (resumable via `offset`). */
  async uploadReelBinary<T>(
    videoId: string,
    token: string,
    data: Uint8Array,
    offset: number,
    fileSize: number,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${RUPLOAD_HOST}/video-upload/${this.opts.version}/${videoId}`);
    const headers = { Authorization: `OAuth ${token}`, offset: String(offset), file_size: String(fileSize) };
    return this.send(url, { method: 'POST', headers, body: data }, schema, this.opts.uploadTimeoutMs ?? 15 * 60_000);
  }

  private url(path: string, host = GRAPH_HOST): URL {
    return new URL(`${host}/${this.opts.version}/${path.replace(/^\//, '')}`);
  }

  private auth(req: GraphRequest): Record<string, string> {
    if (!req.token) return {};
    const out: Record<string, string> = { access_token: req.token };
    if (this.opts.appSecret && !req.noProof) out.appsecret_proof = appSecretProof(req.token, this.opts.appSecret);
    return out;
  }

  private async send<T>(url: URL, init: RequestInit, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new FacebookApiError(`Network error calling Facebook: ${(err as Error).message}`);
    }
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok || (body as GraphErrorBody).error) {
      const e = (body as GraphErrorBody).error ?? {};
      throw new FacebookApiError(e.error_user_msg ?? e.message ?? `HTTP ${res.status}`, {
        httpStatus: res.status,
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        fbtraceId: e.fbtrace_id,
        isTransient: e.is_transient,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new FacebookApiError(
        `Unexpected Facebook response for ${url.pathname}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        { httpStatus: res.status },
      );
    }
    return parsed.data;
  }
}

/** HMAC-SHA256 of the access token keyed by the app secret. */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}
