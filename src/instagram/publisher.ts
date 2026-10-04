import { readFile, stat } from 'node:fs/promises';
import { setAppState } from '../db/app-state.js';
import type { Db } from '../db/client.js';
import { findPostById, updatePost } from '../db/platform-post-repository.js';
import type { PlatformPost, Video } from '../db/schema.js';
import { findVideoById } from '../db/video-repository.js';
import type { AttemptStep } from '../domain/states.js';
import { buildDescription } from '../content/description.js';
import { describeError, wasAnswered } from '../facebook/errors.js';
import type { GraphClient } from '../facebook/graph-client.js';
import { instagramBlockers } from '../media/instagram-spec.js';
import { normalizeForInstagram, type NormalizeResult } from '../media/normalize.js';
import { finishAttempt, startAttempt } from '../publisher/attempts.js';
import type { Logger } from '../utils/logger.js';
import { toIso } from '../utils/time.js';
import {
  classifyInstagramError,
  igContainerStatus,
  igCreateReelsContainer,
  igMediaPermalink,
  igPublish,
  igRecentMedia,
  igUpload,
} from './ig-api.js';
import { claimPost, releasePost } from './lease.js';

export interface InstagramDeps {
  db: Db;
  client: GraphClient;
  igUserId: string;
  token: string;
  owner: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logger?: Logger;
  maxRetries: number;
  backoffMs?: number[];
  /** Where re-encoded files go (workspace/data/normalized). */
  normalizedDir: string;
  normalize?: (video: Video, outDir: string) => Promise<NormalizeResult>;
  /** How long one prepare waits for Instagram to finish processing before leaving it for the next cycle. */
  processingWaitMs: number;
  pollIntervalMs: number;
}

export type InstagramResult =
  'prepared' | 'processing' | 'published' | 'held' | 'skipped' | 'failed' | 'unknown' | 'requeued';

export interface InstagramOutcome {
  postId: number;
  result: InstagramResult;
  message?: string;
  stop?: 'fatal' | 'pause' | 'rate_limit';
}

const PLATFORM = 'instagram';
const DEFAULT_BACKOFF = [5_000, 15_000, 45_000];

class IgStepFailure extends Error {
  constructor(
    readonly cls: ReturnType<typeof classifyInstagramError>,
    readonly original: unknown,
    readonly step: AttemptStep,
  ) {
    super(describeError(original).message);
  }
}

/**
 * Prepare = make the video ready on Instagram without publishing it: re-encode if needed, create a
 * media container (its id is saved before any bytes are sent), upload, and wait for FINISHED.
 * Nothing is public until publishInstagramPost(), so an interrupted prepare is simply redone.
 */
export async function prepareInstagramPost(deps: InstagramDeps, postId: number): Promise<InstagramOutcome> {
  const { db } = deps;
  if (!claimPost(db, postId, deps.owner, deps.now(), ['READY', 'HELD', 'UPLOADING'])) {
    return { postId, result: 'skipped', message: 'locked by another run or not ready' };
  }
  try {
    const post = mustPost(db, postId);
    const video = findVideoById(db, post.videoId);
    if (!video?.mediaInfo) return fail(deps, post, 'video or its metadata is missing; rescan the folder');
    if (!video.caption?.trim()) return skip(deps, post, 'caption is empty');
    const blockers = instagramBlockers(video.mediaInfo, video.fileSize);
    if (blockers.length) return fail(deps, post, `not possible on Instagram: ${blockers.join('; ')}`);

    // A container from an earlier attempt: reuse it if Instagram still has it, otherwise start over.
    if (post.containerId) {
      const { status } = await step(deps, post, 'RECONCILE', () =>
        igContainerStatus(deps.client, post.containerId as string, deps.token),
      );
      if (status === 'FINISHED') return markUploaded(deps, post);
      if (status === 'IN_PROGRESS') return await waitForProcessing(deps, post.id, post.containerId);
      if (status === 'PUBLISHED') return await reconcilePublished(deps, post);
      updatePost(db, post.id, { containerId: null, containerCreatedAt: null }); // ERROR / EXPIRED / unknown
    }

    const normalized = await (deps.normalize ?? defaultNormalize)(video, deps.normalizedDir);
    const size = (await stat(normalized.path)).size;
    const caption = buildDescription(video.caption, video.hashtags);
    const { containerId } = await step(deps, post, 'START', () =>
      igCreateReelsContainer(deps.client, deps.igUserId, deps.token, { caption }),
    );
    updatePost(db, post.id, {
      containerId,
      containerCreatedAt: toIso(deps.now()),
      uploadPath: normalized.path,
      state: 'UPLOADING',
      lastError: null,
      lastErrorCode: null,
    });
    const data = await readFile(normalized.path);
    await step(
      deps,
      post,
      'TRANSFER',
      () => igUpload(deps.client, containerId, deps.token, data, 0, size),
      `${size} bytes`,
    );
    return await waitForProcessing(deps, post.id, containerId);
  } catch (err) {
    return handleFailure(deps, postId, err);
  } finally {
    releasePost(db, postId, deps.owner);
  }
}

