import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {saveBlob} from '../src/modules/storage.mjs';

describe('storage', () => {
  it('saves valid blob', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(saveBlob('snap.bin', 256), true);
      assert.deepEqual(entries, [{level: 'info', message: 'Saved blob snap.bin (256 bytes)'}]);
    } finally {
      stop();
    }
  });
});
