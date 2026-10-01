import { fakeGraph, graphError } from './fake-graph.js';

/**
 * Stateful fake of the Instagram content-publishing API (Facebook Login variant): containers,
 * resumable uploads, processing, media_publish and the account's media list.
 */
export const IG_ID = '17841400000000001';

type Injected = { status?: number; body: unknown } | 'network-error';

interface Container {
  caption: string;
  bytes: number;
  fileSize: number;
  processingPolls: number;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
  mediaId?: string;
}

export function fakeInstagram(opts: { processingPolls?: number } = {}) {
  const containers = new Map<string, Container>();
  const media: Array<{ id: string; caption: string; permalink: string; timestamp: string }> = [];
  let seq = 0;
  const fail: Record<'create' | 'upload' | 'status' | 'publish', Injected[]> = {
    create: [],
    upload: [],
    status: [],
    publish: [],
  };
  const flags = { publishAppliedButNetworkDrop: false };
  const take = (k: keyof typeof fail) => fail[k].shift();

  const graph = fakeGraph({
    [`${IG_ID}/media`]: (p, req) => {
      if (req.method === 'GET') return { body: { data: [...media].reverse() } };
      const inj = take('create');
      if (inj) return inj;
      if (p.media_type !== 'REELS' || p.upload_type !== 'resumable')
        return graphError(100, 'expected a resumable REELS container');
      const id = `C${++seq}`;
      containers.set(id, {
        caption: p.caption ?? '',
        bytes: 0,
        fileSize: 0,
        processingPolls: opts.processingPolls ?? 1,
        status: 'IN_PROGRESS',
      });
      return { body: { id } };
    },
    [`${IG_ID}/media_publish`]: (p) => {
      const inj = take('publish');
      if (inj) return inj;
      const c = containers.get(p.creation_id ?? '');
      if (!c) return graphError(100, 'Unknown container');
      if (c.status !== 'FINISHED')
        return graphError(9007, 'Media ID is not available', 400, { error_subcode: 2207027 });
      const mediaId = `M${++seq}`;
      c.status = 'PUBLISHED';
      c.mediaId = mediaId;
      media.push({
        id: mediaId,
        caption: c.caption,
        permalink: `https://www.instagram.com/reel/${mediaId}/`,
        timestamp: '2099-01-01T00:00:00+0000',
      });
      if (flags.publishAppliedButNetworkDrop) {
        flags.publishAppliedButNetworkDrop = false;
        return 'network-error';
      }
      return { body: { id: mediaId } };
    },
    [`${IG_ID}/content_publishing_limit`]: () => ({
      body: { data: [{ quota_usage: media.length, config: { quota_total: 100 } }] },
    }),
    '*': (_p, req) => {
      if (req.path.startsWith('ig-api-upload/')) {
        const inj = take('upload');
        if (inj) return inj;
        const c = containers.get(req.path.slice('ig-api-upload/'.length));
        if (!c) return graphError(100, 'Unknown container');
        c.fileSize = Number(req.headers.file_size);
        c.bytes += req.bodyBytes ?? 0;
        return { body: { success: true, message: 'Upload successful.' } };
      }
      const m = media.find((x) => x.id === req.path);
      if (m) return { body: { id: m.id, permalink: m.permalink } };
      const inj = take('status');
      if (inj) return inj;
      const c = containers.get(req.path);
      if (!c) return graphError(100, `Unsupported get request. Object with ID '${req.path}' does not exist`);
      if (c.status === 'IN_PROGRESS' && c.fileSize > 0 && c.bytes >= c.fileSize) {
        if (c.processingPolls > 0) c.processingPolls -= 1;
        else c.status = 'FINISHED';
      }
      return { body: { id: req.path, status_code: c.status, status: `${c.status}: fake` } };
    },
  });
  const count = (pred: (r: (typeof graph.requests)[number]) => boolean) => graph.requests.filter(pred).length;
  return {
    fetch: graph.fetch,
    requests: graph.requests,
    containers,
    media,
    fail,
    flags,
    creates: () => count((r) => r.method === 'POST' && r.path === `${IG_ID}/media`),
    publishes: () => count((r) => r.path === `${IG_ID}/media_publish`),
  };
}
