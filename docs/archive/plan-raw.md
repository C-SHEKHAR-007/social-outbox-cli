> **Archived.** The original raw plan, superseded by [`docs/plan.md`](../plan.md). Kept for history.

# Facebook Reel Automation Tool

## 1. Project Goal

Build a local-first CLI application that manages and publishes Facebook Reels automatically.

The user has a local folder containing ready-to-post video files.

The application must:

1. Scan a local video folder.
2. Track every video without creating duplicates.
3. Store video metadata.
4. Automatically generate captions and hashtags using an AI provider.
5. Export/edit all publishing information through CSV.
6. Allow the user to manually modify captions, hashtags, dates, and publishing actions.
7. Publish Reels to a Facebook Page through Meta's official Graph API.
8. Publish immediately when requested.
9. Schedule publication when a future time is specified and the applicable Meta API supports scheduling.
10. Track publishing status, Facebook IDs, errors, retries, and timestamps.
11. Never accidentally publish the same video twice.
12. Provide a clean CLI interface.

---

# 2. Important Architecture Decision

Use SQLite as the source of truth.

CSV is a human-editable/import/export interface, NOT the primary database.

Architecture:

Local Videos
↓
Scanner
↓
SQLite
↓
AI Content Generator
↓
SQLite
↓
CSV Export
↓
User manually edits CSV
↓
CSV Import
↓
SQLite
↓
Publisher
↓
Meta Graph API
↓
Facebook Page

---

# 3. Technology Stack

Use:

- Node.js
- TypeScript
- SQLite
- Drizzle ORM or Prisma
- Commander.js for CLI
- FFmpeg for video metadata/processing
- Native fetch or Axios for HTTP
- dotenv for environment configuration
- Ollama as the first AI provider
- Meta Graph API for Facebook publishing

Use clean modular TypeScript.

Do NOT build a web UI initially.

The first version must be CLI-first.

---

# 4. Project Structure

Create:

facebook-reel-publisher/
│
├── videos/
│
├── data/
│ └── reels.db
│
├── exports/
│ └── reels.csv
│
├── logs/
│ └── publisher.log
│
├── src/
│ ├── cli/
│ ├── database/
│ ├── scanner/
│ ├── metadata/
│ ├── ai/
│ ├── csv/
│ ├── facebook/
│ ├── scheduler/
│ ├── publisher/
│ └── utils/
│
├── tests/
│
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md

---

# 5. Database Schema

Create a `videos` table.

Required fields:

- id
- filename
- file_path
- file_hash
- file_size
- duration
- width
- height
- format
- caption
- hashtags
- scheduled_at
- action
- status
- facebook_video_id
- facebook_post_id
- uploaded_at
- published_at
- retry_count
- last_error
- created_at
- updated_at

Use a unique constraint/index on `file_hash`.

This is critical.

If the same video is scanned again, the application must not create another record.

---

# 6. Supported Actions

The `action` field should support:

- `POST_NOW`
- `SCHEDULE`
- `SKIP`

The `status` field should support:

- `PENDING`
- `PROCESSING`
- `SCHEDULED`
- `PUBLISHED`
- `FAILED`
- `SKIPPED`

---

# 7. Video Scanner

Command:

```
reel-cli scan ./videos
```

The scanner must:

1. Recursively scan the supplied directory.
2. Detect supported video files.
3. Initially support:

   - mp4
   - mov
   - webm
   - m4v

4. Calculate SHA-256 file hash.
5. Extract:

   - filename
   - file size
   - duration
   - width
   - height
   - format

6. Check whether the hash already exists.
7. Insert only new videos.
8. Print a summary.

Example:

```
Scanning ./videos...

Found: 120 videos
New: 117
Already tracked: 3
```

---

# 8. FFmpeg

Use FFmpeg/ffprobe.

Do not manually parse video binary files.

Use ffprobe to obtain:

- duration
- width
- height
- codec
- format
- bitrate if available

Create a reusable metadata service.

The application should check whether FFmpeg/ffprobe is installed and provide a clear error if missing.

---

# 9. AI Content Generation

Create an abstraction:

