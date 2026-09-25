import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { UserError } from '../utils/errors.js';

export const CALLBACK_PATH = '/callback';

export interface CallbackServer {
  port: number;
  redirectUri: string;
  /** Resolves with the authorization `code` once Facebook redirects back with the right `state`. */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;text-align:center">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Listens on localhost only (both 127.0.0.1 and ::1, since browsers may resolve `localhost` to either).
 * Requests with a wrong `state` are rejected and ignored, so only the browser tab we opened can finish login.
 */
export async function startCallbackServer(opts: {
  port: number;
  state: string;
  timeoutMs: number;
}): Promise<CallbackServer> {
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const result = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => undefined); // handled by waitForCode(); avoid unhandled rejection before it's awaited

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    if (!sameState(state, opts.state)) {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(page('Invalid login request', 'State mismatch. Start again from the terminal.'));
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      const reason =
        url.searchParams.get('error_description') ??
        url.searchParams.get('error_reason') ??
        error ??
        'no code returned';
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(page('Login cancelled', 'You can close this tab and return to the terminal.'));
      settle.reject(new UserError(`Facebook login was not completed: ${reason}`));
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(page('Logged in to reel-cli', 'You can close this tab and return to the terminal.'));
    settle.resolve(code);
  };

  const servers: Server[] = [];
  let port = opts.port;
  for (const host of ['127.0.0.1', '::1']) {
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          resolve();
        });
      });
      port = (server.address() as AddressInfo).port; // first listen may pick a random port (port 0 in tests)
      servers.push(server);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
        throw new UserError(
          `Port ${port} is already in use. Close the other program or use --port / FACEBOOK_OAUTH_PORT.`,
        );
      }
      // e.g. no IPv6 on this machine: one listener is enough
    }
  }
  if (!servers.length) throw new UserError('Could not start the local login callback server.');

  const timer = setTimeout(() => {
    settle.reject(new UserError(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for Facebook login.`));
  }, opts.timeoutMs);
  timer.unref();

  return {
    port,
    redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
    waitForCode: () => result,
    close: async () => {
      clearTimeout(timer);
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => {
                resolve();
              });
            }),
        ),
      );
    },
  };
}
