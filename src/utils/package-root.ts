import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Install root of this package (works from both src/ via tsx and dist/). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}
