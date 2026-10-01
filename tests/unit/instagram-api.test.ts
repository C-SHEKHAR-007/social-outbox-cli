import { describe, expect, it } from 'vitest';
import { FacebookApiError, GraphClient } from '../../src/facebook/graph-client.js';
import {
  classifyInstagramError,
  igContainerStatus,
  igCreateReelsContainer,
  igLinkedAccount,
  igMediaPermalink,
  igPublish,
  igPublishingLimit,
  igRecentMedia,
  igUpload,
} from '../../src/instagram/ig-api.js';
import { fakeGraph } from '../fixtures/fake-graph.js';

const IG = '17841400000000001';
const TOKEN = 'PAGE-TOKEN';
const client = (g: ReturnType<typeof fakeGraph>) =>
  new GraphClient({ version: 'v26.0', appSecret: 's', fetch: g.fetch });

describe('Instagram API client', () => {
  it('finds the Instagram account linked to the Page', async () => {
    const g = fakeGraph({
      '101': () => ({ body: { instagram_business_account: { id: IG, username: 'my_ig' }, id: '101' } }),
    });
    expect(await igLinkedAccount(client(g), '101', TOKEN)).toEqual({ id: IG, username: 'my_ig' });
    expect(g.requests[0]!.params.fields).toBe('instagram_business_account{id,username}');
    const none = fakeGraph({ '101': () => ({ body: { id: '101' } }) });
    expect(await igLinkedAccount(client(none), '101', TOKEN)).toBeNull();
  });

  it('creates a resumable REELS container with caption and share_to_feed', async () => {
    const g = fakeGraph({ [`${IG}/media`]: () => ({ body: { id: 'C1' } }) });
    expect(await igCreateReelsContainer(client(g), IG, TOKEN, { caption: 'Hook\n\n#a #b' })).toEqual({
      containerId: 'C1',
    });
    expect(g.requests[0]).toMatchObject({
      method: 'POST',
      host: 'graph.facebook.com',
      params: {
        media_type: 'REELS',
        upload_type: 'resumable',
        caption: 'Hook\n\n#a #b',
        share_to_feed: 'true',
        access_token: TOKEN,
      },
    });
  });

  it('uploads bytes to rupload ig-api-upload with OAuth, offset and file_size', async () => {
    const g = fakeGraph({ 'ig-api-upload/C1': () => ({ body: { success: true, message: 'Upload successful.' } }) });
    await igUpload(client(g), 'C1', TOKEN, new Uint8Array(700), 300, 1000);
    expect(g.requests[0]).toMatchObject({
      host: 'rupload.facebook.com',
      path: 'ig-api-upload/C1',
      headers: { authorization: `OAuth ${TOKEN}`, offset: '300', file_size: '1000' },
      bodyBytes: 700,
    });
    const bad = fakeGraph({ 'ig-api-upload/C1': () => ({ body: { success: false, message: 'nope' } }) });
    await expect(igUpload(client(bad), 'C1', TOKEN, new Uint8Array(1), 0, 1)).rejects.toThrow(/not accepted: nope/);
  });

  it('reads container status and maps unknown codes safely', async () => {
    const g = fakeGraph({
      C1: () => ({ body: { status_code: 'FINISHED', status: 'Finished: Media has been uploaded', id: 'C1' } }),
    });
    expect(await igContainerStatus(client(g), 'C1', TOKEN)).toEqual({
      status: 'FINISHED',
      detail: 'Finished: Media has been uploaded',
    });
    const weird = fakeGraph({ C1: () => ({ body: { status_code: 'SOMETHING_NEW' } }) });
    expect((await igContainerStatus(client(weird), 'C1', TOKEN)).status).toBe('UNKNOWN');
  });

  it('publishes, reads permalink, lists recent media and the publishing limit', async () => {
    const g = fakeGraph({
      [`${IG}/media_publish`]: () => ({ body: { id: 'M1' } }),
      M1: () => ({ body: { permalink: 'https://www.instagram.com/reel/abc/' } }),
      [`${IG}/media`]: () => ({
        body: { data: [{ id: 'M1', caption: 'Hook', permalink: 'p', timestamp: '2026-10-04T10:00:00+0000' }] },
      }),
      [`${IG}/content_publishing_limit`]: () => ({
        body: { data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] },
      }),
    });
    const c = client(g);
    expect(await igPublish(c, IG, TOKEN, 'C1')).toEqual({ mediaId: 'M1' });
    expect(g.requests[0]!.params.creation_id).toBe('C1');
    expect(await igMediaPermalink(c, 'M1', TOKEN)).toBe('https://www.instagram.com/reel/abc/');
    expect(await igRecentMedia(c, IG, TOKEN)).toEqual([
      { id: 'M1', caption: 'Hook', permalink: 'p', timestamp: '2026-10-04T10:00:00+0000' },
    ]);
    expect(await igPublishingLimit(c, IG, TOKEN)).toEqual({ used: 3, total: 100 });
  });

  it('classifies "media not ready" (9007) separately; everything else uses the shared rules', () => {
    expect(
      classifyInstagramError(
        new FacebookApiError('Media ID is not available', { code: 9007, subcode: 2207027, httpStatus: 400 }),
      ),
    ).toBe('not_ready');
    expect(classifyInstagramError(new FacebookApiError('blocked', { code: 368, httpStatus: 400 }))).toBe('pause');
    expect(classifyInstagramError(new FacebookApiError('bad token', { code: 190, httpStatus: 400 }))).toBe('fatal');
    expect(classifyInstagramError(new Error('ECONNRESET'))).toBe('transient');
  });
});