/**
 * Publish an UPLOADED post now. PUBLISHING + publish_sent_at are written before the call; if the
 * response is lost the post stays PUBLISHING and reconcileInstagramPost() decides, never a blind resend.
 */
export async function publishInstagramPost(deps: InstagramDeps, postId: number): Promise<InstagramOutcome> {
  const { db } = deps;
  if (!claimPost(db, postId, deps.owner, deps.now(), ['UPLOADED'])) {
    return { postId, result: 'skipped', message: 'locked by another run or not uploaded yet' };
  }
  try {
    const post = mustPost(db, postId);
    const containerId = post.containerId as string;
    const { status } = await step(deps, post, 'VERIFY', () => igContainerStatus(deps.client, containerId, deps.token));
    if (status === 'EXPIRED' || status === 'ERROR') {
      updatePost(db, post.id, {
        state: 'READY',
        containerId: null,
        containerCreatedAt: null,
        lastError: `container ${status.toLowerCase()}; will re-upload`,
      });
      return { postId, result: 'requeued', message: `container ${status.toLowerCase()}; re-uploading next cycle` };
    }
    if (status === 'PUBLISHED') return await reconcilePublished(deps, post);

    for (let attempt = 0; ; attempt++) {
      updatePost(db, post.id, { state: 'PUBLISHING', publishSentAt: toIso(deps.now()) });
      const attemptId = startAttempt(db, post.videoId, 'FINISH', PLATFORM);
      try {
        const { mediaId } = await igPublish(deps.client, deps.igUserId, deps.token, containerId);
        finishAttempt(db, attemptId, 'ok');
        let permalink: string | undefined;
        try {
          permalink = await igMediaPermalink(deps.client, mediaId, deps.token);
        } catch {
          // the post is live; the link can be fetched later
        }
        updatePost(db, post.id, {
          state: 'PUBLISHED',
          mediaId,
          permalink: permalink ?? null,
          publishedAt: toIso(deps.now()),
          lastError: null,
          lastErrorCode: null,
          retryCount: 0,
        });
        deps.logger?.info({ op: 'instagram-publish', postId, mediaId, permalink }, 'instagram post published');
        return { postId, result: 'published', message: permalink };
      } catch (err) {
        const cls = classifyInstagramError(err);
        finishAttempt(
          db,
          attemptId,
          cls === 'transient' || cls === 'not_ready' ? 'transient' : cls === 'permanent' ? 'permanent' : 'fatal',
          { error: err },
        );
        if (!wasAnswered(err)) {
          const msg = `publish outcome unknown (${describeError(err).message}); it will be checked, never re-sent blindly`;
          updatePost(db, post.id, { lastError: msg, lastErrorCode: null });
          return { postId, result: 'unknown', message: msg };
        }
        // Instagram answered with an error: the post was definitely not published.
        updatePost(db, post.id, { state: 'UPLOADED' });
        if ((cls === 'transient' || cls === 'not_ready') && attempt < deps.maxRetries) {
          await deps.sleep(backoff(deps, attempt));
          continue;
        }
        if (cls === 'not_ready')
          return { postId, result: 'processing', message: 'Instagram is still processing the video' };
        throw new IgStepFailure(cls, err, 'FINISH');
      }
    }
  } catch (err) {
    return handleFailure(deps, postId, err);
  } finally {
    releasePost(db, postId, deps.owner);
  }
}

