# reel-cli: Facebook Reel Publisher

A local-first CLI that scans a folder of videos, generates captions with a local LLM, lets you review everything in a CSV, and publishes or schedules them to a Facebook Page through the **official Graph API**: videos up to 90 s as **Reels**, longer ones as regular **Page videos**. It is designed never to publish the same video twice.

Full design: [`docs/plan.md`](docs/plan.md). Facebook API notes: [`docs/facebook-api.md`](docs/facebook-api.md).

## Status

| Phase | Scope                                                                             | State                                                      |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0     | Facebook test via curl                                                            | **waiting on Meta app setup** (see `docs/facebook-api.md`) |
| 1     | Foundation: CLI, config, logging, SQLite + migrations, `init`, `doctor`, `status` | ✅ done                                                    |
| 2     | Scanner + ffprobe metadata + Reel spec check                                      | ✅ done                                                    |
| 3     | CSV export/import, validate, show (**MVP complete**)                              | ✅ done                                                    |
| 4     | Schedule planner                                                                  | ✅ done                                                    |
| 5     | AI captions (whisper + Ollama)                                                    | next                                                       |
| 6     | Facebook auth: browser login, keychain storage, verify                            | ✅ done (early)                                            |
| 7     | Publisher: Reels + Page videos, publish/reconcile/retry/resume                    | ✅ done (live Facebook test pending)                       |
| 8     | Worker                                                                            |                                                            |
| 9     | Hardening, normalize                                                              |                                                            |

## Requirements

- Node.js ≥ 20.5
- ffmpeg + ffprobe on `PATH`
- Ollama (for caption generation, Phase 5)
- whisper.cpp (for transcription, Phase 5)

## Setup

```bash
npm install
npm run build
npm link            # makes `reel-cli` available globally (optional)

reel-cli init       # creates videos/, data/, exports/, logs/, config/, .env, database
reel-cli doctor     # checks everything is in place
```

Without `npm link`, use `node dist/cli/index.js <command>` or `npm run reel-cli -- <command>` (runs from source).

The **workspace** is the directory you run `reel-cli` in: `.env`, `data/reels.db`, `logs/`, `exports/` and `videos/` are resolved relative to it.

## Commands (implemented so far)

| Command                                                            | Description                                                                                                                                                       |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reel-cli init`                                                    | Create workspace folders, `.env` and `config/page-profile.yaml` from templates, and the database. Safe to rerun: never overwrites existing files.                 |
| `reel-cli doctor`                                                  | Check Node, config, ffmpeg/ffprobe, database, Ollama + model, whisper, Facebook config. Exit code 1 if a required check fails.                                    |
| `reel-cli scan <dir> [--dry-run]`                                  | Recursively find `.mp4/.mov/.webm/.m4v` files, hash them (SHA-256), read metadata with ffprobe, check them against Meta's Reel specs and add new ones. See below. |
| `reel-cli recheck [--dry-run]`                                     | Recompute each video's publish target (Reel vs Page video) and spec results, e.g. after changing `REEL_MAX_DURATION_S`.                                           |
| `reel-cli schedule [options] [--apply]`                            | Auto-assign `scheduled_at` using daily time slots, separately for Reels and Page videos. Preview unless `--apply`. See below.                                     |
| `reel-cli export [--out file] [--all]`                             | Write videos to `exports/reels.csv` for editing (published reels excluded unless `--all`). The previous file is kept as `.bak`.                                   |
| `reel-cli import <csv> [--dry-run] [--force] [--partial]`          | Validate and apply CSV edits. All-or-nothing by default. Exit code 1 if any row is invalid.                                                                       |
| `reel-cli validate [--ids 1,2,5-8]`                                | Check READY videos (or the given ids) can be published. Exit code 1 on any error.                                                                                 |
| `reel-cli show <id>`                                               | Everything about one video: file, media, spec issues, description, publishing state, attempt history.                                                             |
| `reel-cli publish [--dry-run] [--draft] [--ids] [--limit] [--yes]` | Upload READY videos: POST_NOW now, SCHEDULE natively on Facebook. Shows the plan and asks for confirmation. See below.                                            |
| `reel-cli reconcile`                                               | Ask Facebook about videos whose outcome is pending or unknown. Never re-posts.                                                                                    |
| `reel-cli retry [--ids] [--drafts]`                                | Make FAILED (and DRAFT) videos publishable again.                                                                                                                 |
| `reel-cli resume`                                                  | Resume publishing after Facebook error 368 paused it.                                                                                                             |
| `reel-cli facebook login`                                          | Log in through your browser (official Facebook Login) and store the Page token in the OS keychain. See below.                                                     |
| `reel-cli facebook pages [--select id]`                            | List the Pages you manage or switch Page.                                                                                                                         |
| `reel-cli facebook verify`                                         | Check that the Page token is valid, never expires, and has the required permissions.                                                                              |
| `reel-cli facebook logout`                                         | Remove stored tokens.                                                                                                                                             |
| `reel-cli status`                                                  | Counts by state, 24h quota usage, upcoming scheduled reels, failures, publishing-paused flag.                                                                     |

## Scanning

```
$ reel-cli scan ./videos
Found:               5
New:                 3
Already tracked:     0
Duplicates:          1
Errors:              1

