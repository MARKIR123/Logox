import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const targetDir = process.env.TARGET_WORK_DIR;
if (!targetDir) {
  throw new Error('TARGET_WORK_DIR environment variable is required');
}
const mod = rel => import(pathToFileURL(join(targetDir, rel)).href);

const {logger} = await mod('src/logger.mjs');
const {authenticate} = await mod('src/modules/auth.mjs');
const {chargeInvoice} = await mod('src/modules/billing.mjs');
const {putCache} = await mod('src/modules/cache.mjs');
const {loadSettings} = await mod('src/modules/config.mjs');
const {ingestBatch} = await mod('src/modules/ingest.mjs');
const {flushMetrics} = await mod('src/modules/metrics.mjs');
const {sendAlert} = await mod('src/modules/notify.mjs');
const {enqueueJob} = await mod('src/modules/queue.mjs');
const {routeStatus} = await mod('src/modules/router.mjs');
const {runTick} = await mod('src/modules/scheduler.mjs');
const {saveBlob} = await mod('src/modules/storage.mjs');
const {processTask} = await mod('src/modules/worker.mjs');

function captureLogger(fn) {
  const calls = [];
  const orig = {info: logger.info, warn: logger.warn, error: logger.error};
  for (const level of ['info', 'warn', 'error']) {
    logger[level] = msg => {
      calls.push({level, message: String(msg)});
      return orig[level].call(logger, msg);
    };
  }
  try {
    fn();
  } finally {
    logger.info = orig.info;
    logger.warn = orig.warn;
    logger.error = orig.error;
  }
  return calls;
}

describe('all modules emit expected logger calls', () => {
  it('verifies every branch across all 12 modules', () => {
    const calls = captureLogger(() => {
      assert.equal(authenticate('bob', ''), false);
      assert.equal(authenticate('bob', 'ok'), true);
      assert.deepEqual(chargeInvoice('inv-2', 0), {ok: false});
      assert.deepEqual(chargeInvoice('inv-2', 99), {ok: true, cents: 99});
      putCache('k1', 30);
      loadSettings('');
      loadSettings('prod');
      ingestBatch(['a', 'b']);
      flushMetrics([1]);
      sendAlert(1, 'oncall');
      sendAlert(3, 'oncall');
      enqueueJob('j1', 200);
      enqueueJob('j2', 5);
      routeStatus('warn', '/api');
      routeStatus('error', '/down');
      runTick(9);
      saveBlob('bad.bin', -1);
      saveBlob('good.bin', 12);
      processTask('t9', false);
      processTask('t10', true);
    });

    assert.deepEqual(calls, [
      {level: 'warn', message: 'Missing token for user bob'},
      {level: 'info', message: 'Authenticated user bob'},
      {level: 'error', message: 'Invalid invoice amount for inv-2'},
      {level: 'info', message: 'Charged invoice inv-2'},
      {level: 'info', message: 'Stored key (k1) with ttl=30s'},
      {level: 'warn', message: 'Environment not specified, using development'},
      {level: 'info', message: 'Loaded settings for prod'},
      {level: 'info', message: 'Ingesting batch of 2 records'},
      {level: 'info', message: 'Flushed 1 metric points'},
      {level: 'warn', message: 'Alert attempt 1 to oncall'},
      {level: 'error', message: 'Alert attempt 3 to oncall'},
      {level: 'warn', message: 'Queue depth high at 200 for job j1'},
      {level: 'info', message: 'Enqueued job j2'},
      {level: 'warn', message: 'Route /api status'},
      {level: 'error', message: 'Route /down status'},
      {level: 'info', message: 'Scheduler tick 9'},
      {level: 'error', message: 'Negative blob size for bad.bin'},
      {level: 'info', message: 'Saved blob good.bin (12 bytes)'},
      {level: 'error', message: 'Task failed: t9'},
      {level: 'info', message: 'Task completed: t10'},
    ]);
  });
});
