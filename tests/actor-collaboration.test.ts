import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {Collaboration} from '../src/actors/collaboration.js';
import {Journal} from '../src/store/journal.js';
import {RuntimeStore} from '../src/runtime/store.js';

async function fixture() {const directory = await mkdtemp(join(tmpdir(), 'logox-collaboration-')); return {directory, journal: new Journal(directory)};}
const call = (name: string, args: unknown) => ({id: 'tool-' + name, name, arguments: JSON.stringify(args)});
const context = (overrides: Partial<ActorContext> = {}): ActorContext => ({
  sessionId: 's', activityId: 'sender', ownerId: 'techne', history: [], signal: new AbortController().signal,
  report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'test'};},
  async permission() {return true;}, ...overrides,
});

test('SendMessage 直接注入活跃任务、队列空闲角色并支持必要广播', async () => {
  const f = await fixture();
  try {
    const enqueued: {owner: string; prompt: string}[] = [];
    const injected: {owner: string; message: string; mode?: string}[] = [];
    let cancelled = 0;
    const pending = new Map<string, () => void>();
    const bridge = new Collaboration({
      sessionId: 's', journal: f.journal, projectDir: f.directory,
      member: owner => ['logox', 'techne', 'kalon', 'aletheia'].includes(owner),
      members: () => ['logox', 'techne', 'kalon', 'aletheia'],
      getActiveTask: owner => owner === 'kalon' ? {activityId: 'kalon-active'} : undefined,
      injectMessage: (owner, message, _source, _summary, mode) => {injected.push({owner, message, ...(mode ? {mode} : {})}); return true;},
      enqueue: (owner, prompt) => {
        const activityId = 'task-' + owner;
        const done = new Promise<void>(resolve => pending.set(activityId, resolve));
        enqueued.push({owner, prompt});
        return {activityId, done, cancel: () => {cancelled++; pending.get(activityId)?.();}};
      },
    });

    // Active recipient: injected, no queued card.
    const active = await bridge.execute(call('SendMessage', {to: 'kalon', message: 'Blocked on the palette token', summary: 'Blocker'}), context());
    assert.equal(active.isError, false);
    assert.deepEqual(injected, [{owner: 'kalon', message: 'Blocked on the palette token', mode: 'queue'}]);
    assert.equal(enqueued.length, 0);

    // Idle recipient: one queued task with source attribution.
    const idle = await bridge.execute(call('SendMessage', {to: 'aletheia', message: 'Please verify the call chain', summary: 'Verify chain'}), context());
    assert.equal(idle.isError, false);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.owner, 'aletheia');
    assert.match(enqueued[0]!.prompt, /\[Message from techne · Verify chain\]/);

    // Broadcast: every other member plus the bulletin.
    const broadcast = await bridge.execute(call('SendMessage', {to: 'all', message: 'Interface frozen', summary: 'Freeze'}), context());
    assert.equal(broadcast.isError, false);
    assert.deepEqual(enqueued.slice(1).map(item => item.owner).sort(), ['aletheia', 'logox']);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(await readFile(join(f.directory, '.logox', 'bulletin.md'), 'utf8'), /Interface frozen/);

    // Cancelling the sender activity releases pending queued deliveries.
    await bridge.settle('sender', 'cancelled');
    assert.ok(cancelled > 0);
  } finally {await rm(f.directory, {recursive: true, force: true});}
});

test('SendMessage 拒绝跨会话身份、未知目标、非成员与超长消息', async () => {
  const f = await fixture();
  try {
    const bridge = new Collaboration({
      sessionId: 's', journal: f.journal,
      member: owner => ['techne', 'kalon'].includes(owner),
      enqueue: () => ({activityId: 'x', done: Promise.resolve(), cancel: () => {}}),
    });
    assert.equal((await bridge.execute(call('SendMessage', {to: 'kalon', message: 'hi'}), context({sessionId: 'other'}))).isError, true);
    assert.equal((await bridge.execute(call('SendMessage', {to: 'unknown', message: 'hi'}), context())).isError, true);
    assert.equal((await bridge.execute(call('SendMessage', {to: 'kalon', message: 'hi'}), context({ownerId: 'outsider'}))).isError, true);
    assert.equal((await bridge.execute(call('SendMessage', {to: 'kalon', message: 'x'.repeat(4001)}), context())).isError, true);
  } finally {await rm(f.directory, {recursive: true, force: true});}
});

test('收尾复用保存摘要，整理失败保持完成，直接对话仅回传锚点', async () => {
  const f = await fixture();
  try {
    const store = new RuntimeStore(); let summary: unknown, handed = 0, anchored = 0;
    const ensemble = new Ensemble('s', store, f.journal, async (_prompt, context) => context.say('【轮次摘要】\n标题：修改完成\n报告：测试通过'), {
      taskEnd: async (_context, value) => {summary = value; throw new Error('整理失败');},
      handoff: async result => {handed++; assert.deepEqual(result.summary, summary);},
      directAnchor: async result => {anchored++; assert.equal('summary' in result, false);},
    });
    const task = ensemble.dispatch('techne', '修改'); await task.done;
    const activity = store.activities.get('s', task.activityId)!;
    assert.equal(activity.status, 'completed'); assert.deepEqual(activity.summary, summary);
    const entries = await f.journal.load('s', 'techne');
    assert.deepEqual((await f.journal.rounds('s', 'techne', entries))[0]!.summary, summary);
    await ensemble.dispatch('techne', '私聊', 'direct').done;
    assert.equal(handed, 1); assert.equal(anchored, 1);
    await ensemble.close();
  } finally {await rm(f.directory, {recursive: true, force: true});}
});