Reel spec check: 2 OK, 1 with problems
  ✗ #3 videos/landscape.mov
      duration 2.0s < 3s
      aspect ratio 1920x1080 is not 9:16
```

- **Identity = file content.** A video is tracked by its SHA-256, so rescanning never duplicates. Unchanged files (same path, size, mtime) are not re-hashed.
- **Moved/renamed** files (same content, old path gone) keep their record; the path is updated.
- **Duplicates** (same content at two paths) are reported and not added.
- **Missing** tracked files are reported, never deleted from the database.
- **Changed content at a tracked path** is added as a new video and flagged.
- **Unreadable files** are reported; the scan continues and retries them next time.
- Hidden files/folders and symlinks are skipped.

### Publish target: Reel or Page video

Each video gets a `publish_target`:

- **`REEL`** if it is at most `REEL_MAX_DURATION_S` (default 90 s, the Reels API limit): published via the Reels API.
- **`VIDEO`** if it is longer: published as a regular Page video (no 9:16 or length requirement, scheduling up to 6 months ahead, not counted in the Reels quota).

It is chosen automatically by duration. You can pin it in the CSV (`publish_target` column), or leave the cell empty to go back to automatic.

### Reel spec check

Reels are checked against the Meta Reels API requirements: 3–90 s, 9:16, ≥ 540×960, 24–60 fps, H.264/H.265/VP9/AV1, 4:2:0 progressive, AAC audio. Rotation metadata from phones is applied before checking the aspect ratio. **Errors** (e.g. wrong duration or aspect ratio) will block publishing; **warnings** (e.g. 44.1 kHz audio, no audio, variable frame rate) don't. Page videos have lighter checks: a video stream, ≤ 240 min and ≤ 10 GB are required; AV1/VP9 video and non-AAC audio only give warnings. Results are stored per video (`spec_ok`, `spec_issues`).

## Editing via CSV

```bash
reel-cli export                             # → exports/reels.csv
# edit in LibreOffice / Excel / Google Sheets, save as CSV (UTF-8)
reel-cli import exports/reels.csv --dry-run # see exactly what will change
reel-cli import exports/reels.csv
reel-cli validate
```

| Column                                                     | Editable  | Notes                                                                                                               |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`, `version`                                            | no (keys) | `version` detects stale CSVs                                                                                        |
| `filename`, `duration_s`, `spec_ok`, `state`, `last_error` | no        | for information; ignored on import                                                                                  |
| `caption`                                                  | yes       | multi-line, Hindi and emoji all fine                                                                                |
| `hashtags`                                                 | yes       | `#drama #reels`, commas also accepted; `#` added if missing; duplicates removed                                     |
| `publish_target`                                           | yes       | `REEL`, `VIDEO`, or empty = automatic by duration. `REEL` is rejected for videos over the Reel limit                |
| `title`                                                    | yes       | optional                                                                                                            |
| `action`                                                   | yes       | `POST_NOW`, `SCHEDULE`, `SKIP` or empty                                                                             |
| `scheduled_at`                                             | yes       | local time in `TIMEZONE`: `2026-09-27 18:30` (also `27/09/2026 18:30`, or ISO with offset). Required for `SCHEDULE` |
| `is_ai_generated`                                          | yes       | `yes`/`no`; sent to Meta                                                                                            |

