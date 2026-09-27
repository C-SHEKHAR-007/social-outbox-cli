# reel-cli: Facebook Reel Publisher

A local-first command-line tool that takes a folder of videos and publishes them to a Facebook Page on a schedule, through Meta's **official Graph API**:

- videos up to 90 s go out as **Reels**, longer ones as regular **Page videos**;
- captions, hashtags and times are edited in a **CSV/spreadsheet**;
- Facebook schedules the posts itself, so your computer does not need to be on at posting time;
- built so the **same video is never posted twice**, even after crashes or re-runs.

Design notes: [`docs/plan.md`](docs/plan.md). Facebook/Meta details: [`docs/facebook-api.md`](docs/facebook-api.md).

---

## Contents

1. [Status](#status)
2. [Requirements and installation](#requirements-and-installation)
3. [Quick start: from a folder to scheduled posts](#quick-start-from-a-folder-to-scheduled-posts)
4. [Key concepts](#key-concepts)
5. [Command reference](#command-reference)
6. [Workflows](#workflows)
   - [Connect your Facebook Page (one time)](#connect-your-facebook-page-one-time)
   - [Scan a folder](#scan-a-folder)
   - [Captions, hashtags and times via CSV](#captions-hashtags-and-times-via-csv)
   - [Same caption and hashtags for every video](#same-caption-and-hashtags-for-every-video)
   - [Scheduling: every N hours, or daily time slots](#scheduling-every-n-hours-or-daily-time-slots)
   - [First test: a private draft](#first-test-a-private-draft)
   - [Publishing and the daily routine](#publishing-and-the-daily-routine)
   - [Videos that fail the Reel spec (low resolution etc.)](#videos-that-fail-the-reel-spec-low-resolution-etc)
   - [Checking progress](#checking-progress)
   - [Start over / switch to another folder](#start-over--switch-to-another-folder)
   - [Updating the tool](#updating-the-tool)
7. [Safety: why nothing is posted twice](#safety-why-nothing-is-posted-twice)
8. [Configuration (.env)](#configuration-env)
9. [Troubleshooting](#troubleshooting)
10. [Known limitations](#known-limitations)
11. [Data and privacy](#data-and-privacy)
12. [Development](#development)

---

## Status

| Phase | Scope                                                                             | State                                                 |
| ----- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0     | Verify the Meta API on a real Page                                                | ✅ app, login and a real draft Reel verified          |
| 1     | Foundation: CLI, config, logging, SQLite + migrations, `init`, `doctor`, `status` | ✅ done                                               |
| 2     | Scanner, ffprobe metadata, Reel/Page video spec checks                            | ✅ done                                               |
| 3     | CSV export/import, `validate`, `show`                                             | ✅ done                                               |
| 4     | Schedule planner                                                                  | ✅ done                                               |
| 5     | AI captions (whisper + Ollama)                                                    | planned                                               |
| 6     | Facebook browser login, keychain storage, `verify`                                | ✅ done                                               |
| 7     | Publisher: Reels + Page videos, `publish` / `reconcile` / `retry` / `resume`      | ✅ done (draft verified live; first public post next) |
| 8     | Background `worker` (submits held videos automatically)                           | planned; until then run `publish` daily               |
| 9     | Hardening, `normalize` (re-encode to H.264/AAC)                                   | planned                                               |

---

## Requirements and installation

- **Node.js ≥ 20.5** (tested on 20.20)
- **ffmpeg + ffprobe** on `PATH` (`sudo apt install ffmpeg`)
- A **Facebook Page** you manage and a **Meta developer app** (setup below)
- Optional, for Phase 5: Ollama and whisper.cpp

```bash
git clone <this repo> && cd "Facebook Reel Automation Tool"
npm install
npm run build
npm link              # makes the `reel-cli` command available everywhere
reel-cli --help
```

Without `npm link`, use `npm run reel-cli -- <command>` (runs from source) or `node dist/cli/index.js <command>`.

The **workspace** is the folder you run `reel-cli` in: `.env`, `data/reels.db`, `logs/`, `exports/` and `config/` live there. The project folder itself works fine as the workspace.

---

## Quick start: from a folder to scheduled posts

```bash
cd "Facebook Reel Automation Tool"
reel-cli init                                   # 1. folders, .env, database (safe to re-run)
# 2. put FACEBOOK_APP_ID and FACEBOOK_APP_SECRET in .env (see "Connect your Facebook Page")
reel-cli facebook login                         # 3. browser login, pick your Page
reel-cli facebook verify                        #    ✓ PAGE token, expires never
reel-cli doctor                                 # 4. everything required should be ✓

reel-cli scan "/path/to/your/videos"            # 5. find and check all videos
reel-cli export                                 # 6. → exports/reels.csv
#    edit in LibreOffice/Excel: caption, hashtags, action=SCHEDULE, scheduled_at, is_ai_generated
reel-cli import exports/reels.csv --dry-run     # 7. preview changes
reel-cli import exports/reels.csv
reel-cli validate                               # 8. every video you set up should be ✓

reel-cli publish --ids <one id> --draft         # 9. optional: private test upload first
reel-cli publish --dry-run                      # 10. see the plan
reel-cli publish --limit 10                     # 11. upload + schedule (asks y/N)
reel-cli publish                                #     the rest
reel-cli status                                 # 12. overview
```

After that, run `reel-cli publish` once a day to submit videos that were held (quota or too far in the future) until the background worker exists.

---

## Key concepts

### Publish target: Reel or Page video

| Target  | When                                            | Facebook API                                               | Schedule ahead    | Daily quota                    |
| ------- | ----------------------------------------------- | ---------------------------------------------------------- | ----------------- | ------------------------------ |
| `REEL`  | duration ≤ `REEL_MAX_DURATION_S` (default 90 s) | `/{page}/video_reels` + upload to `rupload.facebook.com`   | 10 min – 29 days  | 25 per rolling 24 h (Meta: 30) |
| `VIDEO` | longer videos (or pinned manually)              | chunked upload to `graph-video.facebook.com/{page}/videos` | 10 min – 6 months | none                           |

The target is chosen automatically by duration. You can pin it per video in the CSV (`publish_target` column); an empty cell means automatic.

### Video states

| State                                    | Meaning                                                                  | What moves it on                       |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `NEW`                                    | scanned, no action yet                                                   | set an action via CSV / `schedule`     |
| `READY`                                  | has `POST_NOW` or `SCHEDULE` and can be published                        | `publish`                              |
| `HELD`                                   | waiting: over the Reels quota, beyond Facebook's window, or rate-limited | next `publish` after its time          |
| `UPLOADING` / `FINISHING` / `PROCESSING` | being sent / final call sent / Facebook still processing                 | `publish` resumes, `reconcile` settles |
| `SCHEDULED`                              | accepted by Facebook, will go live at `scheduled_at`                     | `reconcile` marks it PUBLISHED later   |
| `PUBLISHED`                              | live; Facebook ID and link saved                                         | final                                  |
| `DRAFT`                                  | uploaded as a private draft (`--draft`)                                  | `retry --drafts` to publish for real   |
| `FAILED`                                 | Facebook rejected it or retries ran out (`show <id>` says why)           | `retry`                                |
| `SKIPPED`                                | action `SKIP`                                                            | change the action in the CSV           |

### Upload limits (Facebook anti-spam)

Facebook blocks accounts that upload too much, too fast (error **368 / 1390008**: _"you were misusing this feature by going too fast"_), whatever the API endpoint. We learned this the hard way: 138 uploads in about 5 hours triggered a block. So every `publish` run respects three limits:

| Limit                    | Default                 | Counts                                              |
| ------------------------ | ----------------------- | --------------------------------------------------- |
| `DAILY_UPLOAD_LIMIT`     | **25 per rolling 24 h** | **every** upload: Reels, Page videos and drafts     |
| `QUOTA_PER_24H`          | 25 per rolling 24 h     | Reels only (Meta's Reels API allows 30)             |
| `MIN_UPLOAD_GAP_SECONDS` | **120 s**               | time between two uploads starting, also across runs |

Uploads are counted **when they are sent** (not when they go live), including uploads from earlier runs. Anything over a limit becomes `HELD` and goes out on a later run. `PUBLISH_CONCURRENCY` defaults to **1** (one upload at a time). Because the videos are scheduled ahead, uploading 25 a day is plenty: they still post at their scheduled times.

---

## Command reference

| Command                                                                                                                   | What it does                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `reel-cli init`                                                                                                           | Create workspace folders, `.env` and `config/page-profile.yaml` from templates, and the database. Never overwrites existing files.    |
| `reel-cli doctor`                                                                                                         | Check Node, config, ffmpeg/ffprobe, database, Facebook connection (and Ollama/whisper for later). Exit 1 if something required fails. |
| `reel-cli scan <dir> [--dry-run]`                                                                                         | Find `.mp4/.mov/.webm/.m4v` recursively, fingerprint (SHA-256), read metadata, check specs, add new videos.                           |
| `reel-cli recheck [--dry-run]`                                                                                            | Recompute publish target and spec results (after changing `REEL_MAX_DURATION_S` or pinning targets).                                  |
| `reel-cli export [--out file] [--all]`                                                                                    | Write videos to `exports/reels.csv` (published ones only with `--all`). Keeps the previous file as `.bak`.                            |
| `reel-cli import <csv> [--dry-run] [--force] [--partial]`                                                                 | Validate and apply CSV edits, all-or-nothing. Exit 1 if any row is invalid.                                                           |
| `reel-cli validate [--ids 1,2,5-8]`                                                                                       | Check READY videos (or given ids) are publishable. Exit 1 on errors.                                                                  |
| `reel-cli schedule [options] [--apply]`                                                                                   | Fill `scheduled_at` from daily time slots (Reels and Page videos separately). Preview unless `--apply`.                               |
| `reel-cli publish [--dry-run] [--draft] [--ids] [--limit n] [--target] [--concurrency n] [--yes] [--wait s \| --no-wait]` | Upload READY videos (3 in parallel): `POST_NOW` now, `SCHEDULE` natively on Facebook. Shows the plan and asks y/N.                    |
| `reel-cli reconcile [--ids]`                                                                                              | Ask Facebook about videos whose outcome is pending or unknown. Never re-posts.                                                        |
| `reel-cli retry [--ids] [--drafts] [--dry-run]`                                                                           | Make FAILED (and with `--drafts`, DRAFT) videos publishable again.                                                                    |
| `reel-cli resume`                                                                                                         | Resume publishing after Facebook error 368 paused it.                                                                                 |
| `reel-cli status`                                                                                                         | Counts by state and target, Reels quota used, upcoming and failed videos.                                                             |
| `reel-cli show <id>`                                                                                                      | Everything about one video: file, media, specs, caption, Facebook IDs/link, every publish attempt.                                    |
| `reel-cli facebook login [--page id] [--port n] [--no-browser]`                                                           | Official browser login; stores the Page token in the OS keychain.                                                                     |
| `reel-cli facebook pages [--select id]`                                                                                   | List your Pages / switch the Page to publish to (no browser needed).                                                                  |
| `reel-cli facebook verify`                                                                                                | Check the token: valid, PAGE type, never expires, required permissions.                                                               |
| `reel-cli facebook logout`                                                                                                | Remove stored tokens.                                                                                                                 |

`--ids` accepts lists and ranges everywhere: `--ids 1,2,5-8`. Every command has `--help`.

---

## Workflows

### Connect your Facebook Page (one time)

**1. Create the Meta app** at <https://developers.facebook.com/apps> → **Create app**:

- **Use case: "Manage everything on your Page"**. This matters: an app created only with _"Authenticate and request data from users with Facebook Login"_ cannot request Page permissions (you get _"Invalid Scopes"_), and that use case cannot be added to such an app later. Create a new app instead.
- Connect a Business portfolio if asked (helps Pages that belong to a portfolio show up).
- Keep the app in **Development** mode. As its admin you can use it on your own Pages; `http://localhost` login redirects are allowed automatically in Development mode, so there is nothing to register.

**2. Enable the permissions**: _Use cases → Manage everything on your Page → Customize_ → click **Add** for `pages_show_list`, `pages_read_engagement` and `pages_manage_posts` (status "Ready for testing"). Do **not** click _"Add to App Review"_; that is only needed to let other people use the app.

**3. Put the credentials in `.env`** (_App settings → Basic_):

```
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
```

**4. Log in:**

```bash
reel-cli facebook login     # browser: log in, approve, tick the Page(s) to allow; then pick one in the terminal
reel-cli facebook verify    # ✓ Type PAGE, Expires never, 3 permissions
```

The Page token never expires and is stored in the OS keychain (fallback: `data/credentials.json`, mode 0600). Switch Page any time with `reel-cli facebook pages --select <id>`. Posting with browser session cookies is intentionally not supported: it is against Meta's terms and gets Pages restricted.

### Scan a folder

```bash
reel-cli scan "/home/you/Videos/non-posted" --dry-run   # report only
reel-cli scan "/home/you/Videos/non-posted"
```

```
Found:             225
New:               225
Already tracked:     0

Targets: 76 Reel(s), 149 Page video(s) (longer than the Reel limit)
Spec check: 223 OK, 2 with problems
  ✗ #189 …/Video_626.mp4 (REEL)
      resolution 360x640 < 540x960
```

- A video is identified by its **content** (SHA-256), not its name: re-scanning never duplicates, and renamed/moved files keep their record.
- Duplicates (same content twice) are reported and not added; missing files are reported, never deleted; unreadable files are retried next scan.
- **Reel spec** (errors block publishing): 3–90 s, 9:16, ≥ 540×960, 24–60 fps, H.264/H.265/VP9/AV1, 4:2:0 progressive, AAC audio. Warnings (44.1 kHz audio, HE-AAC, VP9…) don't block. **Page videos** only need a video stream, ≤ 240 min, ≤ 10 GB.

### Captions, hashtags and times via CSV

```bash
reel-cli export                               # → exports/reels.csv
# open in LibreOffice Calc (UTF-8, comma separated) or Excel; edit; save as CSV
reel-cli import exports/reels.csv --dry-run   # shows every change and any error, row by row
reel-cli import exports/reels.csv
reel-cli validate
```

| Column                                                     | Editable  | Notes                                                                                                                                           |
| ---------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `version`                                            | no (keys) | `version` detects stale CSVs                                                                                                                    |
| `filename`, `duration_s`, `spec_ok`, `state`, `last_error` | no        | information only; ignored on import                                                                                                             |
| `publish_target`                                           | yes       | `REEL`, `VIDEO`, or empty = automatic                                                                                                           |
| `caption`                                                  | yes       | multi-line, Hindi and emoji are fine                                                                                                            |
| `hashtags`                                                 | yes       | `#drama #reels` (commas OK, `#` added if missing, duplicates removed, max 30)                                                                   |
| `title`                                                    | yes       | optional                                                                                                                                        |
| `action`                                                   | yes       | `POST_NOW`, `SCHEDULE`, `SKIP` or empty                                                                                                         |
| `scheduled_at`                                             | yes       | local time in `TIMEZONE`, e.g. `2026-09-27 18:30` (also `27/09/2026 18:30`). Required for `SCHEDULE`; at least 10 minutes ahead at publish time |
| `is_ai_generated`                                          | yes       | `yes`/`no`. Sent to Meta; `yes` may show Meta's **"AI info"** label. It describes the _video_, not the caption                                  |

What Facebook receives as the post text is `caption` + a blank line + `hashtags`.

Import rules:

- **All-or-nothing**: one invalid row and nothing is saved (`--partial` saves the valid rows only).
- Rows already sent to Facebook (DRAFT, SCHEDULED, PUBLISHED, …) **cannot be edited**; if you change one, the whole import is refused. Leave those rows as exported.
- **Stale CSV**: if a video changed after you exported (rescan, recheck, publish…), its row is rejected. Re-export, or `--force` for rows not yet sent.
- Setting an action moves `NEW → READY`; `SKIP` → `SKIPPED`; clearing it → `NEW`.
- If a spreadsheet changes the date format, format the `scheduled_at` column as _Text_.

### Same caption and hashtags for every video

In the spreadsheet: type the caption in the first `caption` cell, copy it, select the rest of the column and paste (same for `hashtags`, `is_ai_generated`, `action`). Then import as usual.

Keep in mind that Facebook tends to show fewer people posts with identical captions or "follow/share" requests (engagement bait); varied captions usually reach more people. Phase 5 will generate them.

### Scheduling: every N hours, or daily time slots

**Option A: one combined sequence every N hours (spreadsheet).** E.g. every 2 hours starting 27 Sep 03:00, in LibreOffice Calc with the first data row in row 2:

1. Set `action` to `SCHEDULE` for all rows.
2. In the first `scheduled_at` cell enter
   `=TEXT(DATE(2026;9;27)+TIME(3;0;0)+(ROW()-2)*2/24;"YYYY-MM-DD HH:MM")`
   and fill it down (`*2/24` = 2 hours; use `*3/24` for 3 hours, etc.).
3. Copy the column → _Paste Special → Values only_ (so the CSV contains text, not formulas). Save as CSV.
4. Leave rows that are already DRAFT/SCHEDULED/PUBLISHED untouched.

**Option B: daily time slots (`reel-cli schedule`).** Reels and Page videos each fill their own slots:

```bash
reel-cli schedule --start 2026-10-01                                    # preview (default REEL_SLOTS / VIDEO_SLOTS)
reel-cli schedule --start 2026-10-01 --reel-slots 09:00,14:00,20:00 --video-slots 12:00,18:00 --apply
reel-cli schedule --days 14 --apply                                     # only plan two weeks
reel-cli schedule --reset --apply                                       # re-plan videos that already have a time
reel-cli schedule --clear --apply                                       # remove schedules (videos not yet sent)
```

- Only NEW/READY/HELD videos that pass their spec check are planned; POST_NOW, SKIP, failed and already-sent videos are never touched.
- Skips slots less than 10 minutes away or already taken; never plans more Reels than the quota in any 24 h window.
- `--order filename` (natural: Video_9 before Video_10, default) · `id` · `duration` · `random --seed N`; `--target reel|video`, `--ids`, `--limit N`.

### First test: a private draft

Before publishing for real, upload one video as a **private draft** (not visible to anyone but Page admins):

```bash
reel-cli publish --ids 219 --draft     # needs a caption; works even without an action
reel-cli show 219                      # state DRAFT, Facebook video id, link, each step
```

Find it in **Meta Business Suite → Content → Drafts**. To post that video publicly **from the tool** (it is uploaded again as a new, public Reel; delete the old draft in Business Suite afterwards):

```bash
reel-cli retry --ids 219 --drafts      # DRAFT → NEW
# CSV: action = POST_NOW (or SCHEDULE + scheduled_at) → import
reel-cli publish --ids 219
```

(The tool cannot switch an existing draft to public without re-uploading; you can also publish the draft by hand in Business Suite.)

### Publishing and the daily routine

```bash
reel-cli publish --dry-run          # plan: publish now / schedule on Facebook / hold / not publishable
reel-cli publish --limit 10         # asks: Publish/schedule 10 video(s) on "Your Page"? [y/N]
reel-cli publish                    # everything that is ready
reel-cli publish --target reel      # only Reels (or --target video)
reel-cli publish --yes              # no question (for scripts/cron)
```

What happens per video: file re-checked → upload → final call → Facebook processes it.

- **One upload at a time, at least 120 s apart**, and at most `DAILY_UPLOAD_LIMIT` (25) uploads per rolling 24 h; the rest are held for the next run. `--concurrency 2-5` (or `PUBLISH_CONCURRENCY`) uploads in parallel, but that makes bursts more likely, so only use it if your Page tolerates it.
- **Waiting for processing:** for `POST_NOW` the tool waits (up to 120 s) until the video is live and saves the link. **Scheduled videos are not waited for**: they are already safely on Facebook, stay `PROCESSING` locally, and `reel-cli reconcile` (or the next `publish`) confirms them as `SCHEDULED`. `--wait 120` waits for every video; `--no-wait` never waits.
- Videos scheduled beyond Facebook's window, or over the Reels quota, become `HELD`.

Typical speed (measured): about 1 MB/s per upload. With the 120 s gap, 25 uploads take roughly an hour, and they can be left running.

**Daily routine** (until the Phase 8 worker exists):

```bash
reel-cli publish --yes      # uploads up to 25 more (daily limit), incl. held videos and ones now inside Facebook's window
reel-cli reconcile          # marks SCHEDULED videos that went live as PUBLISHED, settles anything pending
reel-cli status
```

Example `crontab -e` entry (09:30 every day; adjust the path):

```
30 9 * * * cd "/home/you/Facebook Reel Automation Tool" && /home/you/.nvm/versions/node/v20.20.2/bin/node dist/cli/index.js publish --yes >> logs/cron.log 2>&1
```

**Running `publish` twice is safe.** A second run skips anything already PUBLISHED/SCHEDULED/DRAFT/FAILED, only _checks_ videos still processing, resumes interrupted uploads with the same Facebook video, and a second run at the same time finds the video locked. See [Safety](#safety-why-nothing-is-posted-twice).

### Videos that fail the Reel spec (low resolution etc.)

A video that fails the Reel spec (e.g. 360×640, 20 fps) cannot go out as a Reel, but can as a **regular Page video**, which has no resolution/fps minimum:

```bash
# CSV: publish_target = VIDEO (+ action/scheduled_at) → import
reel-cli import exports/reels.csv
reel-cli recheck        # re-evaluates specs for the pinned target (the import warning about "Reel spec" can be ignored)
reel-cli validate       # now ✓
```

(Phase 9's `normalize` will re-encode videos instead.)

### Checking progress

```bash
reel-cli status          # totals by state, Reels vs Page videos, quota used, upcoming, failed
reel-cli show <id>       # one video in full, incl. Facebook link and every attempt
reel-cli validate        # what is publishable right now
tail -f logs/publisher.log   # JSON log of every operation (tokens are redacted)
```

In Facebook: **Meta Business Suite → Planner** (scheduled) and **Content** (published, drafts).

### Start over / switch to another folder

To clear everything the tool has scanned and start fresh (your videos, code and Facebook login are not touched):

```bash
rm -f data/reels.db data/reels.db-wal data/reels.db-shm   # the database (all scanned videos and states)
rm -f logs/*.log exports/*                                 # logs and CSV exports
reel-cli init                                              # recreate the database
reel-cli facebook pages --select <page id>                 # re-select your Page (uses the stored login, no browser)
reel-cli scan "/path/to/new/folder"
```

Do this only when nothing is half-way through publishing (`reel-cli status`: no UPLOADING/FINISHING/PROCESSING). Videos already scheduled on Facebook stay scheduled there.

### Updating the tool

```bash
git pull
npm install
npm run build            # database migrations are applied automatically on the next command
```

---

## Safety: why nothing is posted twice

- **Content identity**: videos are tracked by SHA-256; a file that changed since the scan is refused at publish time.
- **Save before send**: Facebook's `video_id` is stored before any bytes are uploaded, and the state becomes `FINISHING` before the final "make it public/scheduled" call.
- **Unknown outcome is never retried blindly**: if that final call times out or the connection drops, the video stays `FINISHING`; `reconcile` (and the next `publish`) asks Facebook what happened: done → marked done; never arrived → only the final call is sent.
- **Resume, don't restart**: an interrupted Reel upload continues from the byte offset Facebook reports; an interrupted Page video is re-uploaded (nothing is public before the final call).
- **Locks**: a lease per video stops two runs from publishing it at the same time; a crashed run's lease expires after 30 minutes.
- **Errors**: token/permission errors stop the run and leave videos untouched · error **368** ("abusive/disallowed") **pauses all publishing** until `reel-cli resume` · rate limits hold the video for an hour · network errors and 5xx retry 3 times with backoff (5 s, 15 s, 45 s) · invalid requests fail only that video (`reel-cli retry`).
- **Audit trail**: every step (START, TRANSFER, FINISH, VERIFY, RECONCILE) is stored; `reel-cli show <id>` lists them.

---

## Configuration (.env)

All settings are validated at startup (an invalid value names the variable). Real environment variables override `.env`. Missing settings use the defaults below.

| Setting                                                          | Default                             | Meaning                                                                          |
| ---------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`                        | –                                   | Your Meta app (required for login/verify/publish)                                |
| `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_ACCESS_TOKEN`                | –                                   | Optional override of the keychain login (both must be set). Leave empty normally |
| `FACEBOOK_OAUTH_PORT`                                            | `8585`                              | Local port for the browser login callback                                        |
| `GRAPH_API_VERSION`                                              | `v26.0`                             | Graph API version                                                                |
| `TIMEZONE`                                                       | `Asia/Kolkata`                      | Time zone for CSV dates, slots and output                                        |
| `QUOTA_PER_24H`                                                  | `25`                                | Max Reels per rolling 24 h (Meta allows 30); applies inside `DAILY_UPLOAD_LIMIT` |
| `REEL_MAX_DURATION_S`                                            | `90`                                | Longer videos become Page videos. Run `reel-cli recheck` after changing          |
| `REEL_SLOTS` / `VIDEO_SLOTS`                                     | `09:00,14:00,20:00` / `12:00,18:00` | Default daily times for `reel-cli schedule` (`none` disables)                    |
| `MAX_RETRIES`                                                    | `3`                                 | Retries for transient errors per upload step                                     |
| `DAILY_UPLOAD_LIMIT`                                             | `25`                                | Uploads of any kind per rolling 24 h (Facebook anti-spam)                        |
| `MIN_UPLOAD_GAP_SECONDS`                                         | `120`                               | Minimum seconds between two uploads                                              |
| `PUBLISH_CONCURRENCY`                                            | `1`                                 | Videos uploaded in parallel by `publish` (1–5); keep 1 to avoid bursts           |
| `DATABASE_URL`                                                   | `./data/reels.db`                   | SQLite database location                                                         |
| `LOG_LEVEL`                                                      | `info`                              | `fatal` … `trace`                                                                |
| `OLLAMA_*`, `WHISPER_*`, `AI_PROVIDER`, `TRANSCRIPTION_PROVIDER` | see `.env.example`                  | For Phase 5 (AI captions)                                                        |

---

## Troubleshooting

| Problem                                                                     | Fix                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reel-cli: Permission denied`                                               | Rebuild: `npm run build` (it restores the executable bit). If it persists: `chmod +x dist/cli/index.js`.                                                                                                            |
| `reel-cli: command not found`                                               | Run `npm link` in the project folder, or use `npm run reel-cli -- <command>`.                                                                                                                                       |
| Browser shows **"Invalid Scopes: pages_show_list, …"**                      | The app lacks the Page permissions. Add the **Manage everything on your Page** use case and click **Add** for the 3 permissions; if that use case can't be added, create a new app with it (see setup).             |
| `FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set`                       | Fill them in `.env` (App settings → Basic).                                                                                                                                                                         |
| `facebook verify` says **"Cannot parse access token"** / uses `.env`        | `FACEBOOK_PAGE_ID` + `FACEBOOK_PAGE_ACCESS_TOKEN` in `.env` override the login. Empty both lines.                                                                                                                   |
| `No Facebook Page connected`                                                | `reel-cli facebook login`, or after a reset `reel-cli facebook pages --select <id>`.                                                                                                                                |
| `Port 8585 is already in use`                                               | `reel-cli facebook login --port 8600` (or set `FACEBOOK_OAUTH_PORT`).                                                                                                                                               |
| Import: **"already submitted to Facebook"** and nothing saved               | A row that is DRAFT/SCHEDULED/PUBLISHED was edited. Restore that row as exported (or re-export) and import again.                                                                                                   |
| Import: **"Record changed since this CSV was exported"**                    | Re-export after `recheck`/`publish`/`scan`, redo the edits (or `--force` for rows not yet sent).                                                                                                                    |
| Import: `Invalid scheduled_at`                                              | Use `YYYY-MM-DD HH:mm`; format the column as _Text_ so the spreadsheet doesn't rewrite dates.                                                                                                                       |
| Import succeeds but the change isn't there                                  | Save the CSV in the spreadsheet first, then import (without `--dry-run`).                                                                                                                                           |
| Publish: **"caption is empty"**                                             | Every video needs a caption (also drafts).                                                                                                                                                                          |
| Publish: **"scheduled_at is in the past or less than 10 minutes away"**     | Facebook needs ≥ 10 minutes' notice. Move the time, or use `POST_NOW`.                                                                                                                                              |
| Publish: `Not a terminal: add --yes`                                        | Non-interactive runs (cron, scripts) need `--yes`.                                                                                                                                                                  |
| Videos `HELD` with "daily upload limit reached" / "Reels 24h quota reached" | Expected: run `reel-cli publish` again the next day (or schedule fewer videos per day).                                                                                                                             |
| **Error 368/1390008**, "blocked … going too fast", publishing PAUSED        | Facebook's anti-spam block. **Wait at least 24 h** (don't retry in between), check Meta Business Suite for warnings, then `reel-cli resume` and publish in small batches (the default limits: 25/day, 120 s apart). |
| **"Publishing is paused (Facebook error 368)"** (other sub-codes)           | Facebook flagged an action as abusive/disallowed. Check the Page in Meta Business Suite (notifications, Page quality), then `reel-cli resume`.                                                                      |
| A video is `FINISHING` / result "unknown"                                   | Run `reel-cli reconcile`. It asks Facebook and never re-posts.                                                                                                                                                      |
| Scheduled videos stay `PROCESSING` after `publish`                          | Normal: they are already on Facebook. `reel-cli reconcile` a few minutes later marks them `SCHEDULED`.                                                                                                              |
| Publishing is slow                                                          | By design: 1 upload at a time, 120 s apart, max 25/day (Facebook blocks bursts). The videos still post at their scheduled times. Lower `MIN_UPLOAD_GAP_SECONDS` only with care.                                     |
| A video is `FAILED`                                                         | `reel-cli show <id>` shows why. Fix it, then `reel-cli retry --ids <id>` and `publish`.                                                                                                                             |
| `doctor`: Ollama / whisper warnings                                         | Only needed for AI captions (Phase 5); ignore for now.                                                                                                                                                              |

---

## Known limitations

- **No background worker yet** (Phase 8): run `reel-cli publish` daily (or via cron) to submit held videos.
- **No AI captions yet** (Phase 5): captions come from the CSV.
- **No re-encoding yet** (Phase 9): most videos are VP9/AV1 with HE-AAC 44.1 kHz audio. Facebook accepts them (verified with a real draft), but H.264/AAC 48 kHz is recommended.
- A **draft cannot be published without re-uploading** it (or publish it by hand in Business Suite).
- An interrupted **Page video** upload restarts from zero (Facebook's chunk sessions can't be resumed later).
- The Reels API limit of 90 s comes from Meta's docs. Whether longer Reels work through the API is unverified (docs/facebook-api.md, Q7), so longer videos are posted as Page videos.

---

## Data and privacy

- `data/reels.db`: SQLite, the source of truth (`videos`, `publish_attempts`, `app_state`).
- `logs/publisher.log`: JSON logs; tokens and secrets are redacted.
- The Facebook Page token lives in the **OS keychain** (service `reel-cli`), never in the database, CSVs or logs.
- Not committed to git: `.env`, `data/`, `logs/`, `exports/`, `videos/`, `config/page-profile.yaml`, `dist/`, `coverage/`, `node_modules/`.

---

## Development

```bash
npm run check          # typecheck + lint + format check + tests (run before every commit)
npm test               # vitest: unit, integration, e2e
npm run test:coverage  # coverage report (coverage/index.html)
npm run lint:fix       # eslint --fix
npm run format         # prettier --write
npm run build          # compile to dist/ (keeps the CLI executable)
npm run reel-cli -- status   # run from source via tsx
npm run db:generate    # after editing src/db/schema.ts: generate a migration into drizzle/
```

Tooling: TypeScript 6 (strict), ESLint (`typescript-eslint` strict, type-checked), Prettier, Vitest + V8 coverage. Tests never call the real Facebook API: they use stateful fakes of the Graph API and upload flows (crash, network-drop and rate-limit scenarios included). Tests that need ffmpeg are skipped automatically without it.

### Project structure

```
src/
├── cli/                 # Commander entry point + one file per command (parsing and output only)
│   ├── index.ts
│   ├── context.ts       # workspace config, paths, logger, withDb(), token store
│   └── commands/
├── config/              # .env parsing (Zod) and workspace paths
├── db/                  # Drizzle schema, client (migrations, transactions), repositories
├── domain/              # pure types and rules: states, transitions, media types
├── content/             # hashtags, description building
├── media/               # ffprobe, Reel/Page-video spec checks, publish target, recheck
├── scanner/             # directory walk, file identity (SHA-256), scan service
├── csv/                 # CSV contract, export, import (plan + apply)
├── scheduling/          # slot parsing, planner, quota, windows, schedule service
├── validation/          # pre-publish validation
├── facebook/            # Graph client, errors, browser login, token store, upload APIs
├── publisher/           # publish decisions, remote status, leases, attempts, publisher, publish run
├── status/              # status report
├── doctor/              # environment checks
└── utils/               # dates, errors, logger, time, open-url, package root
tests/
├── unit/                # pure functions
├── integration/         # real SQLite (and ffmpeg), in-process commands, fake Facebook
├── e2e/                 # the real CLI binary: exit codes, stdout/stderr
├── fixtures/            # factories, fake Graph API / upload flows, recorded ffprobe output
└── helpers.ts
drizzle/                 # generated SQL migrations (committed)
docs/                    # plan, Facebook API notes, archived raw plan
config/                  # page-profile.example.yaml
```

Rules of thumb: commands only parse input and print; business logic lives in services that take a `Db` and plain options; `domain/` has no I/O; every external input (env, CSV, ffprobe, Graph API) is validated.