```
AIProvider
```

The first implementation should be:

```
OllamaProvider
```

Configuration:

```
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b
```

The AI service should generate:

- caption
- hashtags

Input should include available information such as:

- filename
- video transcript if available
- video metadata

Do NOT send the binary video to Ollama unless the selected model actually supports video input.

For the first implementation:

Video
↓
Extract audio using FFmpeg
↓
Speech-to-text
↓
Transcript
↓
Ollama
↓
Caption + hashtags

Create the speech-to-text layer as an abstraction too.

Example:

```
TranscriptionProvider
```

This will allow Whisper/local transcription to be added.

---

# 10. AI Output Format

Force the LLM to return structured JSON.

Example:

{
"caption": "Some stories stay with you long after the episode ends...",
"hashtags": [
"#drama",
"#hindidrama",
"#reels",
"#story",
"#entertainment"
]
}

Validate the response before saving it.

Do not blindly save malformed LLM output.

---

# 11. CSV Export

Command:

```
reel-cli export
```

Generate:

```
exports/reels.csv
```

CSV columns:

```
id
filename
video_path
file_hash
duration
width
height
caption
hashtags
scheduled_at
action
status
facebook_video_id
facebook_post_id
uploaded_at
published_at
retry_count
last_error
created_at
updated_at
```

For hashtags, use a readable format such as:

```
#drama #reels #story #viral
```

---

# 12. CSV Import

Command:

```
reel-cli import exports/reels.csv
```

The import process must:

1. Validate columns.
2. Validate IDs.
3. Validate dates.
4. Validate action values.
5. Update existing database records.
6. Never overwrite Facebook IDs or successful publishing information incorrectly.
7. Display validation errors clearly.
8. Support dry-run.

Example:

```
reel-cli import exports/reels.csv --dry-run
```

Output:

```
117 records found
113 valid
4 invalid

Row 17:
  Invalid action: SEND_NOW

Row 38:
  Invalid scheduled_at
```

Nothing changed.

---

# 13. Manual Editing Workflow

Expected workflow:

```
reel-cli scan ./videos

reel-cli generate

reel-cli export
```

User edits:

```
exports/reels.csv
```

Then:

```
reel-cli import exports/reels.csv
```

Then:

```
reel-cli validate
```

Then:

```
reel-cli publish
```

---

# 14. Validation

Command:

```
reel-cli validate
```

Check:

- File exists
- File hash matches
- Caption exists
- Hashtags are valid
- Action is valid
- scheduled_at is valid
- Scheduled videos have a future date
- Facebook configuration exists when publishing
- Video meets Facebook publishing requirements where those requirements are known

Example:

```
✓ reel001.mp4
✓ caption
✓ hashtags
✓ schedule
✓ action

✗ reel008.mp4
  File does not exist
```

---

# 15. Facebook Integration

Use Meta's official Graph API.

Do NOT use:

- Selenium
- Playwright browser automation
- Facebook UI scraping
- fake browser requests
- credential scraping

Create a dedicated module:

```
src/facebook/
```

Suggested services:

```
FacebookAuthService
FacebookPageService
FacebookReelService
```

The Facebook integration must use environment variables/secrets.

Never store access tokens in CSV.

Never commit tokens to Git.

---

# 16. Environment Configuration

Create `.env.example`:

```
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_ACCESS_TOKEN=

GRAPH_API_VERSION=

AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:8b

DATABASE_URL=./data/reels.db
```

Never commit `.env`.

---

# 17. Facebook Authentication

Implement Facebook authentication as a separate phase.

The application should eventually support:

```
reel-cli facebook login
```

The user should be able to configure/select the Facebook Page.

Store only the required token securely.

Prefer OS keychain/keyring storage for long-lived credentials where practical.

Do not print tokens in logs.

---

# 18. Facebook Publishing

Command:

```
reel-cli publish
```

The publisher should:

1. Load eligible records.
2. Validate them.
3. Check status.
4. Lock the record.
5. Upload/publish through Meta's official API.
6. Save Facebook IDs.
7. Update status.
8. Save timestamps.
9. Save API errors.
10. Retry transient failures.

