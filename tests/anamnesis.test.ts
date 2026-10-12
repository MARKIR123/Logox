import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {Anamnesis} from '../src/anamnesis/service.js';

test('草稿只刷新空闲资格；提交暂停，续做复用同一卡片', async () => {
  const store = new RuntimeStore();
  let now = 0, busy = false, starts = 0;
  const dream = new Anamnesis('s', store, async context => {
    ++starts;
    context.report('研究', '等待模型');
    await delay(100_000, undefined, {signal: context.signal});
  }, () => busy, () => now, 100);
  now = 99; await dream.tick(true);
  assert.equal(starts, 0);
  now = 100; await dream.tick(true);
  await Promise.resolve();
  assert.equal(starts, 1);
  const runId = store.getSnapshot().activities[0]!.activityId;
  dream.noteDraft();
  assert.equal(store.getSnapshot().activities[0]!.status, 'running');
  await dream.foregroundSubmitted();
  assert.equal(store.getSnapshot().activities[0]!.status, 'paused');
  busy = true;
  assert.throws(() => dream.start());
  busy = false;
  const resumed = dream.start();
  assert.equal(resumed.runId, runId);
  await Promise.resolve();
  assert.equal(starts, 2);
  assert.equal(store.getSnapshot().activities.length, 1);
  await dream.close(); await resumed.done;
  assert.equal(store.getSnapshot().activities[0]!.status, 'cancelled');
});
test('没有新资料或存在前台活动时不自动入梦；同步失败产生终态', async () => {
  const store = new RuntimeStore();
  let busy = true;
  const dream = new Anamnesis('s', store, () => { throw new Error('runner failure'); }, () => busy, () => 100, 0);
  await dream.tick(true);
  assert.equal(store.getSnapshot().activities.length, 0);
  busy = false;
  await dream.tick(false);
  assert.equal(store.getSnapshot().activities.length, 0);
  await dream.start().done;
  assert.equal(store.getSnapshot().activities[0]!.status, 'failed');
  await dream.close();
});
