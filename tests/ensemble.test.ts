import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {Ensemble} from '../src/actors/ensemble.js';
import {Journal} from '../src/store/journal.js';
import {answerEnvelope} from '../src/runtime/interactions.js';

async function journalFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-ts-test-'));
  return {directory, history: new Journal(directory)};
}
test('串行登场，同批同角色合并，独立账本支持新运行时恢复', async () => {
  const fixture = await journalFixture();
  try {
    const store = new RuntimeStore();
    let active = 0, maxActive = 0;
    const seen: string[] = [];
    const ensemble = new Ensemble('s', store, fixture.history, async (prompt, context) => {
      maxActive = Math.max(maxActive, ++active);
      seen.push(context.ownerId + ':' + prompt);
      await delay(5, undefined, {signal: context.signal});
      context.say('回复 ' + context.ownerId); --active;
    });
    const handles = ensemble.dispatchBatch([{ownerId: 'kalon', prompt: '界面'}, {ownerId: 'techne', prompt: '内核'}, {ownerId: 'kalon', prompt: '文字'}]);
    await Promise.all(handles.map(handle => handle.done));
    assert.equal(handles.length, 2);
    assert.equal(maxActive, 1);
    assert.deepEqual(seen, ['kalon:界面\n\n文字', 'techne:内核']);
    await ensemble.close();
    const restored = new Ensemble('s', new RuntimeStore(), fixture.history, async (_prompt, context) => {
      assert.equal(context.ownerId, 'kalon');
      assert.deepEqual(context.history.map(entry => entry.ownerId), ['kalon', 'kalon']);
      assert.equal(context.history[0]!.text, '界面\n\n文字');
      context.say('延续');
    });
    await restored.dispatch('kalon', '继续').done;
    assert.equal((await fixture.history.load('s', 'techne')).length, 2);
    assert.equal((await fixture.history.load('different-session', 'kalon')).length, 0);
    await restored.close();
  } finally { await rm(fixture.directory, {recursive: true, force: true}); }
});
test('等待提问时可接收后续任务；回答后继续按登场顺序执行', async () => {
  const fixture = await journalFixture();
  try {
    const store = new RuntimeStore();
    let asked!: () => void;
    const ready = new Promise<void>(resolve => {asked = resolve;});
    const order: string[] = [];
    const ensemble = new Ensemble('s', store, fixture.history, async (_prompt, context) => {
      order.push(context.ownerId);
      if (context.ownerId === 'kalon') {
        const waiting = context.ask({kind: 'question', title: '方向', questions: [{id: 'q', header: '方向', question: '要求？'}]});
        asked();
        await waiting;
      }
      context.say('完成');
    });
    const first = ensemble.dispatch('kalon', '提问');
    await ready;
    const second = ensemble.dispatch('techne', '排队');
    assert.equal(store.activities.get('s', first.activityId)!.status, 'waiting_input');
    assert.equal(store.activities.get('s', second.activityId)!.status, 'queued');
    const request = store.interactions.list()[0]!;
    store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {q: {type: 'text', text: '留白'}}}));
    await Promise.all([first.done, second.done]);
    assert.deepEqual(order, ['kalon', 'techne']);
    await ensemble.close();
  } finally { await rm(fixture.directory, {recursive: true, force: true}); }
});
test('取消权限等待不执行后续副作用，关闭清理排队任务', async () => {
  const fixture = await journalFixture();
  try {
    const store = new RuntimeStore();
    let asked!: () => void;
    const ready = new Promise<void>(resolve => {asked = resolve;});
    let writes = 0;
    const ensemble = new Ensemble('s', store, fixture.history, async (_prompt, context) => {
      const waiting = context.permission({kind: 'permission', title: '写入', tool: 'write', arguments: {path: 'x'}, reason: '改文件'});
      asked();
      if (await waiting) ++writes;
    });
    const first = ensemble.dispatch('techne', '写');
    await ready;
    const queued = ensemble.dispatch('kalon', '以后');
    await ensemble.close();
    await Promise.all([first.done, queued.done]);
    assert.equal(writes, 0);
    assert.equal(store.activities.get('s', first.activityId)!.status, 'cancelled');
    assert.equal(store.activities.get('s', queued.activityId)!.status, 'cancelled');
    assert.equal(store.interactions.list()[0]!.status, 'cancelled');
    assert.throws(() => ensemble.dispatch('logox', '关闭后'));
  } finally { await rm(fixture.directory, {recursive: true, force: true}); }
});

test('排队任务取消立即解除自己的完成等待，不影响当前角色的提问', {timeout: 5000}, async () => {
  const fixture = await journalFixture();
  const store = new RuntimeStore();
  const ensemble = new Ensemble('s', store, fixture.history, async (_prompt, context) => {
    if (context.ownerId === 'kalon') await context.ask({kind: 'question', title: '方向', questions: [{id: 'q', header: '方向', question: '要求？'}]});
    context.say('完成');
  });
  try {
    const first = ensemble.dispatch('kalon', '提问');
    await new Promise<void>(resolve => {
      const unsubscribe = store.subscribe(() => {
        if (store.interactions.list().length) {unsubscribe(); resolve();}
      });
    });
    const queued = ensemble.dispatch('techne', '排队');
    queued.cancel();
    await queued.done;
    assert.equal(store.activities.get('s', queued.activityId)!.status, 'cancelled');
    assert.equal(store.activities.get('s', first.activityId)!.status, 'waiting_input');
    assert.equal(store.interactions.list()[0]!.status, 'pending');
    store.interactions.cancel(store.interactions.list()[0]!.requestId);
    await first.done;
    assert.ok(!store.getSnapshot().messages.some(message => message.activityId === queued.activityId && message.role === 'assistant'));
  } finally {await ensemble.close(); await rm(fixture.directory, {recursive: true, force: true});}
});

test('回复保存期间取消仍进入取消终态，不在异步保存结束后误报完成', {timeout: 5000}, async () => {
  const store = new RuntimeStore();
  let started!: () => void;
  let release!: () => void;
  const saving = new Promise<void>(resolve => {started = resolve;});
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const ensemble = new Ensemble('s', store, {
    async load() {return [];},
    async append(entry) {if (entry.role === 'assistant') {started(); await barrier;}},
  }, async (_prompt, context) => {context.say('回复');});
  try {
    const task = ensemble.dispatch('techne', '保存');
    await saving;
    task.cancel(); release();
    await task.done;
    assert.equal(store.activities.get('s', task.activityId)!.status, 'cancelled');
  } finally {release(); await ensemble.close();}
});
