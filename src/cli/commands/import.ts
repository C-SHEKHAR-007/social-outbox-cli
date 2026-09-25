import { existsSync, readFileSync } from 'node:fs';
import { applyImport, planImport, type ImportPlan, type RowRef } from '../../csv/import-service.js';
import { UserError } from '../../utils/errors.js';
import type { AppContext } from '../context.js';

export interface ImportCommandOptions {
  dryRun?: boolean;
  force?: boolean;
  partial?: boolean;
}

/** Returns exit code: 1 if any row is invalid (even when --partial applied the rest). */
export function runImport(
  ctx: AppContext,
  file: string,
  opts: ImportCommandOptions = {},
  now = new Date(),
): { plan: ImportPlan; applied: boolean; code: number } {
  if (!existsSync(file)) throw new UserError(`File not found: ${file}`);
  return ctx.withDb((db) => {
    const plan = planImport(db, readFileSync(file, 'utf8'), {
      timezone: ctx.config.publishing.timezone,
      now,
      force: opts.force ?? false,
      reelMaxDurationS: ctx.config.publishing.reelMaxDurationS,
    });
    render(plan, ctx.print);

    const canApply = plan.errors.length === 0 || opts.partial;
    let applied = false;
    ctx.print();
    if (opts.dryRun) ctx.print('Dry run: nothing changed.');
    else if (!canApply)
      ctx.print('Nothing changed. Fix the rows above (or use --partial to apply only the valid rows).');
    else if (!plan.changes.length) ctx.print('Nothing to change.');
    else {
      applyImport(db, plan.changes);
      applied = true;
      ctx.print(`Updated ${plan.changes.length} video(s).`);
      ctx.logger.info(
        { op: 'import', file, updated: plan.changes.map((c) => ({ id: c.id, fields: c.fields, state: c.toState })) },
        'csv imported',
      );
    }
    return { plan, applied, code: plan.errors.length ? 1 : 0 };
  });
}

const label = (r: RowRef) => `Row ${r.row}${r.id ? ` (#${r.id}${r.filename ? ` ${r.filename}` : ''})` : ''}`;

function render(plan: ImportPlan, print: (line?: string) => void): void {
  const valid = plan.total - plan.errors.length;
  print(`${plan.total} record(s) found`);
  print(`${valid} valid (${plan.changes.length} changed, ${plan.unchanged} unchanged)`);
  print(`${plan.errors.length} invalid`);

  for (const e of plan.errors) {
    print();
    print(`✗ ${label(e)}:`);
    for (const m of e.messages) print(`    ${m}`);
  }
  if (plan.changes.length) {
    print();
    print('Changes:');
    for (const c of plan.changes) {
      const state = c.toState !== c.fromState ? `  [${c.fromState} → ${c.toState}]` : '';
      print(`  ${label(c)}: ${c.fields.join(', ')}${state}`);
    }
  }
  if (plan.warnings.length) {
    print();
    print('Warnings:');
    for (const w of plan.warnings) print(`  ⚠ ${label(w)}: ${w.message}`);
  }
}
