import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../../src/config/env.js';
import { resolvePaths } from '../../src/config/paths.js';
import { ConfigError } from '../../src/utils/errors.js';
import { makeTempDir } from '../helpers.js';

describe('parseConfig', () => {
  it('applies defaults for an empty environment', () => {
    const c = parseConfig({});
    expect(c.facebook.graphApiVersion).toBe('v26.0');
    expect(c.publishing).toEqual({
      quotaPer24h: 25,
      reelMaxDurationS: 90,
      slots: { REEL: ['09:00', '14:00', '20:00'], VIDEO: ['12:00', '18:00'] },
      maxRetries: 3,
      workerIntervalSeconds: 30,
      timezone: 'Asia/Kolkata',
    });
    expect(c.ai.ollamaModel).toBe('qwen3:8b');
    expect(c.databaseUrl).toBe('./data/reels.db');
  });

  it('treats empty strings as unset', () => {
    const c = parseConfig({ FACEBOOK_APP_ID: '', FACEBOOK_PAGE_ID: '  ', QUOTA_PER_24H: '' });
    expect(c.facebook.appId).toBeUndefined();
    expect(c.facebook.pageId).toBeUndefined();
    expect(c.publishing.quotaPer24h).toBe(25);
  });

  it('parses slot lists and "none"', () => {
    const c = parseConfig({ REEL_SLOTS: '20:00, 9:30', VIDEO_SLOTS: 'none' });
    expect(c.publishing.slots).toEqual({ REEL: ['09:30', '20:00'], VIDEO: [] });
  });

  it('coerces numbers and strips trailing slash from Ollama URL', () => {
    const c = parseConfig({ QUOTA_PER_24H: '10', OLLAMA_BASE_URL: 'http://host:11434/' });
    expect(c.publishing.quotaPer24h).toBe(10);
    expect(c.ai.ollamaBaseUrl).toBe('http://host:11434');
  });

  it.each([
    [{ TIMEZONE: 'Mars/Olympus' }, 'TIMEZONE'],
    [{ QUOTA_PER_24H: '31' }, 'QUOTA_PER_24H'],
    [{ QUOTA_PER_24H: 'abc' }, 'QUOTA_PER_24H'],
    [{ GRAPH_API_VERSION: '26' }, 'GRAPH_API_VERSION'],
    [{ FACEBOOK_PAGE_ID: 'my-page' }, 'FACEBOOK_PAGE_ID'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    [{ REEL_SLOTS: '9am' }, 'REEL_SLOTS'],
    [{ VIDEO_SLOTS: '25:00' }, 'VIDEO_SLOTS'],
  ])('rejects invalid %o', (env, key) => {
    expect(() => parseConfig(env)).toThrow(ConfigError);
    try {
      parseConfig(env);
    } catch (err) {
      expect((err as ConfigError).issues.join()).toContain(key);
    }
  });
});

describe('loadConfig', () => {
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
  });

  it('reads .env and lets real env vars override it', () => {
    const tmp = makeTempDir();
    cleanup = tmp.cleanup;
    writeFileSync(join(tmp.dir, '.env'), 'OLLAMA_MODEL=llama3\nTIMEZONE=UTC\n');
    const c = loadConfig(tmp.dir, { TIMEZONE: 'Europe/London' });
    expect(c.ai.ollamaModel).toBe('llama3');
    expect(c.publishing.timezone).toBe('Europe/London');
  });
});

describe('resolvePaths', () => {
  it('resolves relative DB path against the workspace root', () => {
    expect(resolvePaths('/w', './data/x.db').db).toBe('/w/data/x.db');
    expect(resolvePaths('/w', '/abs/x.db').db).toBe('/abs/x.db');
    expect(resolvePaths('/w', ':memory:').db).toBe(':memory:');
  });
});
