import { execa } from 'execa';

/** Opens `url` in the default browser. Returns false if that was not possible (e.g. headless server). */
export async function openUrl(url: string): Promise<boolean> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = execa(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    await Promise.race([child, new Promise((r) => setTimeout(r, 1500))]);
    return true;
  } catch {
    return false;
  }
}
