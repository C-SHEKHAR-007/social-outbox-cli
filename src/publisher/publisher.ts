import { existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { setAppState } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import type { NewVideo, Video } from '../db/schema.js';
import { findVideoById, updateVideo } from '../db/video-repository.js';
import type { AttemptStep } from '../domain/states.js';
import { buildDescription } from '../content/description.js';
import { classifyError, describeError, wasAnswered, type ErrorClass } from '../facebook/errors.js';
import type { GraphClient } from '../facebook/graph-client.js';
import {
  getVideoStatus,
  pageVideoFinish,
  pageVideoStart,
  pageVideoTransfer,
  reelFinish,
  reelStart,
  reelTransfer,
  type ChunkWindow,
} from '../facebook/video-api.js';
import { sha256File } from '../scanner/file-identity.js';
import type { Logger } from '../utils/logger.js';
import { toIso } from '../utils/time.js';
import { finishAttempt, startAttempt } from './attempts.js';
import type { PublishDecision } from './decision.js';
import { claimVideo, releaseVideo } from './lease.js';
import { interpretStatus, type RemoteState } from './remote-status.js';

export interface PublisherDeps {
  db: Db;
  client: GraphClient;
  page: { id: string; token: string };
  owner: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Retries for transient failures per step (MAX_RETRIES). */
  maxRetries: number;
  /** Backoff before retry n (last value repeats). Default 5s, 15s, 45s. */
  backoffMs?: number[];
  /** How long to poll Facebook for processing to finish before leaving the video in PROCESSING. */
  pollTimeoutMs: number;
  pollIntervalMs: number;
  hash?: (file: string) => Promise<string>;
}

export type PublishResult =
  'published' | 'scheduled' | 'draft' | 'processing' | 'uploading' | 'held' | 'skipped' | 'failed' | 'unknown';

export interface PublishOutcome {
  videoId: number;
  result: PublishResult;
  message?: string;
  /** Set when the whole run must stop (or stop submitting this target). */
  stop?: Extract<ErrorClass, 'fatal' | 'pause' | 'rate_limit'>;
}

type SubmitDecision = Extract<PublishDecision, { kind: 'now' | 'schedule' | 'draft' }>;

/** Thrown inside a step to abort the video with a classified error. */
class StepFailure extends Error {
  constructor(
    readonly cls: ErrorClass,
    readonly original: unknown,
    readonly step: AttemptStep,
  ) {
    super(describeError(original).message);
  }
}

const DEFAULT_BACKOFF = [5_000, 15_000, 45_000];
const CLAIMABLE = ['READY', 'HELD', 'UPLOADING'] as const;

/**
 * Publishes one video end to end: claim → verify file → START → TRANSFER → FINISH → VERIFY.
 * Every state change is written before the next network call, so a crash at any point is
 * recoverable without posting twice (docs/plan.md §7.1).
 */
export async function publishOne(
  deps: PublisherDeps,
  videoId: number,
  decision: SubmitDecision,
): Promise<PublishOutcome> {
  const { db } = deps;
  if (!claimVideo(db, videoId, deps.owner, deps.now(), CLAIMABLE)) {
    return { videoId, result: 'skipped', message: 'locked by another run or no longer publishable' };
  }
  try {
    const video = mustFind(db, videoId);
    const file = video.normalizedPath ?? video.filePath;

    // Fresh uploads re-verify the file against the scan (content identity).
    if (!video.fbVideoId) {
      if (!existsSync(file)) return skip(deps, video, `file does not exist: ${file}`);
      const hash = await (deps.hash ?? sha256File)(video.filePath);
      if (hash !== video.fileHash) return skip(deps, video, 'file content changed since scan; rescan the folder');
    }

    return video.publishTarget === 'REEL'
      ? await publishReel(deps, video, file, decision)
      : await publishPageVideo(deps, video, file, decision);
  } catch (err) {
    return handleFailure(deps, videoId, err);
  } finally {
    releaseVideo(db, videoId, deps.owner);
  }
}

// ---------- Reels ----------

async function publishReel(
  deps: PublisherDeps,
  video: Video,
  file: string,
  decision: SubmitDecision,
): Promise<PublishOutcome> {
  const { db, client, page } = deps;
  const size = (await stat(file)).size;
  let fbVideoId = video.fbVideoId;
  let offset = 0;

  if (fbVideoId) {
    // Resuming after a crash/transient failure: ask Facebook how far the upload got.
    const remote = await step(deps, video.id, 'RECONCILE', () => fetchRemote(deps, fbVideoId as string));
    if (remote.outcome === 'failed')
      fbVideoId = null; // stale upload: start over (nothing was public)
    else if (isTerminalOrProcessing(remote)) return settle(deps, video.id, remote, decision);
    else offset = remote.outcome === 'uploaded' ? size : (remote.bytesTransferred ?? 0);
  }

  if (!fbVideoId) {
    const started = await step(deps, video.id, 'START', () => reelStart(client, page.id, page.token));
    fbVideoId = started.videoId;
    // Saved before any bytes are sent: from now on this video is never STARTed twice.
    updateVideo(db, video.id, {
      fbVideoId,
      state: 'UPLOADING',
      bytesUploaded: 0,
      lastError: null,
      lastErrorCode: null,
    });
    offset = 0;
  }

  if (offset < size) {
    const data = (await readFile(file)).subarray(offset);
    const id = fbVideoId;
    await step(
      deps,
      video.id,
      'TRANSFER',
      () => reelTransfer(client, id, page.token, data, offset, size),
      `${size - offset} bytes`,
    );
  }
  updateVideo(db, video.id, { bytesUploaded: size });

  const reelState = decision.kind === 'now' ? 'PUBLISHED' : decision.kind === 'schedule' ? 'SCHEDULED' : 'DRAFT';
  const id = fbVideoId;
  const finished = await finish(deps, video, () =>
    reelFinish(client, page.id, page.token, {
      videoId: id,
      state: reelState,
      description: buildDescription(video.caption, video.hashtags),
      title: video.title ?? undefined,
      scheduledAt: decision.kind === 'schedule' ? decision.at : undefined,
      isAiGenerated: video.isAiGenerated,
    }),
  );
  if (finished.outcome) return finished.outcome;
  if (finished.value.postId) updateVideo(db, video.id, { fbPostId: finished.value.postId });
  return verify(deps, video.id, id, decision);
}

// ---------- Page videos ----------

async function publishPageVideo(
  deps: PublisherDeps,
  video: Video,
  file: string,
  decision: SubmitDecision,
): Promise<PublishOutcome> {
  const { db, client, page } = deps;
  const size = (await stat(file)).size;

  if (video.fbVideoId) {
    // Chunked sessions can't be resumed across runs; if FINISH was never applied, re-upload.
    const remote = await step(deps, video.id, 'RECONCILE', () => fetchRemote(deps, video.fbVideoId as string));
    if (isTerminalOrProcessing(remote)) return settle(deps, video.id, remote, decision);
  }

  const started = await step(deps, video.id, 'START', () => pageVideoStart(client, page.id, page.token, size));
  updateVideo(db, video.id, {
    fbVideoId: started.videoId,
    state: 'UPLOADING',
    bytesUploaded: 0,
    lastError: null,
    lastErrorCode: null,
  });

  let window: ChunkWindow = started.next;
  const handle = await open(file, 'r');
  try {
    while (window.start < window.end) {
      const chunk = new Uint8Array(window.end - window.start);
      await handle.read(chunk, 0, chunk.length, window.start);
      const from = window.start;
      window = await step(
        deps,
        video.id,
        'TRANSFER',
        () => pageVideoTransfer(client, page.id, page.token, started.sessionId, from, chunk),
        `bytes ${from}-${from + chunk.length}`,
      );
      updateVideo(db, video.id, { bytesUploaded: window.start });
    }
  } finally {
    await handle.close();
  }

  const mode = decision.kind === 'now' ? 'now' : decision.kind === 'schedule' ? 'schedule' : 'draft';
  const finished = await finish(deps, video, () =>
    pageVideoFinish(client, page.id, page.token, {
      sessionId: started.sessionId,
      mode,
      description: buildDescription(video.caption, video.hashtags),
      title: video.title ?? undefined,
      scheduledAt: decision.kind === 'schedule' ? decision.at : undefined,
    }),
  );
  if (finished.outcome) return finished.outcome;
  return verify(deps, video.id, started.videoId, decision);
}

// ---------- shared steps ----------

/**
 * FINISH is the one step that can make a video public, so it is guarded: state FINISHING and
 * finish_sent_at are written first, and if Facebook never answered (network error/timeout) the
 * outcome is unknown: the video stays FINISHING for `reconcile` and FINISH is NOT resent.
 */
async function finish<T>(
  deps: PublisherDeps,
  video: Video,
  call: () => Promise<T>,
): Promise<{ value: T; outcome?: undefined } | { outcome: PublishOutcome }> {
  const { db } = deps;
  for (let attempt = 0; ; attempt++) {
    updateVideo(db, video.id, { state: 'FINISHING', finishSentAt: toIso(deps.now()) });
    const attemptId = startAttempt(db, video.id, 'FINISH');
    try {
      const value = await call();
      finishAttempt(db, attemptId, 'ok');
      updateVideo(db, video.id, { state: 'PROCESSING' });
      return { value };
    } catch (err) {
      const cls = classifyError(err);
      finishAttempt(db, attemptId, cls === 'transient' ? 'transient' : cls === 'permanent' ? 'permanent' : 'fatal', {
        error: err,
      });
      if (!wasAnswered(err)) {
        const msg = `FINISH outcome unknown (${describeError(err).message}); run \`reel-cli reconcile\``;
        updateVideo(db, video.id, { lastError: msg, lastErrorCode: null });
        deps.logger?.warn({ op: 'publish', videoId: video.id, step: 'FINISH' }, 'finish outcome unknown');
        return { outcome: { videoId: video.id, result: 'unknown', message: msg } };
      }
      // Facebook answered with an error, so FINISH was definitely not applied: safe to retry/back off.
      updateVideo(db, video.id, { state: 'UPLOADING' });
      if (cls === 'transient' && attempt < deps.maxRetries) {
        await deps.sleep(backoff(deps, attempt));
        continue;
      }
      throw new StepFailure(cls, err, 'FINISH');
    }
  }
}

/** Polls status until Facebook settles or the poll window ends (then the video stays PROCESSING). */
async function verify(
  deps: PublisherDeps,
  videoId: number,
  fbVideoId: string,
  decision: SubmitDecision,
): Promise<PublishOutcome> {
  const deadline = deps.now().getTime() + deps.pollTimeoutMs;
  for (;;) {
    let remote: RemoteState;
    try {
      remote = await fetchRemote(deps, fbVideoId);
    } catch (err) {
      if (classifyError(err) !== 'transient') throw new StepFailure(classifyError(err), err, 'VERIFY');
      remote = { outcome: 'processing' };
    }
    if (remote.outcome !== 'processing' && remote.outcome !== 'uploaded' && remote.outcome !== 'uploading') {
      const attemptId = startAttempt(deps.db, videoId, 'VERIFY');
      finishAttempt(deps.db, attemptId, remote.outcome === 'failed' ? 'permanent' : 'ok', {
        message: remote.message ?? remote.outcome,
      });
      return settle(deps, videoId, remote, decision);
    }
    if (deps.now().getTime() >= deadline) {
      return {
        videoId,
        result: 'processing',
        message: 'still processing on Facebook; `reel-cli reconcile` will pick it up',
      };
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

/** Applies a settled remote state to the row. */
export function settle(
  deps: Pick<PublisherDeps, 'db' | 'now' | 'logger'>,
  videoId: number,
  remote: RemoteState,
  decision?: SubmitDecision,
): PublishOutcome {
  const { db } = deps;
  const common: Partial<NewVideo> = {
    fbPermalink: remote.permalink ?? undefined,
    lastError: null,
    lastErrorCode: null,
    retryCount: 0,
  };
  let outcome: RemoteState['outcome'] = remote.outcome;
  if (outcome === 'unpublished') outcome = decision?.kind === 'draft' ? 'draft' : 'scheduled';

  let result: PublishResult;
  switch (outcome) {
    case 'published':
      updateVideo(db, videoId, { ...common, state: 'PUBLISHED', publishedAt: toIso(remote.publishTime ?? deps.now()) });
      result = 'published';
      break;
    case 'scheduled':
      updateVideo(db, videoId, { ...common, state: 'SCHEDULED' });
      result = 'scheduled';
      break;
    case 'draft':
      updateVideo(db, videoId, { ...common, state: 'DRAFT' });
      result = 'draft';
      break;
    case 'failed':
      updateVideo(db, videoId, {
        state: 'FAILED',
        lastError: remote.message ?? 'failed on Facebook',
        lastErrorCode: 'REMOTE',
      });
      result = 'failed';
      break;
    case 'uploaded':
    case 'uploading':
      updateVideo(db, videoId, { state: 'UPLOADING' });
      result = 'uploading';
      break;
    default:
      updateVideo(db, videoId, { state: 'PROCESSING' });
      result = 'processing';
  }
  deps.logger?.info({ op: 'publish', videoId, result, permalink: remote.permalink }, 'publish settled');
  return { videoId, result, message: remote.message };
}

/** Runs a network step with transient retries, recording every try in publish_attempts. */
async function step<T>(
  deps: PublisherDeps,
  videoId: number,
  name: AttemptStep,
  call: () => Promise<T>,
  note?: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const attemptId = startAttempt(deps.db, videoId, name);
    try {
      const value = await call();
      finishAttempt(deps.db, attemptId, 'ok', note ? { message: note } : undefined);
      return value;
    } catch (err) {
      const cls = classifyError(err);
      finishAttempt(
        deps.db,
        attemptId,
        cls === 'transient' ? 'transient' : cls === 'permanent' ? 'permanent' : 'fatal',
        { error: err },
      );
      deps.logger?.warn(
        { op: 'publish', videoId, step: name, attempt, cls, error: describeError(err).message },
        'step failed',
      );
      if (cls === 'transient' && attempt < deps.maxRetries) {
        updateVideo(deps.db, videoId, { retryCount: attempt + 1 });
        await deps.sleep(backoff(deps, attempt));
        continue;
      }
      throw new StepFailure(cls, err, name);
    }
  }
}

function handleFailure(deps: PublisherDeps, videoId: number, err: unknown): PublishOutcome {
  const { db } = deps;
  const failure = err instanceof StepFailure ? err : new StepFailure(classifyError(err), err, 'START');
  const { code, message } = describeError(failure.original);
  const video = findVideoById(db, videoId);
  const where = `${failure.step}: ${message}`;
  switch (failure.cls) {
    case 'fatal':
      // Token/permission problem: leave the state exactly as it is; the whole run stops.
      updateVideo(db, videoId, { lastError: where, lastErrorCode: code });
      return { videoId, result: 'skipped', message: where, stop: 'fatal' };
    case 'pause':
      setAppState(db, 'publishing_paused', 'true');
      setAppState(db, 'paused_reason', `Facebook error ${code ?? '368'} at ${where}`);
      updateVideo(db, videoId, { lastError: where, lastErrorCode: code });
      return { videoId, result: 'skipped', message: where, stop: 'pause' };
    case 'rate_limit':
      updateVideo(db, videoId, {
        state: video?.state === 'UPLOADING' || video?.state === 'FINISHING' ? 'UPLOADING' : 'HELD',
        nextAttemptAt: toIso(new Date(deps.now().getTime() + 60 * 60 * 1000)),
        lastError: where,
        lastErrorCode: code,
      });
      return { videoId, result: 'held', message: where, stop: 'rate_limit' };
    default:
      updateVideo(db, videoId, { state: 'FAILED', lastError: where, lastErrorCode: code });
      deps.logger?.error({ op: 'publish', videoId, step: failure.step, code, error: message }, 'publish failed');
      return { videoId, result: 'failed', message: where };
  }
}

function skip(deps: PublisherDeps, video: Video, reason: string): PublishOutcome {
  updateVideo(deps.db, video.id, { lastError: reason, lastErrorCode: 'PRECHECK' });
  return { videoId: video.id, result: 'skipped', message: reason };
}

async function fetchRemote(deps: Pick<PublisherDeps, 'client' | 'page'>, fbVideoId: string): Promise<RemoteState> {
  return interpretStatus(await getVideoStatus(deps.client, fbVideoId, deps.page.token));
}

function isTerminalOrProcessing(r: RemoteState): boolean {
  return ['published', 'scheduled', 'draft', 'processing', 'unpublished'].includes(r.outcome);
}

function backoff(deps: PublisherDeps, attempt: number): number {
  const list = deps.backoffMs ?? DEFAULT_BACKOFF;
  return list[Math.min(attempt, list.length - 1)] ?? 0;
}

function mustFind(db: Db, id: number): Video {
  const v = findVideoById(db, id);
  if (!v) throw new Error(`video ${id} not found`);
  return v;
}

/**
 * Settles one video whose outcome is pending or unknown (FINISHING, PROCESSING, SCHEDULED past its
 * time) by asking Facebook. FINISHING + "uploaded" means FINISH never landed: the row goes back to
 * UPLOADING so the next `publish` resends FINISH (safe, nothing is public yet).
 */
export async function reconcileOne(deps: PublisherDeps, videoId: number): Promise<PublishOutcome> {
  const { db } = deps;
  if (!claimVideo(db, videoId, deps.owner, deps.now(), ['FINISHING', 'PROCESSING', 'SCHEDULED'])) {
    return { videoId, result: 'skipped', message: 'locked by another run' };
  }
  try {
    const video = mustFind(db, videoId);
    if (!video.fbVideoId) {
      updateVideo(db, videoId, { state: 'UPLOADING', lastError: 'no Facebook video id recorded; will re-upload' });
      return { videoId, result: 'uploading' };
    }
    const id = video.fbVideoId;
    const remote = await step(deps, videoId, 'RECONCILE', () => fetchRemote(deps, id));
    if (video.state === 'SCHEDULED' && remote.outcome === 'scheduled') return { videoId, result: 'scheduled' };
    const decision: SubmitDecision | undefined =
      video.action === 'SCHEDULE' && video.scheduledAt
        ? { kind: 'schedule', at: new Date(video.scheduledAt) }
        : undefined;
    return settle(deps, videoId, remote, decision);
  } catch (err) {
    return handleFailure(deps, videoId, err);
  } finally {
    releaseVideo(db, videoId, deps.owner);
  }
}
