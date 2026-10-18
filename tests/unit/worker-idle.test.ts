import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { defaultIdle } from '../../src/cli/commands/worker.js';

describe('worker idle', () => {
  it('leaves no abort listener behind after each sleep', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 12; i += 1) await defaultIdle(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('wakes early when the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleep = defaultIdle(60_000, controller.signal);
    controller.abort();
    await sleep;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
