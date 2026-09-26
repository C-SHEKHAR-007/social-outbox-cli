import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildLoginUrl, canPublish, missingScopes } from '../../src/facebook/auth-service.js';
import { appSecretProof, FacebookApiError, GraphClient } from '../../src/facebook/graph-client.js';
import { FileTokenStore, MemoryTokenStore } from '../../src/facebook/token-store.js';
import { APP, fakeGraph, PAGE_A, PAGE_RO } from '../fixtures/fake-graph.js';
import { makeTempDir } from '../helpers.js';

/** Resolves with the rejection reason; fails the test if the promise resolves. */
const failure = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as Error,
  );

describe('GraphClient', () => {
  const schema = z.object({ id: z.string() });

  it('builds versioned URLs and sends token + appsecret_proof', async () => {
    const graph = fakeGraph({ me: () => ({ body: { id: '1' } }) });
    const client = new GraphClient({ version: 'v26.0', appSecret: 's3cret', fetch: graph.fetch });
    expect(await client.get('/me', { fields: 'id' }, schema, { token: 'TOKEN' })).toEqual({ id: '1' });
    expect(graph.requests[0]).toMatchObject({
      path: 'me',
      params: { fields: 'id', access_token: 'TOKEN', appsecret_proof: appSecretProof('TOKEN', 's3cret') },
    });
  });

  it('omits appsecret_proof when asked (app token) or when no secret is configured', async () => {
    const graph = fakeGraph({ me: () => ({ body: { id: '1' } }) });
    await new GraphClient({ version: 'v26.0', appSecret: 's', fetch: graph.fetch }).get('me', {}, schema, {
      token: 'a|b',
      noProof: true,
    });
    await new GraphClient({ version: 'v26.0', fetch: graph.fetch }).get('me', {}, schema, { token: 'T' });
    expect(graph.requests.map((r) => r.params.appsecret_proof)).toEqual([undefined, undefined]);
  });

  it('maps Graph error bodies to FacebookApiError with codes', async () => {
    const graph = fakeGraph({
      me: () => ({
        status: 400,
        body: {
          error: {
            message: 'Invalid OAuth access token.',
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            fbtrace_id: 'Abc',
          },
        },
      }),
    });
    const err = await failure(new GraphClient({ version: 'v26.0', fetch: graph.fetch }).get('me', {}, schema));
    expect(err).toBeInstanceOf(FacebookApiError);
    expect((err as FacebookApiError).message).toBe('Invalid OAuth access token.');
    expect((err as FacebookApiError).details).toEqual({
      httpStatus: 400,
      code: 190,
      subcode: 463,
      type: 'OAuthException',
      fbtraceId: 'Abc',
    });
  });

  it('reports network failures and unexpected shapes without leaking tokens', async () => {
    const down = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const netErr = await failure(
      new GraphClient({ version: 'v26.0', fetch: down }).get('me', {}, schema, { token: 'SECRET-TOKEN' }),
    );
    expect(netErr.message).toBe('Network error calling Facebook: ECONNRESET');

    const graph = fakeGraph({ me: () => ({ body: { name: 'no id' } }) });
    const shapeErr = await failure(
      new GraphClient({ version: 'v26.0', fetch: graph.fetch }).get('me', {}, schema, { token: 'SECRET-TOKEN' }),
    );
    expect(shapeErr.message).toMatch(/Unexpected Facebook response for \/v26.0\/me/);
    expect(`${netErr.message} ${shapeErr.message}`).not.toContain('SECRET-TOKEN');
  });
});

describe('auth helpers', () => {
  it('builds the login dialog URL with state, scopes and code flow', () => {
    const url = new URL(buildLoginUrl(APP, 'http://localhost:8585/callback', 'STATE123'));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1111',
      redirect_uri: 'http://localhost:8585/callback',
      state: 'STATE123',
      response_type: 'code',
      scope: 'pages_show_list,pages_read_engagement,pages_manage_posts',
      auth_type: 'rerequest',
    });
    expect(url.toString()).not.toContain(APP.appSecret);
  });

  it('knows which Pages can be published to and which scopes are missing', () => {
    expect(canPublish(PAGE_A)).toBe(true);
    expect(canPublish(PAGE_RO)).toBe(false);
    expect(missingScopes(['pages_show_list'])).toEqual(['pages_read_engagement', 'pages_manage_posts']);
  });
});

describe('token stores', () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
  });

  it('memory store round-trips', () => {
    const s = new MemoryTokenStore();
    s.set('user', 'U');
    expect(s.get('user')).toBe('U');
    s.delete('user');
    expect(s.get('user')).toBeUndefined();
  });

  it('file store keeps tokens in a 0600 file and deletes keys', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const file = join(tmp.dir, 'data', 'credentials.json');
    const s = new FileTokenStore(file);
    expect(s.get('page:1')).toBeUndefined();
    s.set('page:1', 'P1');
    s.set('user', 'U');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    s.delete('user');
    s.delete('user'); // idempotent
    expect(new FileTokenStore(file).get('page:1')).toBe('P1');
    expect(new FileTokenStore(file).get('user')).toBeUndefined();
  });

  it('file store tightens permissions of an existing file', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    const file = join(tmp.dir, 'creds.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    new FileTokenStore(file).set('user', 'U');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