Import rules:

- The file is written as UTF-8 **with BOM** so spreadsheet apps show Hindi correctly. If your spreadsheet reformats dates, set the `scheduled_at` column to _Text_.
- **All-or-nothing:** if any row is invalid, nothing is written (`--partial` applies the valid rows only).
- **Stale CSV protection:** if a video changed after you exported (e.g. a rescan moved it), that row is rejected. Re-export, or use `--force` (only for rows not yet sent to Facebook).
- Rows already submitted to Facebook (uploading, scheduled or published) cannot be edited.
- Setting an action moves `NEW → READY`; `SKIP` moves it to `SKIPPED`; clearing the action moves it back to `NEW`. Editing caption, hashtags or title marks the caption as `manual`, so AI generation will not overwrite it.

### Validation

`reel-cli validate` checks each READY video: file exists and is unchanged (hash re-checked if size/mtime differ), Reel specs, non-empty caption, valid hashtags, and a schedule at least 10 minutes ahead. Videos scheduled more than 29 days ahead get a warning, because the local worker must hand them to Facebook later. It also checks for global problems: publishing paused, Facebook not configured, and more videos than the 24h quota allows.

## Scheduling

```bash
reel-cli schedule --start 2026-09-27                    # preview with default slots
reel-cli schedule --start 2026-09-27 --apply            # save it
reel-cli schedule --reel-slots 08:00,13:00,19:00 --video-slots 11:00,17:00 --days 14 --apply
reel-cli schedule --clear --apply                       # remove schedules (not yet submitted videos only)
```

- Reels and Page videos each fill their own daily slots (`REEL_SLOTS`, `VIDEO_SLOTS` in `.env`, or `--reel-slots` / `--video-slots`; `none` skips a target).
- Only videos that are NEW/READY/HELD, pass their spec check, and have no schedule yet are planned. `--reset` re-plans existing schedules; POST_NOW, SKIP, failed and submitted videos are never touched.
- Slots less than 10 minutes away, or already taken by another video of the same target, are skipped.
- Reels never exceed `QUOTA_PER_24H` in any rolling 24 h window (existing schedules included). Page videos are not quota-limited.
- `--order filename` (natural: `Video_9` before `Video_10`; the default), `id`, `duration`, or `random --seed N` (reproducible).
- `--days N` plans only N days ahead; `--limit N` caps videos per target; `--target reel|video`, `--ids` narrow the scope.
- The whole plan is saved in one transaction; if a video changed since planning, nothing is saved.
- Reels scheduled more than 29 days ahead (Page videos: 6 months) are kept locally and handed to Facebook by `reel-cli worker` when they come within range.

## Connecting Facebook

One-time setup (details in [`docs/facebook-api.md`](docs/facebook-api.md)):

1. Create a Meta app, add the **Facebook Login** product, and keep the app in **Development** mode (Meta then allows the `http://localhost` login redirect automatically; nothing to register).
2. Put `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` in `.env`.

Then:

```bash
reel-cli facebook login    # browser opens → log in → approve → pick your Page
reel-cli facebook verify
```

