import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {enqueueJob} from '../src/modules/queue.mjs';

describe('queue', () => {
  it('enqueues normal job', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(enqueueJob('j-9', 10), 'j-9');
      assert.deepEqual(entries, [{level: 'info', message: 'Enqueued job j-9'}]);
    } finally {
      stop();
    }
  });
});
