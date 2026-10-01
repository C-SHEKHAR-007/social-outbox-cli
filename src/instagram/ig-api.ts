import { z } from 'zod';
import { classifyError, type ErrorClass } from '../facebook/errors.js';
import { FacebookApiError, type GraphClient } from '../facebook/graph-client.js';

/*
 * Instagram API with Facebook Login (graph.facebook.com, Page access token), Reels via resumable upload:
 *   POST /{ig-user-id}/media (media_type=REELS, upload_type=resumable) → container id
 *   POST rupload.facebook.com/ig-api-upload/{ver}/{container-id} (offset, file_size) → bytes
 *   GET  /{container-id}?fields=status_code → IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED
 *   POST /{ig-user-id}/media_publish (creation_id) → media id
 * Instagram has no native scheduling: publishing happens at the scheduled time (worker).
 */

export const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_content_publish'] as const;

const IdSchema = z.object({ id: z.string().min(1) }).loose();

export async function igLinkedAccount(
  client: GraphClient,
  pageId: string,
  token: string,
): Promise<{ id: string; username: string | undefined } | null> {
  const res = await client.get(
    pageId,
    { fields: 'instagram_business_account{id,username}' },
    z
      .object({ instagram_business_account: z.object({ id: z.string(), username: z.string().optional() }).optional() })
      .loose(),
    { token },
  );
  const acct = res.instagram_business_account;
  return acct ? { id: acct.id, username: acct.username } : null;
}

export async function igCreateReelsContainer(
  client: GraphClient,
  igUserId: string,
  token: string,
  args: { caption: string; shareToFeed?: boolean },
): Promise<{ containerId: string }> {
  const res = await client.post(
    `${igUserId}/media`,
    {
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: args.caption,
      share_to_feed: args.shareToFeed === false ? 'false' : 'true',
    },
    IdSchema,
    { token },
  );
  return { containerId: res.id };
}

export async function igUpload(
  client: GraphClient,
  containerId: string,
  token: string,
  data: Uint8Array,
  offset: number,
  fileSize: number,
): Promise<void> {
  const res = await client.uploadInstagramBinary(
    containerId,
    token,
    data,
    offset,
    fileSize,
    z.object({ success: z.boolean().optional(), message: z.string().optional() }).loose(),
  );
  if (res.success === false) throw new Error(`Instagram upload was not accepted: ${res.message ?? 'success=false'}`);
}

export const CONTAINER_STATUSES = ['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number] | 'UNKNOWN';

export async function igContainerStatus(
  client: GraphClient,
  containerId: string,
  token: string,
): Promise<{ status: ContainerStatus; detail: string | undefined }> {
  const res = await client.get(
    containerId,
    { fields: 'status_code,status' },
    z.object({ status_code: z.string().optional(), status: z.string().optional() }).loose(),
    { token },
  );
  const code = (res.status_code ?? '').toUpperCase();
  const status = (CONTAINER_STATUSES as readonly string[]).includes(code) ? (code as ContainerStatus) : 'UNKNOWN';
  return { status, detail: res.status };
}

export async function igPublish(
  client: GraphClient,
  igUserId: string,
  token: string,
  containerId: string,
): Promise<{ mediaId: string }> {
  const res = await client.post(`${igUserId}/media_publish`, { creation_id: containerId }, IdSchema, { token });
  return { mediaId: res.id };
}

export async function igMediaPermalink(
  client: GraphClient,
  mediaId: string,
  token: string,
): Promise<string | undefined> {
  const res = await client.get(
    mediaId,
    { fields: 'permalink' },
    z.object({ permalink: z.string().optional() }).loose(),
    { token },
  );
  return res.permalink;
}

export interface IgMediaSummary {
  id: string;
  caption: string | undefined;
  permalink: string | undefined;
  timestamp: string | undefined;
}

/** Most recent media of the account (used to find a post whose publish response was lost). */
export async function igRecentMedia(
  client: GraphClient,
  igUserId: string,
  token: string,
  limit = 25,
): Promise<IgMediaSummary[]> {
  const res = await client.get(
    `${igUserId}/media`,
    { fields: 'id,caption,permalink,timestamp', limit: String(limit) },
    z
      .object({
        data: z.array(
          z
            .object({
              id: z.string(),
              caption: z.string().optional(),
              permalink: z.string().optional(),
              timestamp: z.string().optional(),
            })
            .loose(),
        ),
      })
      .loose(),
    { token },
  );
  return res.data.map((m) => ({ id: m.id, caption: m.caption, permalink: m.permalink, timestamp: m.timestamp }));
}

const lenientNumber = z.unknown().transform((v): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
});

/** Instagram's own 24h publishing quota (100 posts per rolling 24h). */
export async function igPublishingLimit(
  client: GraphClient,
  igUserId: string,
  token: string,
): Promise<{ used: number | undefined; total: number | undefined }> {
  const res = await client.get(
    `${igUserId}/content_publishing_limit`,
    { fields: 'quota_usage,config' },
    z
      .object({
        data: z
          .array(
            z
              .object({
                quota_usage: lenientNumber.optional(),
                config: z.object({ quota_total: lenientNumber.optional() }).loose().optional(),
              })
              .loose(),
          )
          .default([]),
      })
      .loose(),
    { token },
  );
  const first = res.data[0];
  return { used: first?.quota_usage, total: first?.config?.quota_total };
}

/**
 * Instagram-specific error handling on top of the shared rules (which Facebook keeps using unchanged):
 * 9007 / "media not ready" means the container is still processing → wait and retry.
 */
export function classifyInstagramError(err: unknown): ErrorClass | 'not_ready' {
  if (err instanceof FacebookApiError && err.details.code === 9007) return 'not_ready';
  return classifyError(err);
}