The Page token (no expiry) is stored in the OS keychain, never in files you commit, CSVs or logs. Posting via browser session cookies is intentionally not supported (against Meta's terms; risks Page restrictions).

## Publishing

```bash
reel-cli publish --dry-run                 # the plan: publish now / schedule / hold / not publishable
reel-cli publish --ids 219 --draft         # first test: a private draft (see it in Meta Business Suite)
reel-cli publish                           # real run; asks "Publish/schedule N video(s) on "Page"? [y/N]"
reel-cli publish --limit 5 --target reel   # a few at a time
reel-cli reconcile                         # settle anything still processing or unknown
```

How a video is published:

- **Reels** (≤ 90 s): `POST /{page}/video_reels` start → upload bytes to `rupload.facebook.com` → finish with `PUBLISHED`, `SCHEDULED` (10 min to 29 days ahead) or `DRAFT` → poll status until Facebook finishes processing.
- **Page videos** (longer): chunked upload on `graph-video.facebook.com/{page}/videos` → finish with `published=true`, or scheduled up to 6 months ahead.
- Scheduled videos beyond Facebook's window are **held** locally (state HELD) and submitted later.
- Reels never exceed `QUOTA_PER_24H` per rolling 24 h. Over-quota Reels are held until a slot frees up. Page videos are not counted.

Safety (no double posts):

- The file is re-hashed before upload; a changed file is refused.
- Facebook's `video_id` is saved **before** any bytes are sent, and the state is `FINISHING` **before** the final call. If that call's result is unknown (crash, timeout), it is never resent: `reconcile` asks Facebook what happened.
- A crashed upload resumes: Reels continue from the byte offset Facebook reports; Page videos re-upload (their upload sessions can't be resumed, and nothing is public before finish).
- Lease locks stop two runs from publishing the same video.
- Error handling: token or permission errors stop the run and leave videos untouched. Error 368 **pauses** all publishing (`reel-cli resume` after review). Rate limits hold videos for an hour. Network errors and 5xx retry with backoff (5 s / 15 s / 45 s, `MAX_RETRIES`). Invalid requests fail only that video (`reel-cli retry`).
- Every step is recorded: `reel-cli show <id>` lists the attempt history.

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example)) and are validated at startup; an invalid value names the variable. Real environment variables override `.env`.

Key settings: `TIMEZONE` (default `Asia/Kolkata`; CSV dates are in this zone), `QUOTA_PER_24H` (default 25, a margin below Meta's 30), `GRAPH_API_VERSION` (default `v26.0`).

## Data

- `data/reels.db`: SQLite, the source of truth. Tables: `videos`, `publish_attempts` (history of every publish step), `app_state`.
- `logs/publisher.log`: JSON logs. Tokens and secrets are redacted automatically.
- Tokens are never stored in CSV, the database or logs.

## Development

```bash
npm run check          # typecheck + lint + format check + tests (run before every commit)
npm test               # vitest (unit, integration, e2e)
npm run test:coverage  # coverage report (text + coverage/index.html)
npm run lint:fix       # eslint --fix
npm run format         # prettier --write
npm run reel-cli -- status   # run the CLI from source via tsx
npm run db:generate    # after editing src/db/schema.ts: generate a migration into drizzle/
```

Tooling: TypeScript 6 (strict, no unused locals/params), ESLint (`typescript-eslint` strict, type-checked), Prettier, Vitest + V8 coverage. Integration and e2e tests that need ffmpeg are skipped automatically if it is not installed.

### Project structure

```
src/
├── cli/                 # Commander entry point + one file per command (parsing and output only)
│   ├── index.ts
│   ├── context.ts       # workspace config, paths, logger, withDb()
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
├── status/              # status report
├── doctor/              # environment checks
└── utils/               # dates, errors, logger, time, package root
tests/
├── unit/                # pure functions
├── integration/         # real SQLite (and real ffmpeg where needed), in-process commands
├── e2e/                 # the real CLI binary: exit codes, stdout/stderr
├── fixtures/            # factories, recorded ffprobe output
└── helpers.ts
drizzle/                 # generated SQL migrations (committed)
docs/                    # plan, Facebook API notes, archived raw plan
config/                  # page-profile.example.yaml (the real page-profile.yaml is gitignored)
```

Rules of thumb: commands only parse input and print; business logic lives in services that take a `Db` and plain options (easy to test); `domain/` has no I/O; every external input (env, CSV, ffprobe, later Graph API and LLM output) is validated.

### What is not committed

`.env`, `data/` (the database), `logs/`, `exports/`, `videos/`, `config/page-profile.yaml`, `dist/`, `coverage/`, `node_modules/` (see `.gitignore`).
