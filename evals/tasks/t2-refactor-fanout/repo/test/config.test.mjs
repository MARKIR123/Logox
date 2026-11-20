import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {loadSettings} from '../src/modules/config.mjs';

describe('config', () => {
  it('loads settings for environment', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.deepEqual(loadSettings('staging'), {env: 'staging'});
      assert.deepEqual(entries, [{level: 'info', message: 'Loaded settings for staging'}]);
    } finally {
      stop();
    }
  });
});
