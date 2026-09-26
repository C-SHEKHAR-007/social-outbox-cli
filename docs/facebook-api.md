# Facebook Graph API — Phase 0 test and findings

Goal: prove the Meta app, token and permissions work, and answer the open questions in `docs/plan.md` §2.7 **before** writing any publishing code. Everything here uses `curl`; nothing depends on the project code.

> Use a **test Page** if you have one. DRAFT uploads are not public, but the SCHEDULED test below will go live unless you delete it.

## 1. Create the Meta app (one time)

1. <https://developers.facebook.com/apps> → **Create app**.
2. Choose the use case for managing a Page / publishing Page content (Meta renames these often; if nothing fits, pick **Other → Business**).
3. Add the **Facebook Login** product. Nothing to configure for the redirect: Meta allows `http://localhost` redirects automatically **while the app is in Development mode** (reel-cli uses `http://localhost:8585/callback`; change the port with `FACEBOOK_OAUTH_PORT` if 8585 is taken).
4. Keep the app in **Development** mode. This matters twice: localhost redirects only work in Development mode, and as the app's admin you can use it on your own Page without App Review (open question Q2). If the app is ever switched to Live, `facebook login` stops working (Live apps need an HTTPS redirect registered under _Valid OAuth Redirect URIs_); an existing stored Page token keeps working.
5. Put the **App ID** and **App Secret** (App settings → Basic) in `.env`:
   ```
   FACEBOOK_APP_ID=...
   FACEBOOK_APP_SECRET=...
   ```

## 2. Log in (browser)

```bash
reel-cli facebook login     # opens your browser; approve the 3 permissions; pick your Page
reel-cli facebook verify    # confirms: PAGE token, never expires, required permissions present
```

What happens: the browser shows Facebook's own login/consent screen, then Facebook redirects to `http://localhost:8585/callback` with a one-time code. reel-cli checks the CSRF `state`, exchanges the code for a user token, upgrades it to a long-lived token (about 60 days), and fetches the **Page token (no expiry)** from `/me/accounts`. Tokens are stored in the **OS keychain** (service `reel-cli`), falling back to a `0600` file `data/credentials.json` only if no keychain is available. They are never written to `.env`, CSV, the database or logs.