/** Settles a PUBLISHING post whose publish response was lost. */
export async function reconcileInstagramPost(deps: InstagramDeps, postId: number): Promise<InstagramOutcome> {
  const { db } = deps;
  if (!claimPost(db, postId, deps.owner, deps.now(), ['PUBLISHING', 'UPLOADING'])) {
    return { postId, result: 'skipped', message: 'locked by another run' };
  }
  try {
    const post = mustPost(db, postId);
    if (!post.containerId) {
      updatePost(db, post.id, { state: 'READY' });
      return { postId, result: 'requeued' };
    }
    const containerId = post.containerId;
    const { status } = await step(deps, post, 'RECONCILE', () =>
      igContainerStatus(deps.client, containerId, deps.token),
    );
    if (status === 'PUBLISHED') return await reconcilePublished(deps, post);
    if (status === 'FINISHED') {
      // Publish never landed (or prepare finished meanwhile): safe to publish again later.
      updatePost(db, post.id, { state: 'UPLOADED', lastError: null });
      return { postId, result: 'prepared' };
    }
    if (status === 'IN_PROGRESS') return { postId, result: 'processing' };
    updatePost(db, post.id, {
      state: 'READY',
      containerId: null,
      containerCreatedAt: null,
      lastError: `container ${status.toLowerCase()}; will re-upload`,
    });
    return { postId, result: 'requeued' };
  } catch (err) {
    // Reading the status failed: keep the state, try again next cycle.
    const { code, message } = describeError(err);
    updatePost(db, postId, { lastError: `could not check Instagram status: ${message}`, lastErrorCode: code });
    return { postId, result: 'unknown', message, stop: classifyInstagramError(err) === 'fatal' ? 'fatal' : undefined };
  } finally {
    releasePost(db, postId, deps.owner);
  }
}

// ---------- helpers ----------

async function waitForProcessing(deps: InstagramDeps, postId: number, containerId: string): Promise<InstagramOutcome> {
  const deadline = deps.now().getTime() + deps.processingWaitMs;
  for (;;) {
    const post = mustPost(deps.db, postId);
    const { status, detail } = await step(deps, post, 'VERIFY', () =>
      igContainerStatus(deps.client, containerId, deps.token),
    );
    if (status === 'FINISHED') return markUploaded(deps, post);
    if (status === 'ERROR')
      return fail(deps, post, `Instagram could not process the video${detail ? `: ${detail}` : ''}`);
    if (status === 'EXPIRED') {
      updatePost(deps.db, postId, { state: 'READY', containerId: null, containerCreatedAt: null });
      return { postId, result: 'requeued', message: 'container expired; re-uploading next cycle' };
    }
    if (deps.now().getTime() >= deadline) {
      return { postId, result: 'processing', message: 'uploaded; Instagram is still processing it' };
    }
    await deps.sleep(deps.pollIntervalMs);
  }
}

function markUploaded(deps: InstagramDeps, post: PlatformPost): InstagramOutcome {
  updatePost(deps.db, post.id, { state: 'UPLOADED', lastError: null, lastErrorCode: null, retryCount: 0 });
  return { postId: post.id, result: 'prepared' };
}

/** The container says PUBLISHED: find the media (by caption, after publish_sent_at) and record it. */
async function reconcilePublished(deps: InstagramDeps, post: PlatformPost): Promise<InstagramOutcome> {
  const video = findVideoById(deps.db, post.videoId);
  const caption = buildDescription(video?.caption, video?.hashtags);
  const since = Date.parse(post.publishSentAt ?? post.containerCreatedAt ?? '1970-01-01') - 10 * 60_000;
  let match: { id: string; permalink: string | undefined } | undefined;
  try {
    match = (await igRecentMedia(deps.client, deps.igUserId, deps.token)).find(
      (m) =>
        m.caption?.trim() === caption.trim() &&
        (!m.timestamp || Date.parse(m.timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) >= since),
    );
  } catch {
    // published for sure; ids are a nice-to-have
  }
  updatePost(deps.db, post.id, {
    state: 'PUBLISHED',
    mediaId: match?.id ?? null,
    permalink: match?.permalink ?? null,
    publishedAt: toIso(deps.now()),
    lastError: null,
    lastErrorCode: null,
  });
  return { postId: post.id, result: 'published', message: match?.permalink };
}

