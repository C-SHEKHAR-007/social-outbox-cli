# Changelog

All notable changes, newest first. Dates are commit dates.

## Unreleased: Instagram (branch `feature/instagram`)

- **Instagram Reels** via the Instagram API with Facebook Login: `instagram connect`, `instagram status`, `instagram plan --from-facebook [--offset N]`, `instagram publish`, `instagram retry`, `instagram resume`.
- **`reel-cli worker`**: prepares Instagram posts a few hours ahead and publishes them at their time (Instagram has no native scheduling); one worker per workspace, clean stop on Ctrl+C.
- **Re-encoding for Instagram**: AV1/VP9 and other non-compliant files are converted to H.264/AAC 48 kHz (cached; originals untouched).
- **CSV**: optional `ig_action`, `ig_scheduled_at`, `ig_state` columns.
- New table `platform_posts` (additive migration; Facebook data unchanged), `publish_attempts.platform`.
- Instagram has its own daily limit (`INSTAGRAM_DAILY_LIMIT`), prepare window (`INSTAGRAM_PREPARE_HOURS`) and pause flag.

## 2026-09-28

- Runtime data moved to a git-ignored **`workspace/`** folder when run from the project folder (`REEL_WORKSPACE` overrides); relative paths fall back to the workspace.
- Page-profile template moved to `templates/`; Prettier config merged into `package.json`.

## 2026-09-27

- **Daily upload limit for every video** (`DAILY_UPLOAD_LIMIT`, 25), a minimum gap between uploads (`MIN_UPLOAD_GAP_SECONDS`, 120) and one upload at a time by default, after a burst of uploads triggered Facebook's anti-spam block (368/1390008).
- Plain-language explanations for common Facebook errors.
- Parallel uploads (opt-in) and no processing wait for scheduled videos.
- Fixes: Facebook returns `publish_time` as an ISO string; an unfinished upload reports `published: true`; after FINISH a status-read problem never marks a video FAILED.
- **Publisher** (Phase 7): Reels and Page videos, `publish` / `reconcile` / `retry` / `resume`, drafts, idempotent and crash-safe.

## 2026-09-26

- **Facebook browser login** with the Page token in the OS keychain (`facebook login | pages | verify | logout`).
- Lint/format tooling, refactors and end-to-end tests.

## 2026-09-25

- Scanner, ffprobe metadata, Reel/Page-video spec checks, publish targets.
- CSV export/import, `validate`, `show`, slot-based `schedule`.
- Project setup, SQLite schema and migrations, `init`, `doctor`, `status`.
