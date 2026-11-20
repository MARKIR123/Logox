import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {routeStatus} from '../src/modules/router.mjs';

describe('router', () => {
  it('logs route status at requested level', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.deepEqual(routeStatus('info', '/health'), {level: 'info', path: '/health'});
      assert.deepEqual(entries, [{level: 'info', message: 'Route /health status'}]);
    } finally {
      stop();
    }
  });
});
