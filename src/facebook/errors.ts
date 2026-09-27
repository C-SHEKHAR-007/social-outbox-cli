import { FacebookApiError } from './graph-client.js';

/**
 * How the publisher reacts to a failure (docs/plan.md §2.6):
 * - transient:  retry with backoff (network, 5xx, Facebook says is_transient, upload hiccups)
 * - rate_limit: hold the video and stop submitting more of that target this run
 * - fatal:      stop the whole run, leave states untouched (token/permission problems)
 * - pause:      stop and set publishing_paused (368 "abusive / disallowed")
 * - permanent:  fail this video only (invalid parameter, unsupported video, …)
 */
export type ErrorClass = 'transient' | 'rate_limit' | 'fatal' | 'pause' | 'permanent';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001]);
const FATAL_CODES = new Set([10, 102, 190, 200]);
const TRANSIENT_CODES = new Set([1, 2, 6000, 6001]);

export function classifyError(err: unknown): ErrorClass {
  if (!(err instanceof FacebookApiError)) return 'transient';
  const { httpStatus, code, isTransient } = err.details;
  if (httpStatus === undefined) return 'transient'; // network failure / timeout
  if (code === 368) return 'pause';
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return 'rate_limit';
  if (code !== undefined && (FATAL_CODES.has(code) || (code >= 200 && code < 300))) return 'fatal';
  if (isTransient === true || (code !== undefined && TRANSIENT_CODES.has(code)) || httpStatus >= 500)
    return 'transient';
  return 'permanent';
}

/**
 * True when Facebook definitely received and answered the request. A network error or timeout means
 * the outcome is unknown, which matters for FINISH: it may or may not have been applied.
 */
export function wasAnswered(err: unknown): boolean {
  return err instanceof FacebookApiError && err.details.httpStatus !== undefined;
}

/** Plain-language explanation for Facebook errors people actually hit. */
export function explainFacebookError(code: number | undefined, subcode: number | undefined): string | undefined {
  if (code === 368 && subcode === 1390008) {
    return 'Facebook temporarily blocked uploads for posting too fast (anti-spam). Wait at least 24 hours, then publish in small batches.';
  }
  if (code === 368)
    return 'Facebook flagged this action as abusive or disallowed. Check the Page in Meta Business Suite.';
  if (code === 190) return 'The Facebook token is invalid or expired. Run `reel-cli facebook login`.';
  if (code === 10 || (code !== undefined && code >= 200 && code < 300)) {
    return 'Missing permission. Run `reel-cli facebook verify` and `reel-cli facebook login`.';
  }
  if (code !== undefined && RATE_LIMIT_CODES.has(code))
    return 'Facebook rate limit reached; the video will be retried later.';
  return undefined;
}

/** Short, log-safe description, e.g. "[190/463] Invalid OAuth access token." */
export function describeError(err: unknown): { code: string | null; message: string } {
  if (err instanceof FacebookApiError) {
    const { code, subcode } = err.details;
    const explanation = explainFacebookError(code, subcode);
    const message = explanation && !err.message.includes(explanation) ? `${err.message} (${explanation})` : err.message;
    return { code: code === undefined ? null : `${code}${subcode ? `/${subcode}` : ''}`, message };
  }
  return { code: null, message: err instanceof Error ? err.message : String(err) };
}
