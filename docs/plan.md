# Facebook Reel Automation Tool — Plan (v2)

Supersedes `docs/archive/plan-raw.md`. The goals are the same; this version updates the plan with verified Meta API behaviour (Graph API v25/v26, checked 2026-09-26), closes the idempotency gaps, and adds the commands needed to handle 100+ videos without editing every row by hand.

---

## 1. Goal

A local-first TypeScript CLI (`reel-cli`) that:

1. Scans a local folder of ready-to-post videos and tracks each one exactly once.
2. Generates captions and hashtags with a local LLM (Ollama), using the transcript and a Page profile.
3. Lets the user review and edit everything through a CSV file.
4. Publishes to a Facebook Page through the official Graph API, either immediately or scheduled: videos up to 90 s as **Reels**, and longer videos as regular **Page videos** (decision made 2026-09-26; see §2.8).
5. Never publishes the same video twice, including after crashes, retries or reruns.
6. Keeps a full history of every video and every publish attempt.

**Non-goals for v1:** web UI, browser automation, personal-profile posting, Instagram, analytics.

---

## 2. Verified Meta API facts

Source: [Reels Publishing API](https://developers.facebook.com/docs/video-api/guides/reels-publishing), [Page Video Reels reference v26.0](https://developers.facebook.com/docs/graph-api/reference/page/video_reels/).

### 2.1 Publish flow (3 steps)

```
1. START     POST https://graph.facebook.com/{ver}/{page-id}/video_reels
             upload_phase=start
             → { video_id, upload_url }

2. TRANSFER  POST https://rupload.facebook.com/video-upload/{ver}/{video-id}
             Authorization: OAuth {page-token}
             offset: <bytes already sent>     file_size: <total bytes>
             body: binary video
             (resumable: on failure, read status and resume from bytes_transferred)

3. FINISH    POST https://graph.facebook.com/{ver}/{page-id}/video_reels
             upload_phase=finish, video_id, video_state=PUBLISHED|SCHEDULED|DRAFT,
             description, [title], [scheduled_publish_time], [is_ai_generated]
             → { success, post_id? }

4. VERIFY    GET https://graph.facebook.com/{ver}/{video-id}?fields=status
             status.video_status: uploading | upload_complete | processing | ready | error | upload_failed | expired
             status.uploading_phase / processing_phase / publishing_phase
             publishing_phase.publish_status: draft | scheduled | published | error
```

A successful FINISH does **not** mean the Reel is live. Processing and the copyright check run afterwards, so the tool must poll step 4 before recording `PUBLISHED`.

### 2.2 Scheduling: supported natively

- `video_state=SCHEDULED` plus `scheduled_publish_time` (Unix seconds).
- The time must be **more than 10 minutes from now** and **no more than 29 days ahead**.
- Result: Meta schedules anything inside the window. The local worker only holds items scheduled beyond 29 days and submits them once they're inside the window. The machine does not need to be on at publish time.

### 2.3 Limits

- **30 API-published Reels per Page per rolling 24 hours.** The tool must track its own quota and never exceed it.
- Posting to Pages only; personal profiles are not supported.

### 2.4 Video requirements (enforced by `validate`)

| Property     | Requirement                                                           |
| ------------ | --------------------------------------------------------------------- |
| Container    | mp4 recommended (mov/webm/m4v accepted locally, may need `normalize`) |
| Aspect ratio | 9:16 (±1% tolerance)                                                  |
| Resolution   | ≥ 540×960; 1080×1920 recommended                                      |
| Duration     | 3–90 seconds                                                          |
| Frame rate   | 24–60 fps, constant                                                   |
| Video codec  | H.264 or H.265 (VP9/AV1 accepted)                                     |
| Chroma       | 4:2:0, progressive scan                                               |
| GOP          | Closed, 2–5 s (warning only, since it's hard to verify precisely)     |
| Audio        | AAC-LC, 48 kHz, stereo, ≥ 128 kbps                                    |

### 2.5 Permissions and tokens

- Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
- The token must be a **Page access token** from a user who can create content on the Page.
- A Page token derived from a long-lived user token does not expire (until the password changes, the app is removed, etc.). `facebook verify` detects a revoked token.

### 2.6 Error classification

| Code                         | Meaning                          | Handling                                                                                    |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| 190                          | Invalid/expired token            | **Stop the whole run.** Mark nothing as failed. Ask the user to run `facebook login`        |
| 200                          | Permission error                 | Stop the whole run                                                                          |
| 368                          | Action deemed abusive/disallowed | **Stop the whole run and pause publishing** (`publishing_paused=true`); needs manual review |
| 613                          | Rate limit                       | Hold the item until the quota window frees up; no retry count spent                         |
| 100                          | Invalid parameter                | Permanent failure for that video                                                            |
| 6000                         | Video upload failure             | Transient; resume the upload                                                                |
| HTTP 5xx / network / timeout | Transient                        | Retry with backoff                                                                          |

### 2.8 Regular Page videos (for videos longer than the Reel limit)

Source: [Page Videos reference v25.0](https://developers.facebook.com/docs/graph-api/reference/page/videos/), [Video publishing guide](https://developers.facebook.com/docs/video-api/guides/publishing).

The first real batch (737 videos) has 556 videos longer than 90 s. **Decision:** publish these through the regular Page video endpoint instead of splitting or trimming them.

```
POST https://graph-video.facebook.com/{ver}/{page-id}/videos
  chunked upload: upload_phase=start (file_size) → { upload_session_id, video_id, start_offset, end_offset }
                  upload_phase=transfer (upload_session_id, start_offset, video_file_chunk) → next offsets
                  upload_phase=finish (upload_session_id, title, description, published, scheduled_publish_time)
  (alternative: the Resumable Upload API, POST /{app-id}/uploads → file handle; decide in Phase 7)
```

- Scheduling: `published=false` + `scheduled_publish_time` **between 10 minutes and 6 months** ahead (the tool uses 180 days to be safe).
- Permissions: the same as Reels (`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`).
- No documented duration/size spec for this endpoint. The tool uses the commonly cited 240 min / 10 GB as caps (unverified) and only _warns_ about AV1/VP9 video or non-AAC audio.
- Page videos do **not** count against the 30/24h Reels API quota. Their own rate limit is unknown (Q8).
- Error codes are the same as Reels, plus 6001 (upload failure), 382 (file too small), 389 (cannot fetch URL).

**Publish target.** Each video has `publish_target` = `REEL` | `VIDEO`:

- Automatic: `REEL` if duration ≤ `REEL_MAX_DURATION_S` (default 90), else `VIDEO`.
- Can be pinned manually in the CSV (`VIDEO` is allowed for short videos; `REEL` is rejected for videos over the limit).
- `reel-cli recheck` recomputes automatic targets and spec results, e.g. after `REEL_MAX_DURATION_S` changes (raise it only if Q7 shows the Reels API accepts longer videos).

### 2.7 Open questions (answer in Phase 0, then update this section)

1. Does a `SCHEDULED` Reel count against the 30/24h limit when it is created or when it goes live? **Until confirmed, count it at creation (conservative).**
2. Can an app in Development mode, with the user as app admin, publish to the user's own Page without App Review?
3. Does FINISH return `post_id` directly, or is it only available from `GET /{video-id}?fields=post_id` after publishing?
4. Can a Meta-scheduled Reel be cancelled or rescheduled (`DELETE /{video-id}` or an update)? This decides whether `reschedule` is possible after submission.
5. Maximum `description` length and hashtag count accepted.
6. How the copyright check shows up in `status` when it blocks or mutes a Reel.
7. Does `/{page-id}/video_reels` accept videos longer than 90 s? The Facebook app has allowed long Reels since June 2025, and there are unconfirmed reports that the API accepts them too, but the docs still say 3–90 s. If it is rejected, does `/{page-id}/videos` produce a Reel? (The long videos go out as Page videos regardless; a "yes" would let us raise `REEL_MAX_DURATION_S` so they appear as true Reels.)
8. Rate limits for `POST /{page-id}/videos`, and whether Page videos show up in the Reels tab (Facebook has shown all videos in Reels format since June 2025).

---

## 3. Architecture

```
videos/ ──scan──▶ SQLite (source of truth) ◀──import── exports/reels.csv
                     │    ▲                   ──export──▶
                     │    │
              generate    │ transcribe (whisper) + LLM (Ollama) + Page profile
                     │
                  schedule   (auto-fills scheduled_at by slots, respecting quota)
                     │
                  validate   (file, hash, specs, content, schedule)
                     │
                  publish ───▶ Meta: START → TRANSFER → FINISH → VERIFY
                     │
                  worker  ───▶ hands off held items to Meta, polls processing, reconciles
```

SQLite is always the source of truth. CSV is only an editing interface. Meta's state is checked through `reconcile`.

---

## 4. Technology stack

| Concern         | Choice                                                                 | Why                                                                 |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Runtime         | Node.js ≥ 20.5, TypeScript strict                                      | Node 20 requires better-sqlite3 v11 (v12+ has no Node 20 prebuilds) |
| CLI             | Commander.js                                                           |                                                                     |
| DB              | SQLite via **better-sqlite3 + Drizzle ORM** (+ drizzle-kit migrations) | Synchronous, fast, no engine binary (unlike Prisma)                 |
| Validation      | **Zod**                                                                | Config, CSV rows, LLM output, API responses                         |
| Dates/timezones | **Luxon**                                                              | Timezone handling (IANA zones)                                      |
| CSV             | csv-parse / csv-stringify                                              | Handles quoting and multi-line captions                             |
| Media           | ffprobe / ffmpeg via `execa`                                           |                                                                     |
| HTTP            | Native `fetch` (undici)                                                | Streaming upload bodies                                             |
| Logging         | **pino** with `redact` paths                                           | JSON logs; tokens never logged                                      |
| Secrets         | **@napi-rs/keyring** (OS keychain), `.env` fallback                    | `keytar` is unmaintained                                            |
| Transcription   | whisper.cpp or faster-whisper (local), behind `TranscriptionProvider`  | Handles Hindi/Hinglish                                              |
| LLM             | Ollama (`qwen3:8b` default), behind `AIProvider`                       |                                                                     |
| Tests           | Vitest                                                                 |                                                                     |

---

## 5. Project structure

The repository root is the project folder. See the "Project structure" section of the README for the current layout; modules still to come: `src/ai/`, `src/transcription/` (Phase 5), `src/facebook/` (Phase 6), `src/publisher/` (Phase 7), `src/worker/` (Phase 8).

---

## 6. Data model

### 6.1 `videos`

| Column                            | Type                 | Notes                                                                    |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| id                                | INTEGER PK           |                                                                          |
| file_hash                         | TEXT UNIQUE NOT NULL | SHA-256 of original file                                                 |
| file_path                         | TEXT NOT NULL        | Absolute path; updated if file moves                                     |
| filename                          | TEXT                 |                                                                          |
| file_size                         | INTEGER              |                                                                          |
| file_mtime                        | INTEGER              | Used with size+path for the hash cache                                   |
| duration_s                        | REAL                 |                                                                          |
| width, height                     | INTEGER              |                                                                          |
| fps                               | REAL                 |                                                                          |
| video_codec, audio_codec          | TEXT                 |                                                                          |
| audio_sample_rate, audio_channels | INTEGER              |                                                                          |
| container                         | TEXT                 |                                                                          |
| bitrate                           | INTEGER              | nullable                                                                 |
| spec_ok                           | INTEGER (bool)       | Result of the last spec check                                            |
| spec_issues                       | TEXT (JSON)          |                                                                          |
| normalized_path                   | TEXT                 | nullable; file actually uploaded if set                                  |
| transcript                        | TEXT                 | nullable                                                                 |
| transcript_lang                   | TEXT                 |                                                                          |
| caption                           | TEXT                 |                                                                          |
| hashtags                          | TEXT (JSON array)    |                                                                          |
| title                             | TEXT                 | optional                                                                 |
| caption_source                    | TEXT                 | `ai` \| `manual`; `generate` never overwrites `manual` without `--force` |
| is_ai_generated                   | INTEGER (bool)       | Sent to Meta as `is_ai_generated`                                        |
| publish_target                    | TEXT                 | `REEL` \| `VIDEO` (§2.8)                                                 |
| target_source                     | TEXT                 | `auto` (by duration) \| `manual` (pinned via CSV)                        |
| action                            | TEXT                 | `POST_NOW` \| `SCHEDULE` \| `SKIP` \| NULL                               |
| scheduled_at                      | TEXT                 | ISO-8601 UTC                                                             |
| state                             | TEXT NOT NULL        | See §7                                                                   |
| fb_video_id                       | TEXT                 | Saved **right after START**                                              |
| fb_post_id                        | TEXT                 |                                                                          |
| fb_permalink                      | TEXT                 |                                                                          |
| bytes_uploaded                    | INTEGER              | Resume point                                                             |
| finish_sent_at                    | TEXT                 | Used by the quota tracker                                                |
| published_at                      | TEXT                 | Confirmed by VERIFY                                                      |
| retry_count                       | INTEGER              | Transient retries in the current attempt                                 |
| next_attempt_at                   | TEXT                 | Backoff target                                                           |
| last_error_code, last_error       | TEXT                 |                                                                          |
| locked_by, lock_expires_at        | TEXT                 | Lease-based lock                                                         |
| version                           | INTEGER              | Incremented on every change; CSV conflict detection                      |
| created_at, updated_at            | TEXT                 |                                                                          |

### 6.2 `publish_attempts` (history of every attempt; never deleted)

`id, video_id, step (START|TRANSFER|FINISH|VERIFY|RECONCILE), started_at, ended_at, outcome (ok|transient|permanent|fatal), http_status, fb_error_code, fb_error_subcode, message, fb_trace_id`

### 6.3 `app_state` (key/value)

`publishing_paused`, `paused_reason`, `page_id`, `page_name`, `token_checked_at`, `schema_version`.

---

## 7. State machine

`action` is set by the user. `state` is set only by the system, and only through `domain/transitions.ts`, where every transition is an atomic conditional UPDATE (`WHERE id=? AND state=? AND version=?`).

```
            scan                 import/edit (action set, valid)
  (file) ─────────▶ NEW ─────────────────────────────▶ READY ──────▶ SKIPPED
                     ▲                                   │  (action=SKIP)
                     └── import: action cleared ─────────┤
                                                         │ publish/worker claims (lease)
                      scheduled_at > now+29d or no quota ▼
                           HELD ◀──────────────────── [claim]
                            │  window reached                │
                            └───────────────▶ UPLOADING ◀────┘
                                               (START ok, fb_video_id saved)
                                                   │ TRANSFER complete
                                                   ▼
                                               FINISHING  (FINISH request sent)
                                                   │ FINISH ok
                                                   ▼
                                               PROCESSING (polling VERIFY)
                                          ┌────────┴─────────┐
                                          ▼                  ▼
                                      SCHEDULED          PUBLISHED
                                     (Meta holds)     (terminal, confirmed)
                                          │ publish_time passes + VERIFY
                                          └──────▶ PUBLISHED

  Any active state ──permanent error / retries exhausted──▶ FAILED ──`retry`──▶ READY
```

### 7.1 Idempotency rules (critical)

1. **START runs only if `fb_video_id IS NULL`.** Once a `video_id` exists, the tool never calls START again for that row unless `reconcile` has confirmed the remote video is `expired`/`upload_failed` and cleared it.
2. **Save `fb_video_id` in the same transaction as moving to UPLOADING**, before any bytes are sent.
3. **TRANSFER resumes** from the remote `bytes_transferred` (read from VERIFY), not from zero.
4. **FINISH is the risky step.** Set `state=FINISHING` and `finish_sent_at` _before_ sending. If the process dies there, the row is left in FINISHING and `reconcile` runs VERIFY:
   - `publish_status` published/scheduled → advance the state, no resend.
   - still `upload_complete`, not published → safe to resend FINISH.
   - unknown → leave as-is and report; never resend blindly.
5. **Leases instead of plain locks:** a claim sets `locked_by=<pid@host>` and `lock_expires_at=now+10min`. An expired lease on an active state leads to `reconcile`, not a fresh publish.
6. **Single worker:** `data/worker.lock` (pid file + liveness check). `publish` refuses to run while a worker holds the lock, and vice versa, unless `--force`.
7. **Hash re-check** immediately before START: if the file changed, abort that row (`last_error=HASH_MISMATCH`).
8. `PUBLISHED`, `SCHEDULED` and `SKIPPED` rows are never claimed. Import cannot change them (except that SKIPPED can be un-skipped).

### 7.2 Retry policy

- Transient errors: exponential backoff with jitter, 5 s → 15 s → 45 s (`MAX_RETRIES=3`). In the worker, backoff is stored in `next_attempt_at`, not slept inside the process.
- 613: move to HELD until the quota tracker allows it; no retry count spent.
- 190/200/368: fatal for the whole run. Stop immediately, set the pause flag for 368, and leave the row's state untouched.
- Permanent (100, spec violations reported by Meta): FAILED, with the error recorded.

---

## 8. Commands

| Command                       | Purpose                                                                                    | Mutates Meta?     | `--dry-run`                   |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------- | ----------------------------- |
| `init`                        | Create folders, DB, run migrations, write `.env` / `page-profile.yaml` templates           | no                | —                             |
| `doctor`                      | Check ffmpeg/ffprobe, whisper, Ollama + model, DB, token validity, permissions, pause flag | no                | —                             |
| `scan <dir>`                  | Recursive scan, hash (cached), ffprobe, spec check, insert new / update moved              | no                | yes                           |
| `normalize [--ids]`           | ffmpeg re-encode non-compliant videos into `data/normalized/`                              | no                | yes                           |
| `recheck [--dry-run]`         | Recompute publish target + spec results from stored metadata                               | no                | yes                           |
| `transcribe [--ids]`          | Extract audio (16 kHz mono wav), run transcription                                         | no                | —                             |
| `generate [--ids] [--force]`  | Caption + hashtags via LLM (runs transcribe if needed); skips `manual` rows                | no                | yes                           |
| `schedule`                    | Auto-assign `scheduled_at` (see §10)                                                       | no                | yes (default: shows the plan) |
| `export [--all]`              | Write `exports/reels.csv`                                                                  | no                | —                             |
| `import <csv>`                | Validate + apply editable columns                                                          | no                | yes                           |
| `validate [--ids]`            | Full pre-publish checks                                                                    | no                | —                             |
| `publish [--ids] [--limit n]` | Publish READY rows: POST_NOW now, SCHEDULE via Meta (≤29d) or HELD                         | **yes**           | yes                           |
| `worker`                      | Loop: hand off HELD, poll PROCESSING/SCHEDULED, reconcile, retry                           | **yes**           | yes                           |
| `reconcile`                   | Compare active/uncertain rows with Meta's state and fix the DB                             | read-only on Meta | yes                           |
| `retry [--ids]`               | FAILED → READY (clears the error, keeps the history)                                       | no                | yes                           |
| `status`                      | Counts, quota used/remaining, upcoming, failures, pause flag                               | no                | —                             |
| `show <id>`                   | Full detail of one video + attempt history                                                 | no                | —                             |
| `facebook login`              | Token exchange flow (§11) → keyring                                                        | no                | —                             |
| `facebook pages`              | List Pages the user manages; select one                                                    | no                | —                             |
| `facebook verify`             | Check the token (`debug_token`), permissions, Page access                                  | no                | —                             |
| `resume`                      | Clear `publishing_paused` after manual review                                              | no                | —                             |

With `--dry-run`, the command never calls a Graph API mutation and never writes to the DB.

---

## 9. CSV contract

### 9.1 Format

- UTF-8 **with BOM** (so Excel shows Hindi/emoji correctly), RFC-4180 quoting, multi-line captions allowed.
- Every ID is written as text. Facebook IDs are **not** in the editable export; `show` displays them.
- Dates are local time in `TIMEZONE`, format `YYYY-MM-DD HH:mm` (e.g. `2026-09-27 18:30`). Converted to UTC on import. ISO-8601 with an offset is also accepted.

### 9.2 Columns

| Column          | Editable        | Notes                                                              |
| --------------- | --------------- | ------------------------------------------------------------------ |
| id              | key             |                                                                    |
| version         | key (read-only) | Conflict check                                                     |
| filename        | no              |                                                                    |
| duration_s      | no              |                                                                    |
| spec_ok         | no              |                                                                    |
| state           | no              |                                                                    |
| publish_target  | **yes**         | `REEL` / `VIDEO` / empty = automatic by duration                   |
| caption         | **yes**         |                                                                    |
| hashtags        | **yes**         | `#a #b #c`; normalized on import (leading `#`, no spaces, deduped) |
| title           | **yes**         | optional                                                           |
| action          | **yes**         | `POST_NOW` / `SCHEDULE` / `SKIP` / empty                           |
| scheduled_at    | **yes**         | required iff action=SCHEDULE                                       |
| is_ai_generated | **yes**         | `yes`/`no`                                                         |
| last_error      | no              | For information                                                    |

### 9.3 Import rules

1. Header must contain all key and editable columns (extra columns are ignored, order doesn't matter).
2. Unknown `id` → error. Duplicate `id` in the file → error.
3. `version` in the CSV ≠ DB version → **conflict**. The row is rejected with "record changed since export; re-export". (`--force` overrides only for NEW/READY/FAILED rows.)
4. Rows in UPLOADING/FINISHING/PROCESSING/SCHEDULED/PUBLISHED: any change to an editable column → error ("already submitted to Facebook").
5. Editing caption/hashtags/title sets `caption_source=manual`.
6. Setting a valid action moves NEW → READY; clearing it moves READY → NEW.
7. All-or-nothing: if any row is invalid, nothing is written (unless `--partial`).
8. Output: counts plus per-row errors with CSV row numbers.

---

## 10. Scheduling

### 10.1 `reel-cli schedule` (implemented in Phase 4)

Fills `scheduled_at` for NEW/READY/HELD rows that pass their spec check and don't have one (or re-plans them, with `--reset`). Reels and Page videos use separate daily slots (`REEL_SLOTS` default `09:00,14:00,20:00`, `VIDEO_SLOTS` default `12:00,18:00`):

```
reel-cli schedule --start 2026-10-01 [--reel-slots 09:00,14:00,20:00] [--video-slots 12:00,18:00] [--order filename|id|duration|random --seed N] [--target reel|video|all] [--ids ...] [--days N] [--limit N] [--reset] [--clear] [--apply]
```

- Sets `action=SCHEDULE`.
- Never plans more than `QUOTA_PER_24H` (default **25**, a safety margin under Meta's 30) in any rolling 24-hour window, including rows already submitted.
- Shows a preview table; `--apply` writes it. Users can still fine-tune in the CSV.

### 10.2 At publish time

| Condition                                                        | Behaviour                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| action=POST_NOW                                                  | Publish now (`video_state=PUBLISHED`), if quota allows; otherwise HELD   |
| SCHEDULE, `scheduled_at` < now + 10 min                          | Validation error (fix the time, or change to POST_NOW)                   |
| SCHEDULE, within 10 min … 29 days (Reel) / 6 months (Page video) | Submit to Meta as scheduled → state SCHEDULED                            |
| SCHEDULE, beyond that window                                     | HELD; the worker submits it once inside the window                       |
| Reel, quota exhausted                                            | HELD until the rolling 24h window frees up (Page videos are not counted) |

### 10.3 Quota tracker

`used = count(videos where finish_sent_at > now − 24h)` plus any 613 responses observed. Update this rule once open question §2.7-1 is answered.

### 10.4 Worker loop (`WORKER_INTERVAL_SECONDS=30`)

Each tick:

1. Exit early if `publishing_paused`.
2. Reconcile rows with expired leases.
3. Poll PROCESSING rows (VERIFY) → PUBLISHED / SCHEDULED / FAILED.
4. Poll SCHEDULED rows whose `scheduled_at` has passed → PUBLISHED (and fetch the permalink).
5. Hand off HELD rows now inside the window, and POST_NOW rows waiting on quota.
6. Retry rows with `next_attempt_at <= now`.

Handles SIGINT/SIGTERM gracefully: finish the current HTTP step, release leases, exit. Can run as a `systemd --user` service (unit file documented in the README).

---

## 11. Facebook authentication (implemented early, 2026-09-26)

Official **browser login** (Facebook Login, authorization-code flow). No token copy-pasting, and no browser session cookies (never supported: against Meta's terms and gets accounts restricted).

1. One-time app setup: Meta app with the **Facebook Login** product, kept in **Development** mode. Meta allows `http://localhost` redirects automatically in Development mode, so `http://localhost:{FACEBOOK_OAUTH_PORT}/callback` (default 8585) needs no registration. A Live app would need an HTTPS redirect instead. App ID/secret go in `.env`.
2. `reel-cli facebook login [--page <id>] [--port <n>] [--no-browser]`:
   - starts a callback server on localhost only (127.0.0.1 and ::1), with a random 48-hex-char `state` (timing-safe compare; wrong-state requests are rejected), and a 5 min timeout;
   - opens `https://www.facebook.com/{ver}/dialog/oauth` (`response_type=code`, the 3 scopes, `auth_type=rerequest`);
   - code → short-lived user token → long-lived user token (~60 days) → `debug_token` confirms all scopes were granted;
   - `/me/accounts` → only Pages with the `CREATE_CONTENT` task are offered; one is chosen automatically, several are chosen interactively (or with `--page`);
   - stores `page:<id>` (Page token, no expiry) and `user` (to switch Pages later) in the **OS keychain** via `@napi-rs/keyring`, falling back to a `0600` file `data/credentials.json`; saves `page_id`/`page_name`/`token_checked_at` in `app_state`.
3. `facebook pages [--select <id>]`, `facebook verify` (`debug_token`: valid, type PAGE, right Page and app, scopes, expiry), `facebook logout`.
4. All Graph calls with a user/Page token send `appsecret_proof`. `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_ACCESS_TOKEN` in `.env` still override the stored login (for servers without a browser).

## 12. AI content generation

### 12.1 Pipeline

```
video ─ffmpeg─▶ 16 kHz mono wav ─whisper─▶ transcript (+lang)
                                                 │
 page-profile.yaml + metadata + filename ────────┼──▶ prompt ─▶ Ollama (JSON schema) ─▶ Zod ─▶ DB
                                                 │
 (no speech?) ─ffmpeg─▶ 3–4 keyframes ─▶ vision model (optional, v1.1)
```

### 12.2 Page profile (`config/page-profile.yaml`)

The biggest factor in caption quality:

```yaml
page_name: '...'
niche: 'Hindi drama short clips'
language: 'Hinglish' # hi | en | Hinglish
tone: 'emotional, curious, short'
caption_max_chars: 220
hashtags:
  count: 5
  always_include: ['#reels']
  banned: ['#fyp']
banned_words: []
call_to_action_examples: ['Follow for part 2', 'Comment your thoughts']
example_captions:
  - '...'
  - '...'
```

### 12.3 LLM rules

- Use Ollama `/api/chat` with `format: <JSON schema>`, `think: false` (qwen3), `temperature ≈ 0.7`.
- Output schema: `{ caption: string (1..caption_max_chars), hashtags: string[] (count) , title?: string }`.
- Validate with Zod, then post-process: normalize hashtags, remove banned tags/words, add `always_include`, dedupe.
- On invalid output: retry up to 2 times with the validation error fed back; then leave the row without a caption and report it. Never save unvalidated text.
- Record `ai_model`, `generated_at`. Never overwrite `caption_source=manual` without `--force`.
- `generate` is idempotent: rows that already have AI content are skipped unless `--force`.

### 12.4 Final description sent to Meta

`description = caption + "\n\n" + hashtags.join(" ")`, checked against the length limit (§2.7-5).

---

## 13. Validation (`reel-cli validate`)

For each row with an action (or `--ids`):

- **File:** exists; size and mtime unchanged, or hash re-checked and matching.
- **Specs:** §2.4 checks from stored ffprobe data. If a `normalized_path` exists, validate that file instead.
- **Content:** caption non-empty, within length; 1–30 valid hashtags; description within the limit.
- **Action/schedule:** valid enum; `scheduled_at` present, parseable, more than 10 minutes in the future; quota plan feasible.
- **Global** (when rows are going to be published): token present and verified recently, Page selected, `publishing_paused=false`.

Output: ✓/✗ per video with reasons, plus a summary. Exit code 1 if any row is invalid (useful for scripts).

---

## 14. Configuration (`.env.example`)

```
# Facebook
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
FACEBOOK_PAGE_ID=              # optional; normally set by `facebook pages`
FACEBOOK_PAGE_ACCESS_TOKEN=    # fallback only; prefer keychain
GRAPH_API_VERSION=v26.0

# Publishing
QUOTA_PER_24H=25
MAX_RETRIES=3
WORKER_INTERVAL_SECONDS=30
TIMEZONE=Asia/Kolkata

# AI
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
TRANSCRIPTION_PROVIDER=whisper-cpp
WHISPER_MODEL=small             # base | small | medium
WHISPER_BINARY=                 # path if not on PATH

# Paths
DATABASE_URL=./data/reels.db
LOG_LEVEL=info
```

All config is parsed with Zod at startup; missing or invalid values give a clear error naming the variable.

---

## 15. Logging and security

- pino JSON logs to `logs/publisher.log` (daily rotation) plus readable console output.
- `redact`: `access_token`, `Authorization`, `*.token`, `appsecret_proof`, `client_secret`. Graph URLs are logged **without** query strings.
- Each log line includes: ts, command, video_id, filename, step, state transition, fb ids, error code, fb trace id.
- `.gitignore`: `.env`, `data/`, `logs/`, `exports/`, `videos/`, `node_modules/`, `dist/`.
- Tokens are never written to CSV, the DB or logs.
- Only the official Graph API is used: no browser automation or scraping.

---

## 16. Testing

- **Unit:** hash cache, spec checker (ffprobe JSON fixtures), hashtag normalizer, CSV parse/serialize (BOM, multi-line, Hindi), import rules (conflict, locked rows), date/timezone conversion, schedule planner (quota windows, 29-day boundary, 10-minute boundary), state transitions (every allowed and forbidden edge), retry/backoff, error classifier, LLM output validation.
- **Integration:** real SQLite in a temp dir plus a mocked Graph API (`msw` or undici MockAgent), covering:
  - happy path POST_NOW / SCHEDULED / HELD → hand-off
  - crash after START, during TRANSFER, after FINISH-sent (simulate kill) → reconcile gives no duplicate
  - 613 → HELD; 190 → run aborted, states intact; 368 → paused
  - `publish` twice in a row → second is a no-op
- **Fixtures:** 3–4 tiny generated clips (`ffmpeg -f lavfi`): compliant, wrong aspect, too short, no audio. Graph API responses recorded during Phase 0 (tokens removed).
- No real Facebook calls in automated tests. A manual `npm run e2e:facebook` script posts one DRAFT Reel to a test Page.

---

## 17. Development phases

After each phase: `tsc --noEmit`, `vitest run`, run the CLI by hand, update the README, and report files created/changed, commands run, test results and remaining issues. Do not move on until the phase works.

### Phase 0: Facebook test (de-risk first; no project code)

- Create the Meta app, get a Page token via Graph API Explorer.
- With `curl`: START → TRANSFER → FINISH (`DRAFT`, then `SCHEDULED`) → VERIFY on a real test video.
- Answer the open questions in §2.7 where possible; save sanitized responses as fixtures.
- Output: `docs/facebook-api.md` with exact requests and responses.

### Phase 1: Foundation

TS project, Commander, config (Zod), pino, Drizzle schema + migrations, `init`, `doctor` (partial), `status` (empty). **Check:** `reel-cli --help`, `reel-cli init`, `reel-cli doctor`.

### Phase 2: Scanner + metadata

`scan` with recursive walk, supported extensions, SHA-256 streaming hash + cache, ffprobe metadata, spec check, move detection, duplicate-content report, summary. **Tests:** 1 file, 10 files, duplicates, nested, unsupported, moved file, rescan no-op.

### Phase 3: CSV + validate + status (MVP)

`export`, `import` (+`--dry-run`), `validate`, full `status`, `show`. **Check:** round-trip in LibreOffice/Excel with Hindi captions unchanged.

### Phase 4: Scheduling planner

`schedule` with slots, quota window and preview/apply.

### Phase 5: AI

`TranscriptionProvider` (whisper.cpp), `AIProvider` (Ollama), page profile, `transcribe`, `generate`. **Check:** 10 real videos give valid, on-brand captions.

### Phase 6: Facebook auth

GraphClient (versioned, typed errors, redaction), `facebook login`, `facebook pages`, `facebook verify`, keychain storage, `doctor` token check.

### Phase 7: Publisher (implemented 2026-09-27)

- `src/facebook/video-api.ts`: typed Reel (start / rupload transfer / finish) and chunked Page video (start / transfer / finish) calls and video status. `src/facebook/errors.ts` classifies errors as transient, rate_limit, fatal, pause or permanent, and tracks whether Facebook answered at all.
- `src/publisher/`: `decidePublish` (now / native schedule / draft / hold / skip), `interpretStatus` (published / scheduled / draft / uploaded / processing / failed), leases, the attempt log, `publishOne` / `reconcileOne`, and `runPublish`.
- CLI: `publish` (plan, then confirm; `--dry-run`, `--draft`, `--ids`, `--limit`, `--target`, `--wait`, `--yes`), `reconcile`, `retry [--drafts]`, `resume`.
- Decisions made while implementing:
  - New state **DRAFT** for private test uploads (`--draft`, needs `--ids`, allowed on NEW videos). Drafts count as submitted; `retry --drafts` makes them publishable again (the Facebook copy stays and can be deleted in Meta Business Suite).
  - Page video uploads interrupted by a crash **restart** instead of resuming: chunked sessions can't be resumed across runs, and nothing is public before finish.
  - The quota is counted at finish time for Reels, including drafts (conservative until Q1 is answered).
  - `publish` reconciles FINISHING, PROCESSING and past-due SCHEDULED videos before submitting new ones.
- **Checked:** 294 tests, including crash and network-drop injection on a stateful fake of both upload flows. **Still to do on the real Page:** one DRAFT (`reel-cli publish --ids <id> --draft`), then one PUBLISHED, then one long Page video; update §2.7 with what Facebook actually returns.

### Phase 8: Worker

Loop §10.4, leases, worker lock, graceful shutdown, HELD hand-off, status polling, `resume`, systemd unit docs.

### Phase 9: Hardening

`normalize`, log rotation, `doctor` complete, README end-to-end guide, performance check with 200 files.

---

## 18. MVP definition

Phases 0–3: `init`, `doctor`, `scan`, `export`, `import`, `validate`, `status`, `show`, plus a confirmed manual Facebook publish via curl. Captions can be typed by hand in the CSV at this stage.

## 19. Definition of done

1. Copy 100 videos into `videos/`.
2. `reel-cli scan ./videos` finds 100 new videos; running it again finds 0 new.
3. `reel-cli normalize` fixes any non-compliant videos; `validate` reports specs as OK.
4. `reel-cli generate` gives on-brand captions and hashtags for every video.
5. `reel-cli schedule --start <date> --slots 09:00,14:00,20:00 --apply` spreads them over ~34 days within the quota.
6. `export` → edit a few captions/times in a spreadsheet → `import --dry-run` → `import`.
7. `validate` passes.
8. `publish` submits everything within 29 days to Meta as SCHEDULED; the rest become HELD.
9. `worker` (systemd) hands off HELD items over time, confirms each one as PUBLISHED, and records the permalink.
10. Killing the process at any point and restarting never produces a duplicate Reel; `status` always matches the Page.

## 20. Coding rules

- TypeScript strict; small modules; no file over ~300 lines.
- `domain/` is pure (no I/O) and fully unit-tested; services receive their dependencies through constructors (DI).
- Every external input (env, CSV, LLM, Graph API, ffprobe) is parsed with Zod.
- No fake Facebook implementations presented as working; anything not yet verified is written up in `docs/facebook-api.md`.
- Errors are typed (`TransientError`, `PermanentError`, `FatalRunError`, `ValidationError`) and handled explicitly.
- README updated with every phase.

---

## Phase 10: Instagram (implemented 2026-10-04, branch `feature/instagram`)

- **Data:** new table `platform_posts` (one row per video per extra platform: action, schedule, state, container/media ids, retries, lease, version) and `publish_attempts.platform` (default `facebook`). Additive migration: Facebook state stays on `videos`; verified on a copy of the real database (identical fingerprints and Facebook publish plan).
- **API:** Instagram API with Facebook Login (Page token + `instagram_basic`, `instagram_content_publish`): resumable REELS container → `rupload.facebook.com/ig-api-upload` → `status_code` FINISHED → `media_publish`. 100 posts/24 h per Instagram; no native scheduling; containers expire after 24 h.
- **Media:** Instagram needs H.264/HEVC + AAC ≤ 48 kHz, 23–60 fps, ≤ 1920 px wide, ≤ 300 MB, 3 s–15 min. Non-compliant files (most sources are AV1/VP9) are re-encoded to H.264/AAC into `workspace/data/normalized/` (cached by hash); originals and Facebook uploads are untouched.
- **Publishing:** prepare `INSTAGRAM_PREPARE_HOURS` (3) ahead, publish at the time from `reel-cli worker`; `PUBLISHING` saved before `media_publish`, lost replies settled from the container status and recent media. Own daily limit (`INSTAGRAM_DAILY_LIMIT`, 25), shared gap, own lease and own pause flag (368 pauses Instagram only).
- **Commands:** `instagram connect | status | plan --from-facebook | publish | retry | resume`, `worker`; CSV columns `ig_action`, `ig_scheduled_at`, `ig_state` (optional on import).
- **Still to do live:** connect a real Instagram professional account, then one private-ish test post; photos, carousels and Stories later.
