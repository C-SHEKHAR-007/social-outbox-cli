# Instagram Graph API: how reel-cli publishes Reels

Reference for the Instagram support (Phase 10). Facebook is documented in [`facebook-api.md`](facebook-api.md). Facts below were checked against Meta's documentation on 2026-10-04; the live test checklist at the end is still to be done.

## Setup used: Instagram API with Facebook Login

reel-cli uses the **Facebook Login** variant (host `graph.facebook.com`, the **Page access token** you already have), not the separate "Instagram Login" variant. Requirements:

- An Instagram **Professional** account (Business or Creator) **linked to the Facebook Page**.
- Permissions on the Page token: `instagram_basic`, `instagram_content_publish` (plus the Facebook ones: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`).
- The Meta app must be allowed to request those permissions (Instagram use case / permissions in the app dashboard). If it isn't, the login dialog shows **"Invalid Scopes: instagram_basic, instagram_content_publish"**.
- Development mode with you as app admin should be enough for your own account, as it was for Facebook.

`reel-cli instagram connect` checks the stored Page token with `debug_token`; if the Instagram permissions are missing it runs the browser login again asking for the Facebook **and** Instagram permissions, then reads the linked account:

```
GET /{page-id}?fields=instagram_business_account{id,username}
```

## Publishing a Reel

| Step                | Request                                                                                                                                               | Notes                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1. Create container | `POST /{ig-user-id}/media` `media_type=REELS`, `upload_type=resumable`, `caption`, `share_to_feed=true`                                               | returns the container id; reel-cli saves it **before** uploading         |
| 2. Upload           | `POST https://rupload.facebook.com/ig-api-upload/{ver}/{container-id}` headers `Authorization: OAuth {token}`, `offset`, `file_size`; body = the file | local files, no public hosting needed (`file_url` header also supported) |
| 3. Wait             | `GET /{container-id}?fields=status_code,status`                                                                                                       | `IN_PROGRESS` → `FINISHED` (or `ERROR`, `EXPIRED`, `PUBLISHED`)          |
| 4. Publish          | `POST /{ig-user-id}/media_publish` `creation_id={container-id}`                                                                                       | returns the media id; error **9007** = media not ready yet               |
| 5. Link             | `GET /{media-id}?fields=permalink`                                                                                                                    | saved as the post's link                                                 |
| Lost reply          | `GET /{container-id}?fields=status_code` → `PUBLISHED`, then `GET /{ig-user-id}/media?fields=id,caption,permalink,timestamp`                          | reel-cli finds the post by caption instead of publishing again           |
| Quota               | `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config`                                                                                | shown by `reel-cli instagram status`                                     |

- **Containers expire after 24 hours**, so reel-cli prepares a post only `INSTAGRAM_PREPARE_HOURS` (default 3) before its time and re-uploads if a container expired.
- **No native scheduling:** a post is published by `reel-cli worker` at (or shortly after) its time.
- **Limit:** 100 API-published posts per rolling 24 h per account (a carousel counts as 1). reel-cli defaults to 25 (`INSTAGRAM_DAILY_LIMIT`) with the same gap between posts as Facebook (`MIN_UPLOAD_GAP_SECONDS`).

## Reel requirements

| Property   | Requirement                                               | reel-cli                                        |
| ---------- | --------------------------------------------------------- | ----------------------------------------------- |
| Container  | MP4 or MOV, moov atom at the front, no edit lists         | re-encoded with `-movflags +faststart`          |
| Video      | H.264 or HEVC, progressive, closed GOP, 4:2:0             | AV1/VP9 sources are re-encoded to H.264 High    |
| Frame rate | 23–60 fps                                                 | clamped (below 23 → 24, above 60 → 30)          |
| Size       | width ≤ 1920 px; aspect 0.01:1 to 10:1 (9:16 recommended) | scaled down if wider                            |
| Audio      | AAC, ≤ 48 kHz, mono/stereo, 128 kbps                      | re-encoded to AAC 48 kHz stereo 128 kbps        |
| Bitrate    | ≤ 25 Mbps                                                 | capped so the file stays under 300 MB           |
| Duration   | 3 s – 15 min                                              | longer/shorter videos are refused (not fixable) |
| File size  | ≤ 300 MB                                                  | bitrate cap                                     |
| Caption    | ≤ 2200 characters, ≤ 30 hashtags, ≤ 20 @mentions          | caption + hashtags, same as Facebook            |

Re-encoded copies are cached in `workspace/data/normalized/{hash}.instagram.mp4`; the original files (and Facebook uploads) are never changed. Measured: a 90 s 1080×1920 AV1 clip re-encodes in about 22 s.

## Error handling

| Error                                | Instagram behaviour in reel-cli                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Network error / timeout on publish   | outcome unknown → post stays `PUBLISHING` and is checked next cycle, never re-sent blindly |
| 9007 "media not ready"               | wait and retry (post stays `UPLOADED`)                                                     |
| 1, 2, 5xx, `is_transient`            | retry with backoff (`MAX_RETRIES`)                                                         |
| 4, 17, 32, 613 rate limits           | post held for an hour                                                                      |
| 190, 10, 200–299                     | token/permission problem: the run stops, nothing changes                                   |
| 368 (incl. 1390008 "going too fast") | **Instagram only** is paused (`reel-cli instagram resume`); Facebook keeps working         |
| other (e.g. 100)                     | that post fails (`reel-cli instagram retry`)                                               |

## First live test (to do)

1. `reel-cli instagram connect` → expect `✓ Instagram connected: @your_account`.
2. `reel-cli instagram status` → account, 0 posts, Instagram's quota `0/100`.
3. Pick one short video: in the CSV set `ig_action` = `POST_NOW` on that row (or `SCHEDULE` 30 minutes ahead), import.
4. `reel-cli instagram publish --dry-run` → `Prepare now: 1`.
5. `reel-cli instagram publish` (prepares), then again (publishes), or `reel-cli worker --once` twice.
6. `reel-cli show <id>` → attempts `instagram:START/TRANSFER/VERIFY/FINISH` and the Instagram link.
7. Record anything Meta's docs got wrong (field shapes, timings) here, like the `publish_time` surprise on the Facebook side.