async function step<T>(
  deps: InstagramDeps,
  post: PlatformPost,
  name: AttemptStep,
  call: () => Promise<T>,
  note?: string,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const attemptId = startAttempt(deps.db, post.videoId, name, PLATFORM);
    try {
      const value = await call();
      finishAttempt(deps.db, attemptId, 'ok', note ? { message: note } : undefined);
      return value;
    } catch (err) {
      const cls = classifyInstagramError(err);
      finishAttempt(
        deps.db,
        attemptId,
        cls === 'transient' || cls === 'not_ready' ? 'transient' : cls === 'permanent' ? 'permanent' : 'fatal',
        { error: err },
      );
      if ((cls === 'transient' || cls === 'not_ready') && attempt < deps.maxRetries) {
        updatePost(deps.db, post.id, { retryCount: attempt + 1 });
        await deps.sleep(backoff(deps, attempt));
        continue;
      }
      throw new IgStepFailure(cls, err, name);
    }
  }
}

function handleFailure(deps: InstagramDeps, postId: number, err: unknown): InstagramOutcome {
  const failure = err instanceof IgStepFailure ? err : new IgStepFailure(classifyInstagramError(err), err, 'START');
  const { code, message } = describeError(failure.original);
  const where = `${failure.step}: ${message}`;
  const post = findPostById(deps.db, postId);
  switch (failure.cls) {
    case 'fatal':
      updatePost(deps.db, postId, { lastError: where, lastErrorCode: code });
      return { postId, result: 'skipped', message: where, stop: 'fatal' };
    case 'pause':
      // Only Instagram is paused; Facebook publishing is unaffected.
      setAppState(deps.db, 'instagram_paused', 'true');
      setAppState(deps.db, 'instagram_paused_reason', `Instagram error ${code ?? '368'} at ${where}`);
      updatePost(deps.db, postId, { lastError: where, lastErrorCode: code });
      return { postId, result: 'skipped', message: where, stop: 'pause' };
    case 'rate_limit':
      updatePost(deps.db, postId, {
        state: post?.state === 'UPLOADED' || post?.state === 'PUBLISHING' ? 'UPLOADED' : 'HELD',
        nextAttemptAt: toIso(new Date(deps.now().getTime() + 60 * 60 * 1000)),
        lastError: where,
        lastErrorCode: code,
      });
      return { postId, result: 'held', message: where, stop: 'rate_limit' };
    default:
      updatePost(deps.db, postId, { state: 'FAILED', lastError: where, lastErrorCode: code });
      deps.logger?.error(
        { op: 'instagram-publish', postId, step: failure.step, code, error: message },
        'instagram post failed',
      );
      return { postId, result: 'failed', message: where };
  }
}

function fail(deps: InstagramDeps, post: PlatformPost, reason: string): InstagramOutcome {
  updatePost(deps.db, post.id, { state: 'FAILED', lastError: reason, lastErrorCode: 'PRECHECK' });
  return { postId: post.id, result: 'failed', message: reason };
}

function skip(deps: InstagramDeps, post: PlatformPost, reason: string): InstagramOutcome {
  updatePost(deps.db, post.id, { lastError: reason, lastErrorCode: 'PRECHECK' });
  return { postId: post.id, result: 'skipped', message: reason };
}

function mustPost(db: Db, id: number): PlatformPost {
  const p = findPostById(db, id);
  if (!p) throw new Error(`instagram post ${id} not found`);
  return p;
}

function backoff(deps: InstagramDeps, attempt: number): number {
  const list = deps.backoffMs ?? DEFAULT_BACKOFF;
  return list[Math.min(attempt, list.length - 1)] ?? 0;
}

const defaultNormalize = (video: Video, outDir: string): Promise<NormalizeResult> => {
  if (!video.mediaInfo) throw new Error('video has no metadata');
  return normalizeForInstagram(
    { fileHash: video.fileHash, filePath: video.filePath, fileSize: video.fileSize, mediaInfo: video.mediaInfo },
    outDir,
  );
};