Other commands: `reel-cli facebook pages` (list / `--select <id>` to switch Page), `reel-cli facebook logout` (remove tokens). Headless machine: `reel-cli facebook login --no-browser` prints the URL to open elsewhere (the redirect still has to reach this machine's localhost).

> Posting with browser **session cookies** (`c_user`/`xs`) or scraping facebook.com is deliberately **not** supported: it violates Meta's terms and gets Pages and accounts restricted.

### Token for the curl tests below

The curl commands need the Page token in your shell. The simplest way is Graph API Explorer: <https://developers.facebook.com/tools/explorer> → select your app → **Get User Access Token** with `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` → in **User or Page**, pick your Page.

Load it into your shell **without** saving it in shell history:

```bash
read -rs PAGE_TOKEN   # paste the token, press Enter
export PAGE_TOKEN
export V=v26.0
export PAGE_ID=<your numeric page id>
export VIDEO=videos/phase0-test.mp4   # compliant 6 s 1080x1920 test clip made by the setup
G=https://graph.facebook.com/$V
```

Check the token works:

```bash
curl -s "$G/me?fields=id,name&access_token=$PAGE_TOKEN"
# expect {"name":"<Page name>","id":"<PAGE_ID>"}
```

## 3. Test A — DRAFT (safe, not public)

```bash
# START
curl -s -X POST "$G/$PAGE_ID/video_reels" -F upload_phase=start -F access_token=$PAGE_TOKEN
# → {"video_id":"...","upload_url":"https://rupload.facebook.com/video-upload/..."}
export VIDEO_ID=<video_id from above>

# TRANSFER
curl -s -X POST "https://rupload.facebook.com/video-upload/$V/$VIDEO_ID" \
  -H "Authorization: OAuth $PAGE_TOKEN" \
  -H "offset: 0" \
  -H "file_size: $(stat -c%s "$VIDEO")" \
  --data-binary @"$VIDEO"
# → {"success":true}

# STATUS (after upload)
curl -s "$G/$VIDEO_ID?fields=status&access_token=$PAGE_TOKEN"

# FINISH as DRAFT
curl -s -X POST "$G/$PAGE_ID/video_reels" \
  -F upload_phase=finish -F video_id=$VIDEO_ID -F video_state=DRAFT \
  -F description="Phase 0 test #test" -F access_token=$PAGE_TOKEN
# Q3: does this response include post_id?

# STATUS again (repeat until processing finishes)
curl -s "$G/$VIDEO_ID?fields=status,post_id,permalink_url&access_token=$PAGE_TOKEN"
```

## 4. Test B — SCHEDULED (then delete)

Repeat START and TRANSFER with a new `VIDEO_ID`, then:

```bash
curl -s -X POST "$G/$PAGE_ID/video_reels" \
  -F upload_phase=finish -F video_id=$VIDEO_ID -F video_state=SCHEDULED \
  -F scheduled_publish_time=$(date -d '+30 min' +%s) \
  -F description="Phase 0 scheduled test" -F access_token=$PAGE_TOKEN

curl -s "$G/$VIDEO_ID?fields=status,post_id,permalink_url&access_token=$PAGE_TOKEN"
# expect publishing_phase.publish_status = "scheduled"

# Q4: can a scheduled Reel be cancelled?
curl -s -X DELETE "$G/$VIDEO_ID?access_token=$PAGE_TOKEN"
```

Also try a time **less than 10 minutes** ahead (`+5 min`) and one **more than 29 days** ahead (`+30 days`), and note the exact error responses.

## 4b. Test C: long video (> 90 s) as DRAFT (most important for this project)

The Facebook **app** accepts long Reels (no length limit since June 2025), but the **API docs** still say 3–90 s. 556 of the 737 videos in `YOutube Videos/2` are longer than 90 s, so this test decides whether they need splitting.

Use one of the ~7-minute videos (the same kind you already posted from the app), and repeat START → TRANSFER → FINISH with `video_state=DRAFT`:

```bash
export VIDEO="/home/shekhar/Desktop/YOutube Videos/2/Video_001.mp4"   # 435 s
# START, TRANSFER (same commands as Test A), then:
curl -s -X POST "$G/$PAGE_ID/video_reels" \
  -F upload_phase=finish -F video_id=$VIDEO_ID -F video_state=DRAFT \
  -F description="Phase 0 long test" -F access_token=$PAGE_TOKEN

# poll until processing finishes; look for an error like "duration isn't supported"
curl -s "$G/$VIDEO_ID?fields=status&access_token=$PAGE_TOKEN"
```

Record where it fails, if it does: at FINISH (HTTP error) or later in `status.processing_phase` / `publishing_phase`. If it is rejected, also try the same file through the regular Page video endpoint to see whether Facebook turns it into a Reel:

```bash
curl -s -X POST "https://graph-video.facebook.com/$V/$PAGE_ID/videos" \
  -F source=@"$VIDEO" -F published=false -F description="Phase 0 long test (videos endpoint)" \
  -F access_token=$PAGE_TOKEN
```

## 5. What to send back

Paste the JSON responses to Claude (**remove the token** if it appears anywhere; the IDs are fine). They become:

- test fixtures in `tests/fixtures/graph/`
- the answers in the table below.

## 6. Findings

| #   | Question                                                                   | Answer                                                                                                                                     | Evidence                                         |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Q1  | Does SCHEDULED count against 30/24h at creation or at go-live?             | _TBD (assume creation)_                                                                                                                    |                                                  |
| Q2  | Can a Development-mode app with admin post to own Page without App Review? | **Yes.** App "Reel Publisher" in Development mode, use case _Manage everything on your Page_, permissions added (not submitted for review) | Draft Reel + 2 scheduled Page videos, 2026-09-27 |
| Q3  | Does FINISH return `post_id`?                                              | **Yes** for Reels (`{success:true, post_id:"…"}`)                                                                                          | Video_711 draft, post id 122104900455484727      |
| Q4  | Can a scheduled Reel be deleted/rescheduled?                               | _TBD_                                                                                                                                      |                                                  |
| Q5  | Max `description` length / hashtag count                                   | _TBD_                                                                                                                                      |                                                  |
| Q6  | How does a copyright block appear in `status`?                             | _TBD_                                                                                                                                      |                                                  |
| Q7  | Does `video_reels` accept videos > 90 s (e.g. 7 min)?                      | _TBD. Long videos go out as Page videos either way; a yes lets us raise `REEL_MAX_DURATION_S`_                                             |                                                  |
| Q8  | Page video (`/videos`) rate limits; do they appear in the Reels tab?       | Page videos get a **`/reel/…` permalink** and report `publishing_phase.publish_status` like Reels. Rate limit still unknown                | Video_116 / Video_117, 2026-09-27                |

### Observed live responses (2026-09-27)

- **Status phases:** `publishing_phase.publish_time` is an **ISO string** (`"2026-09-26T21:30:00+0000"`), not a Unix number. Earlier builds rejected it and wrongly marked a scheduled video FAILED (fixed in `fix(publisher): parse ISO publish_time…`).
- A scheduled Page video returns `published: false`, `publishing_phase: { status: "complete", publish_status: "scheduled" }` and a `/reel/{id}/` permalink.
- A 22 s, 4.7 MB VP9/HE-AAC Reel uploaded in about 2 s and finished processing about 24 s after FINISH. A 26.7 MB Page video was sent in 1 MB chunks (Facebook's choice) in about 45 s.

## 7. Endpoints used by reel-cli

| Purpose                     | Request                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Verify token                | `GET /me?fields=id,name`                                                                                                           |
| Start upload                | `POST /{page-id}/video_reels` `upload_phase=start`                                                                                 |
| Transfer                    | `POST rupload.facebook.com/video-upload/{ver}/{video-id}` (headers `Authorization: OAuth`, `offset`, `file_size`)                  |
| Finish / publish / schedule | `POST /{page-id}/video_reels` `upload_phase=finish, video_id, video_state, description, scheduled_publish_time?, is_ai_generated?` |
| Status                      | `GET /{video-id}?fields=status,post_id,permalink_url`                                                                              |
| List Page reels (reconcile) | `GET /{page-id}/video_reels`                                                                                                       |

| **Page video** (longer than the Reel limit): start | `POST graph-video.facebook.com/{ver}/{page-id}/videos` `upload_phase=start, file_size` → `upload_session_id, video_id, start_offset, end_offset` |
| Page video: transfer | same endpoint, `upload_phase=transfer, upload_session_id, start_offset, video_file_chunk` (repeat until offsets are equal) |
| Page video: finish / schedule | same endpoint, `upload_phase=finish, upload_session_id, title, description, published, scheduled_publish_time` (10 min to 6 months ahead) |

Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
