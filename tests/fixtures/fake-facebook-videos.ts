import { fakeGraph, graphError } from './fake-graph.js';

/**
 * Stateful fake of Meta's Reel and Page video upload flows. Tracks bytes, finish calls and
 * processing so tests can simulate crashes, network drops and slow processing.
 */
export const PAGE_ID = '101';

type Injected = { status?: number; body: unknown } | 'network-error';

interface FakeVideo {
  kind: 'reel' | 'video';
  bytes: number;
  fileSize: number;
  finished: boolean;
  /** Requested outcome at finish. */
  wants: 'published' | 'scheduled' | 'draft';
  /** Remaining status polls that still report processing. */
  processingPolls: number;
}

export function fakeFacebookVideos(
  opts: { chunkSize?: number; processingPolls?: number; processingError?: string } = {},
) {
  const chunk = opts.chunkSize ?? 400;
  const videos = new Map<string, FakeVideo>();
  let seq = 0;
  /** Queue failures per step: fail.reelStart.push(graphError(190, 'bad')) */
  const fail: Record<
    'reelStart' | 'rupload' | 'reelFinish' | 'videoStart' | 'videoTransfer' | 'videoFinish' | 'status',
    Injected[]
  > = {
    reelStart: [],
    rupload: [],
    reelFinish: [],
    videoStart: [],
    videoTransfer: [],
    videoFinish: [],
    status: [],
  };
  /** Makes the next finish apply on Facebook but lose the response (outcome unknown for the client). */
  const flags = { finishAppliedButNetworkDrop: false };
  const injected = (k: keyof typeof fail) => fail[k].shift();

  const graph = fakeGraph({
    [`${PAGE_ID}/video_reels`]: (p) => {
      if (p.upload_phase === 'start') {
        const inj = injected('reelStart');
        if (inj) return inj;
        const id = `R${++seq}`;
        videos.set(id, {
          kind: 'reel',
          bytes: 0,
          fileSize: 0,
          finished: false,
          wants: 'published',
          processingPolls: opts.processingPolls ?? 0,
        });
        return { body: { video_id: id, upload_url: `https://rupload.facebook.com/video-upload/v26.0/${id}` } };
      }
      const inj = injected('reelFinish');
      if (inj) return inj;
      const v = videos.get(p.video_id ?? '');
      if (!v) return graphError(100, 'Unknown video');
      if (v.bytes < v.fileSize) return graphError(100, 'Upload not complete');
      v.finished = true;
      v.wants = p.video_state === 'SCHEDULED' ? 'scheduled' : p.video_state === 'DRAFT' ? 'draft' : 'published';
      if (flags.finishAppliedButNetworkDrop) {
        flags.finishAppliedButNetworkDrop = false;
        return 'network-error';
      }
      return { body: { success: true, post_id: `${PAGE_ID}_${p.video_id}` } };
    },
    [`${PAGE_ID}/videos`]: (p) => {
      if (p.upload_phase === 'start') {
        const inj = injected('videoStart');
        if (inj) return inj;
        const id = `V${++seq}`;
        const size = Number(p.file_size);
        videos.set(id, {
          kind: 'video',
          bytes: 0,
          fileSize: size,
          finished: false,
          wants: 'published',
          processingPolls: opts.processingPolls ?? 0,
        });
        return {
          body: {
            upload_session_id: `S-${id}`,
            video_id: id,
            start_offset: '0',
            end_offset: String(Math.min(chunk, size)),
          },
        };
      }
      const id = (p.upload_session_id ?? '').replace(/^S-/, '');
      const v = videos.get(id);
      if (!v) return graphError(100, 'Unknown upload session');
      if (p.upload_phase === 'transfer') {
        const inj = injected('videoTransfer');
        if (inj) return inj;
        const size = Number(/<blob:(\d+)>/.exec(p.video_file_chunk ?? '')?.[1] ?? 0);
        if (Number(p.start_offset) !== v.bytes)
          return graphError(100, `Wrong start_offset ${p.start_offset}, expected ${v.bytes}`);
        v.bytes += size;
        return { body: { start_offset: String(v.bytes), end_offset: String(Math.min(v.bytes + chunk, v.fileSize)) } };
      }
      const inj = injected('videoFinish');
      if (inj) return inj;
      if (v.bytes < v.fileSize) return graphError(100, 'Upload not complete');
      v.finished = true;
      v.wants = p.published === 'true' ? 'published' : p.unpublished_content_type === 'DRAFT' ? 'draft' : 'scheduled';
      return { body: { success: true } };
    },
    '*': (_p, req) => {
      if (req.path.startsWith('video-upload/')) {
        const inj = injected('rupload');
        if (inj) return inj;
        const v = videos.get(req.path.slice('video-upload/'.length));
        if (!v) return graphError(100, 'Unknown video');
        v.fileSize = Number(req.headers.file_size);
        if (Number(req.headers.offset) !== v.bytes)
          return graphError(100, `Bad offset ${req.headers.offset}, expected ${v.bytes}`);
        v.bytes += req.bodyBytes ?? 0;
        return { body: { success: true } };
      }
      // GET /{video-id}?fields=status,...
      const inj = injected('status');
      if (inj) return inj;
      const v = videos.get(req.path);
      if (!v) return graphError(100, `Unsupported get request. Object with ID '${req.path}' does not exist`);
      return { body: statusOf(req.path, v) };
    },
  });

  function statusOf(id: string, v: FakeVideo) {
    const uploadDone = v.fileSize > 0 && v.bytes >= v.fileSize;
    if (!v.finished) {
      return {
        id,
        status: {
          video_status: uploadDone ? 'upload_complete' : 'uploading',
          uploading_phase: { status: uploadDone ? 'complete' : 'in_progress', bytes_transferred: v.bytes },
          processing_phase: { status: 'not_started' },
          publishing_phase: { status: 'not_started' },
        },
      };
    }
    if (v.processingPolls > 0) {
      v.processingPolls -= 1;
      return {
        id,
        status: {
          video_status: 'processing',
          uploading_phase: { status: 'complete' },
          processing_phase: { status: 'in_progress' },
        },
      };
    }
    if (opts.processingError) {
      return {
        id,
        status: {
          video_status: 'error',
          processing_phase: { status: 'error', errors: [{ code: 1363, message: opts.processingError }] },
        },
      };
    }
    return {
      id,
      permalink_url: `/${v.kind === 'reel' ? 'reel' : 'videos'}/${id}`,
      ...(v.kind === 'video' ? { published: v.wants === 'published' } : {}),
      status: {
        video_status: 'ready',
        uploading_phase: { status: 'complete', bytes_transferred: v.bytes },
        processing_phase: { status: 'complete' },
        // Real Facebook (verified 2026-09-27): Page videos also report publish_status, and publish_time is an ISO string.
        publishing_phase: { status: 'complete', publish_status: v.wants, publish_time: '2026-09-26T21:30:00+0000' },
      },
    };
  }

  const count = (pred: (r: (typeof graph.requests)[number]) => boolean) => graph.requests.filter(pred).length;
  return {
    fetch: graph.fetch,
    requests: graph.requests,
    videos,
    fail,
    flags,
    starts: () => count((r) => r.params.upload_phase === 'start'),
    finishes: () => count((r) => r.params.upload_phase === 'finish'),
  };
}
