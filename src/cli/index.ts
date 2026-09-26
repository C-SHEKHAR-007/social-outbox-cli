#!/usr/bin/env node
import { Command } from 'commander';
import { UserError } from '../utils/errors.js';
import { packageVersion } from '../utils/package-root.js';
import { runDoctor } from './commands/doctor.js';
import { runExport } from './commands/export.js';
import { runFacebookLogin, runFacebookLogout, runFacebookPages, runFacebookVerify } from './commands/facebook.js';
import { runImport } from './commands/import.js';
import { runInit } from './commands/init.js';
import { runPublishCommand, runReconcileCommand, runResume, runRetry } from './commands/publish.js';
import { runRecheck } from './commands/recheck.js';
import { runScan } from './commands/scan.js';
import { runSchedule, type ScheduleCommandOptions } from './commands/schedule.js';
import { runShow } from './commands/show.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';
import { createContext } from './context.js';
import { parseIds } from './ids.js';

/** The workspace is the directory the CLI is run from. */
const workspace = () => createContext({ cwd: process.cwd() });

const program = new Command()
  .name('reel-cli')
  .description('Scan, caption, schedule and publish Facebook Reels and Page videos via the official Graph API')
  .version(packageVersion())
  .showHelpAfterError();

program
  .command('init')
  .description('create workspace folders, .env and page profile templates, and the database')
  .action(() => {
    runInit(process.cwd());
  });

program
  .command('doctor')
  .description('check dependencies, configuration, database and credentials')
  .action(async () => {
    process.exitCode = await runDoctor({ cwd: process.cwd() });
  });

program
  .command('scan')
  .argument('<directory>', 'folder containing videos (scanned recursively)')
  .description('find new videos, hash them, read metadata and check specs')
  .option('--dry-run', 'report what would change without saving anything')
  .action(async (directory: string, options: { dryRun?: boolean }) => {
    await runScan(workspace(), directory, { dryRun: options.dryRun, progress: process.stderr.isTTY });
  });

program
  .command('recheck')
  .description(
    'recompute publish target (Reel vs Page video) and spec results, e.g. after changing REEL_MAX_DURATION_S',
  )
  .option('--dry-run', 'report without saving')
  .action((options: { dryRun?: boolean }) => {
    runRecheck(workspace(), options);
  });

program
  .command('schedule')
  .description('auto-assign scheduled_at to unscheduled videos using daily time slots (preview unless --apply)')
  .option('--start <date>', 'first day, YYYY-MM-DD (default: today)')
  .option('--reel-slots <times>', 'daily Reel times, e.g. 09:00,14:00,20:00 (default REEL_SLOTS; "none" to skip)')
  .option('--video-slots <times>', 'daily Page video times (default VIDEO_SLOTS; "none" to skip)')
  .option('--order <order>', 'filename | id | duration | random', 'filename')
  .option('--seed <n>', 'seed for --order random (reproducible)')
  .option('--target <target>', 'reel | video | all', 'all')
  .option('--ids <ids>', 'only these video ids, e.g. 1,2,5-8')
  .option('--days <n>', 'only plan this many days ahead')
  .option('--limit <n>', 'schedule at most n videos per target')
  .option('--reset', 're-plan videos that already have a schedule (not yet submitted)')
  .option('--clear', 'remove schedules instead (not yet submitted videos only)')
  .option('--apply', 'save the plan (otherwise preview only)')
  .action((options: Omit<ScheduleCommandOptions, 'ids'> & { ids?: string }) => {
    runSchedule(workspace(), { ...options, ids: parseIds(options.ids) });
  });

program
  .command('export')
  .description('write videos to a CSV for review/editing (default exports/reels.csv)')
  .option('-o, --out <file>', 'output path')
  .option('--all', 'include already-published videos')
  .action((options: { out?: string; all?: boolean }) => {
    runExport(workspace(), options);
  });