Never publish records with:

```
status = PUBLISHED
```

Never publish the same file twice.

---

# 19. POST_NOW

For:

```
action = POST_NOW
```

publish immediately through the supported Meta API Reel publishing flow.

Update:

```
status = PUBLISHED
```

after successful publication.

Store:

```
facebook_video_id
facebook_post_id
published_at
```

Only mark it as published after the API confirms success.

---

# 20. Scheduled Publishing

For:

```
action = SCHEDULE
```

the application must distinguish between:

1. Scheduling supported directly by Meta's API.
2. Scheduling performed by the local worker.

Do NOT assume the API supports a particular scheduling parameter.

Verify the current Meta Graph API documentation for the configured API version before implementation.

If Meta supports native scheduling for the applicable Reel publishing endpoint, use it.

Otherwise implement a local scheduler.

---

# 21. Local Scheduler

Command:

```
reel-cli worker
```

The worker should:

1. Run continuously.

2. Check pending scheduled records.

3. Find records where:

   ```
   scheduled_at <= current_time
   ```

4. Publish them.

5. Update status.

6. Retry transient errors.

Default polling interval:

```
30 seconds
```

Allow configuration:

```
WORKER_INTERVAL_SECONDS=30
```

Use timezone-aware timestamps.

Default timezone:

```
Asia/Kolkata
```

Allow:

```
TIMEZONE=Asia/Kolkata
```

---

# 22. Dry Run

Every dangerous operation should support:

```
--dry-run
```

Example:

```
reel-cli publish --dry-run
```

Output:

```
Would publish:
  reel001.mp4

Would schedule:
  reel002.mp4
  Time: 2026-09-27 18:30

Would skip:
  reel003.mp4
```

No Facebook API mutation should happen during dry-run.

---

# 23. Retry System

Transient errors should be retried.

Examples:

- network timeout
- HTTP 5xx
- temporary API failure

Do not endlessly retry permanent errors.

Configuration:

```
MAX_RETRIES=3
```

Use exponential backoff.

Example:

```
attempt 1 → 5 sec
attempt 2 → 15 sec
attempt 3 → 45 sec
```

Store:

```
retry_count
last_error
```

---

# 24. Logging

Use structured logging.

Write to:

```
logs/publisher.log
```

Never log:

- Facebook access tokens
- app secrets
- private credentials

Logs should include:

- timestamp
- operation
- video ID
- filename
- status
- error
- Facebook response ID where safe

---

# 25. CLI Commands

Implement these commands:

```
reel-cli init

reel-cli scan <directory>

reel-cli generate

reel-cli export

reel-cli import <csv>

reel-cli validate

reel-cli publish

reel-cli publish --dry-run

reel-cli worker

reel-cli status

reel-cli retry

reel-cli facebook login

reel-cli facebook pages
```

---

# 26. Status Command

Example:

```
reel-cli status
```

Output:

```
Facebook Reel Publisher
========================

Total:       150
Pending:     112
Scheduled:    21
Published:    14
Failed:        3
Skipped:       0

Upcoming
------------------------
reel089.mp4   18:30
reel090.mp4   20:00

Failed
------------------------
reel071.mp4   API error
reel076.mp4   Upload timeout
```

---

# 27. Idempotency

This is one of the most important requirements.

The application must be safe to run repeatedly.

Example:

```
reel-cli scan ./videos
reel-cli scan ./videos
reel-cli scan ./videos
```

must NOT create duplicates.

Likewise:

```
reel-cli publish
reel-cli publish
```

must NOT publish the same Reel twice.

Use:

- file hash
- database status
- Facebook IDs
- publishing locks
- transaction-safe state transitions

---

# 28. Security

Never:

- commit `.env`
- store tokens in CSV
- print access tokens
- expose Facebook credentials
- use browser automation for login
- store passwords

Add:

```
.env
data/
logs/
```

to `.gitignore` where appropriate.

---

# 29. Testing

Write unit tests for:

- video hashing
- duplicate detection
- FFmpeg metadata parsing
- CSV export
- CSV import
- CSV validation
- date parsing
- scheduler selection
- state transitions
- retry logic
- Facebook API response parsing

