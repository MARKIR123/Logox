import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {subscribeLogs} from '../src/logger.mjs';
import {ingestBatch} from '../src/modules/ingest.mjs';

describe('ingest', () => {
  it('ingests batch records', () => {
    const entries = [];
    const stop = subscribeLogs(e => entries.push(e));
    try {
      assert.equal(ingestBatch([1, 2, 3]), 3);
      assert.deepEqual(entries, [{level: 'info', message: 'Ingesting batch of 3 records'}]);
    } finally {
      stop();
    }
  });
});
