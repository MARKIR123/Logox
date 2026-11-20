import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {putCache} from '../src/modules/cache.mjs';

describe('cache', () => {
  it('stores cache key with ttl', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.deepEqual(putCache('user:1', 60), {key: 'user:1', ttlSeconds: 60});
      assert.deepEqual(entries, [{level: 'info', message: 'Stored key (user:1) with ttl=60s'}]);
    } finally {
      stop();
    }
  });
});