Mock Facebook API calls.

Do not make real Facebook API calls in automated tests.

---

# 30. Development Phases

Implement in this exact order.

## Phase 1: Project foundation

Create:

- TypeScript project
- CLI
- SQLite
- migrations
- configuration
- logging

Verify:

```
reel-cli --help
```

works.

---

## Phase 2: Scanner

Implement:

```
reel-cli scan ./videos
```

Test with:

- 1 video
- 10 videos
- duplicate files
- nested directories
- unsupported files

---

## Phase 3: FFmpeg

Add:

- duration
- resolution
- codec
- format

---

## Phase 4: CSV

Implement:

```
reel-cli export
```

and:

```
reel-cli import
```

Then:

```
reel-cli validate
```

---

## Phase 5: AI

Implement:

```
reel-cli generate
```

Start with Ollama.

Create provider abstractions so cloud LLM providers can be added later.

---

## Phase 6: Facebook

Before writing publishing code:

Research and verify the CURRENT Meta Graph API documentation for:

- Page authentication
- Page access tokens
- Reel publishing
- video upload
- required permissions
- API version
- scheduling support
- publishing restrictions
- app review requirements

Do not rely on outdated tutorials.

Document the exact API endpoints and permissions used in README.md.

---

## Phase 7: Publishing

Implement:

```
reel-cli publish --dry-run
```

Then real publishing.

---

## Phase 8: Scheduler

Implement:

```
reel-cli worker
```

with:

- timezone handling
- retries
- locking
- graceful shutdown

---

## Phase 9: Reliability

Add:

- retry handling
- idempotency
- structured logging
- error recovery
- transaction safety

---

# 31. First MVP Definition

Do NOT attempt to build everything at once.

The first working MVP should only contain:

```
scan
export
import
validate
status
```

Example:

```
reel-cli scan ./videos
reel-cli generate
reel-cli export
```

User edits CSV.

```
reel-cli import exports/reels.csv
reel-cli validate
```

Only after this works should Facebook publishing be implemented.

---

# 32. Definition of Done

The project is considered successful when this complete workflow works:

```
mkdir videos
```

Copy 100 ready-to-post Reels into `videos/`.

Run:

```
reel-cli scan ./videos
```

Then:

```
reel-cli generate
```

Then:

```
reel-cli export
```

The user opens:

```
exports/reels.csv
```

and can modify:

- caption
- hashtags
- scheduled_at
- action

Then:

```
reel-cli import exports/reels.csv
```

Then:

```
reel-cli validate
```

Then:

```
reel-cli publish
```

For future scheduled posts:

```
reel-cli worker
```

The system must track every Reel from:

```
LOCAL FILE
    ↓
DISCOVERED
    ↓
AI CONTENT
    ↓
CSV
    ↓
USER EDIT
    ↓
VALIDATED
    ↓
FACEBOOK UPLOAD
    ↓
PUBLISHED/SCHEDULED
    ↓
TRACKED
```

---

# 33. Coding Rules

- TypeScript strict mode.
- Small modules.
- No giant files.
- No hard-coded secrets.
- No Facebook browser automation.
- No duplicated business logic.
- Use dependency injection where useful.
- Use typed API responses.
- Validate external input.
- Handle errors explicitly.
- Add tests for important state transitions.
- Write README documentation as features are implemented.
- Do not implement fake Facebook API calls and pretend they work.
- If Meta API behavior is uncertain, research current official documentation and document the limitation.

---

# 34. Agent Execution Instructions

Act as a senior TypeScript engineer.

Implement the project incrementally.

After each phase:

1. Run tests.
2. Run TypeScript compilation.
3. Run the CLI.
4. Fix errors.
5. Update README.
6. Do not move to the next phase until the current phase works.

Do not generate placeholder implementations for critical Facebook functionality.

For Facebook integration, verify the current official Meta API documentation before implementation.

At the end of each phase provide:

- files created
- files changed
- commands executed
- tests passed
- remaining issues

Start with Phase 1.
