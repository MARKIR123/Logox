import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {runTick} from '../src/modules/scheduler.mjs';

describe('scheduler', () => {
  it('advances scheduler tick', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(runTick(4), 5);
      assert.deepEqual(entries, [{level: 'info', message: 'Scheduler tick 4'}]);
    } finally {
      stop();
    }
  });
});
