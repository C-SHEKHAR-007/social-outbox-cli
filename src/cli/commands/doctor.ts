import { runChecks, type CheckResult, type DoctorDeps } from '../../doctor/checks.js';

const ICON: Record<CheckResult['status'], string> = { ok: '✓', warn: '⚠', fail: '✗' };

/** Returns the process exit code: 1 if any check failed. */
export async function runDoctor(deps: DoctorDeps, print: (line?: string) => void = console.log): Promise<number> {
  const results = await runChecks(deps);
  const width = Math.max(...results.map((r) => r.name.length));
  print('reel-cli doctor');
  print();
  for (const r of results) print(`  ${ICON[r.status]} ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  print();
  print(failed ? `${failed} problem(s), ${warned} warning(s).` : `All required checks passed (${warned} warning(s)).`);
  return failed ? 1 : 0;
}
