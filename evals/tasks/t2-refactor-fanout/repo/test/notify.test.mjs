import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {sendAlert} from '../src/modules/notify.mjs';

describe('notify', () => {
  it('warns on initial alert attempt', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.deepEqual(sendAlert(1, 'ops'), {attempt: 1, level: 'warn'});
      assert.deepEqual(entries, [{level: 'warn', message: 'Alert attempt 1 to ops'}]);
    } finally {
      stop();
    }
  });
});
