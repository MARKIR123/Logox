import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {flushMetrics} from '../src/modules/metrics.mjs';

describe('metrics', () => {
  it('flushes metric points', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(flushMetrics([10, 20]), 2);
      assert.deepEqual(entries, [{level: 'info', message: 'Flushed 2 metric points'}]);
    } finally {
      stop();
    }
  });
});
