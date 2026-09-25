import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('') };
}

describe('logger redaction', () => {
  it('never writes tokens or secrets', () => {
    const out = capture();
    const logger = createLogger({ level: 'info', destination: out.stream });
    logger.info(
      {
        access_token: 'EAAB-secret-1',
        pageAccessToken: 'EAAB-secret-2',
        request: { headers: 'x', access_token: 'EAAB-secret-3', Authorization: 'OAuth EAAB-secret-4' },
        appSecret: 'shh',
        videoId: 42,
      },
      'publishing',
    );
    const text = out.lines();
    expect(text).not.toMatch(/EAAB-secret|shh/);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('"videoId":42');
  });
});