program
  .command('import')
  .argument('<csv>', 'CSV file previously produced by `export`')
  .description('validate and apply edits from a CSV (all-or-nothing)')
  .option('--dry-run', 'show what would change without saving')
  .option('--force', 'overwrite rows changed since export (not-yet-submitted rows only)')
  .option('--partial', 'apply valid rows even if some rows are invalid')
  .action((file: string, options: { dryRun?: boolean; force?: boolean; partial?: boolean }) => {
    process.exitCode = runImport(workspace(), file, options).code;
  });

program
  .command('validate')
  .description('check READY videos (or --ids) are publishable: file, specs, content, schedule')
  .option('--ids <ids>', 'only these video ids, e.g. 1,2,5-8')
  .action(async (options: { ids?: string }) => {
    process.exitCode = (await runValidate(workspace(), { ids: parseIds(options.ids) })).code;
  });

program
  .command('show')
  .argument('<id>', 'video id')
  .description('show everything about one video, including publish attempts')
  .action((id: string) => {
    const [videoId] = parseIds(id) ?? [];
    if (videoId === undefined) throw new UserError('Provide a video id');
    runShow(workspace(), videoId);
  });

program
  .command('status')
  .description('show counts by state and target, quota usage, upcoming and failed videos')
  .action(() => {
    runStatus(workspace());
  });

program
  .command('publish')
  .description('upload READY videos to Facebook: POST_NOW now, SCHEDULE natively (asks for confirmation)')
  .option('--ids <ids>', 'only these video ids, e.g. 1,2,5-8')
  .option('--limit <n>', 'submit at most n videos this run')
  .option('--target <target>', 'reel | video | all', 'all')
  .option('--draft', 'upload as private drafts instead (testing; needs --ids)')
  .option('--dry-run', 'show the plan without sending anything')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--wait <seconds>', 'how long to wait for Facebook processing (default 120)')
  .option('--no-wait', 'do not wait for processing (reconcile picks it up later)')
  .action(
    async (options: {
      ids?: string;
      limit?: string;
      target?: string;
      draft?: boolean;
      dryRun?: boolean;
      yes?: boolean;
      wait?: string | false;
    }) => {
      process.exitCode = (await runPublishCommand(workspace(), { ...options, ids: parseIds(options.ids) })).code;
    },
  );

program
  .command('reconcile')
  .description('ask Facebook about videos whose outcome is pending or unknown (never re-posts)')
  .option('--ids <ids>', 'only these video ids')
  .action(async (options: { ids?: string }) => {
    await runReconcileCommand(workspace(), { ids: parseIds(options.ids) });
  });

program
  .command('retry')
  .description('make FAILED videos (and with --drafts, DRAFT videos) publishable again')
  .option('--ids <ids>', 'only these video ids')
  .option('--drafts', 'also reset videos uploaded as drafts')
  .option('--dry-run', 'show what would be reset')
  .action((options: { ids?: string; drafts?: boolean; dryRun?: boolean }) => {
    runRetry(workspace(), { ...options, ids: parseIds(options.ids) });
  });

program
  .command('resume')
  .description('resume publishing after it was paused by Facebook error 368')
  .action(() => {
    runResume(workspace());
  });

const facebook = program.command('facebook').description('connect a Facebook Page (official browser login)');

facebook
  .command('login')
  .description('log in through your browser and save the Page token to the OS keychain')
  .option('--page <id>', 'Page to use when you manage several')
  .option('--port <port>', 'local callback port (default FACEBOOK_OAUTH_PORT, 8585)')
  .option('--no-browser', 'print the login URL instead of opening a browser')
  .action(async (options: { page?: string; port?: string; browser?: boolean }) => {
    await runFacebookLogin(workspace(), options);
  });

facebook
  .command('pages')
  .description('list the Pages you manage, or switch with --select')
  .option('--select <id>', 'publish to this Page from now on')
  .action(async (options: { select?: string }) => {
    await runFacebookPages(workspace(), options);
  });

facebook
  .command('verify')
  .description('check the Page token is valid and has the required permissions')
  .action(async () => {
    process.exitCode = (await runFacebookVerify(workspace())).code;
  });

facebook
  .command('logout')
  .description('remove stored Facebook tokens')
  .action(() => {
    runFacebookLogout(workspace());
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof UserError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
});
