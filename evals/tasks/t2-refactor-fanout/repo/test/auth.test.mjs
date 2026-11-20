import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {authenticate} from '../src/modules/auth.mjs';

describe('auth', () => {
  it('authenticates user with token', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(authenticate('alice', 'tok'), true);
      assert.deepEqual(entries, [{level: 'info', message: 'Authenticated user alice'}]);
    } finally {
      stop();
    }
  });
});
