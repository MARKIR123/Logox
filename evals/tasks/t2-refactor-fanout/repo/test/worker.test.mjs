import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {processTask} from '../src/modules/worker.mjs';

describe('worker', () => {
  it('processes successful task', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(processTask('t-1', true), true);
      assert.deepEqual(entries, [{level: 'info', message: 'Task completed: t-1'}]);
    } finally {
      stop();
    }
  });
});
