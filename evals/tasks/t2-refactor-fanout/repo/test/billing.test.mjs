import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {chargeInvoice} from '../src/modules/billing.mjs';

describe('billing', () => {
  it('charges positive invoice amount', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.deepEqual(chargeInvoice('inv-1', 500), {ok: true, cents: 500});
      assert.deepEqual(entries, [{level: 'info', message: 'Charged invoice inv-1'}]);
    } finally {
      stop();
    }
  });
});
