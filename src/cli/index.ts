#!/usr/bin/env node
import { Command } from 'commander';
import { UserError } from '../utils/errors.js';
import { packageVersion } from '../utils/package-root.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runScan } from './commands/scan.js';
import { runStatus } from './commands/status.js';
import { createContext } from './context.js';

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
  .command('status')
  .description('show counts by state and target, quota usage, upcoming and failed videos')
  .action(() => {
    runStatus(workspace());
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof UserError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
});
