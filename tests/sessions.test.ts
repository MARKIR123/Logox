import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {Journal} from '../src/store/journal.js';
import {SessionManager} from '../src/store/sessions.js';
import {Snapshots} from '../src/tools/snapshots.js';
import {digest} from '../src/context/budget.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {waitForSnapshot} from './runtime-fixture.js';
import type {Provider, ModelRequest} from '../src/runtime/messages.js';

type Application = Awaited<ReturnType<typeof createApplication>>;
async function fixture(provider: Provider = {async respond(_request, delta) {delta({kind: 'text', text: '已完成'}); return {message: {role: 'assistant', text: '已完成'}, stop: 'complete'};}}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-session-')));
  const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 131072}, context: {keep_recent_rounds: 0}, models: {'openai-compatible/retained-model': {context_window: 131072}}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, "auth.json"), sessionId: 'first', config, provider});
  return {app, cwd, config, provider, async cleanup() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
async function submit(app: Application, text: string) {
  await app.submit(text);
  await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed' && snapshot.messages.some(message => message.activityId === activity.activityId && message.role === 'user' && message.text === text)));
  // controllers 在终态发布之后的 finally 删除。
  await new Promise<void>(resolve => setImmediate(resolve));
}
async function choose(app: Application, predicate: (id: string) => boolean = () => true) {
  const surface = app.surfaces.getSnapshot();
  assert.ok(surface?.kind === 'picker' && surface.status === 'ready');
  const item = surface.items.find(item => !item.disabled && predicate(item.id));
  assert.ok(item);
  await app.surfaces.choose(surface.id, item.id);
}
async function seed(journal: Journal, sessionId: string, activityId: string, text: string, time: number, ownerId = 'logox') {
  await journal.append({version: 1, sessionId, ownerId, activityId, role: 'user', text, time, message: {role: 'user', text}});
  await journal.append({version: 1, sessionId, ownerId, activityId, role: 'assistant', text: text + '结果', time: time + 1, message: {role: 'assistant', text: text + '结果'}});
  await journal.finish(sessionId, ownerId, activityId, 'completed');
}

test('两个会话创建、列表取消、选择、项目模型保持与 --resume 重启', async () => {
  const f = await fixture();
  try {
    await submit(f.app, '第一会话');
    const oldStore = f.app.store, tools = f.app.tools;
    await f.app.submit('/model retained-model');
    await f.app.submit('/new');
    const second = f.app.sessionId;
    assert.notEqual(second, 'first'); assert.notEqual(f.app.store, oldStore); assert.equal(f.app.tools, tools);
    assert.ok(f.app.commandContext().models.includes('retained-model'));
    assert.equal(f.app.store.getSnapshot().messages.some(message => message.text === '第一会话'), false);
    await submit(f.app, '第二会话');
    const catalog = await f.app.sessions.list();
    assert.equal(catalog.sessions.length, 2);
    assert.ok(catalog.sessions.some(info => info.title === '第一会话'));
    await f.app.submit('/resume');
    f.app.surfaces.cancel(); assert.equal(f.app.sessionId, second);
    await f.app.submit('/resume');
    await choose(f.app, id => JSON.parse(id)[0] === 'first');
    assert.equal(f.app.sessionId, 'first');
    assert.ok(f.app.store.getSnapshot().messages.some(message => message.text === '第一会话'));
    assert.equal(oldStore.interactions.list().some(item => item.status === 'pending'), false);
    await f.app.close();
    const restored = await createApplication({cwd: f.cwd, resourceOptions: {home: f.cwd, boundary: f.cwd}, env: {}, authPath: join(f.cwd, "auth.json"), resume: true, config: f.config, provider: f.provider});
    try {assert.equal(restored.sessionId, 'first'); assert.equal(restored.store.getSnapshot().activities[0]?.status, 'completed');}
    finally {await restored.close();}
    const other = await mkdtemp(join(tmpdir(), 'logox-other-project-'));
    try {assert.deepEqual((await (await SessionManager.open(other)).list()).sessions, []);} finally {await rm(other, {recursive: true, force: true});}
  } finally {await f.cleanup();}
});

test('任务等待期间拒绝切换；目标加载失败保留旧运行时和锁', async () => {
  const f = await fixture({async respond(_request, _delta, signal) {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    throw new Error('不应继续');
  }});
  try {
    await f.app.submit('等待');
    await assert.rejects(f.app.submit('/new'), /任务处理中/);
    await assert.rejects(f.app.submit('/resume first'), /任务处理中/);
    await assert.rejects(f.app.submit('/clear'), /任务处理中/);
    await assert.rejects(f.app.submit('/rewind'), /任务处理中/);
    const task = f.app.store.getSnapshot().activities[0]!; f.app.cancel(task.activityId);
    await waitForSnapshot(f.app.store, snapshot => snapshot.activities[0]?.status === 'cancelled');
    await new Promise<void>(resolve => setImmediate(resolve));
    const store = f.app.store;
    await assert.rejects(f.app.submit('/resume missing'), /没有此项目的会话/);
    assert.equal(f.app.store, store); assert.equal(f.app.sessionId, 'first');
    await assert.rejects(f.app.sessions.acquire('first'), /占用/);
  } finally {await f.cleanup();}
});

test('/clear 只清显示，下一请求保留历史；恢复原文与压缩摘要', async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture({async respond(request) {requests.push(request); return {message: {role: 'assistant', text: '结果'.repeat(1000)}, stop: 'complete'};}});
  try {
    await submit(f.app, '需要保留的输入');
    await f.app.submit('/compact');
    const entries = await f.app.journal.load('first', 'logox');
    assert.ok((await f.app.journal.loadContext('first', 'logox', entries))?.folded.length);
    await f.app.submit('/clear');
    assert.equal(f.app.store.getSnapshot().messages.some(message => message.text === '需要保留的输入'), false);
    assert.equal((await f.app.journal.load('first', 'logox')).length, entries.length);
    await f.app.close();
    const app = await createApplication({cwd: f.cwd, resourceOptions: {home: f.cwd, boundary: f.cwd}, env: {}, authPath: join(f.cwd, "auth.json"), sessionId: 'first', config: f.config, provider: f.provider});
    try {
      assert.ok(app.store.getSnapshot().messages.some(message => message.text === '需要保留的输入'));
      await submit(app, '新输入');
      assert.ok(requests.at(-1)?.messages.some(message => message.text.includes('【轮次摘要】')));
      assert.ok(requests.at(-1)?.messages.some(message => message.text === '需要保留的输入'));
    } finally {await app.close();}
  } finally {await f.cleanup();}
});

test('回退跨角色轮次和文件；未来原文保留但不进入恢复后的请求', async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture({async respond(request) {requests.push(request); return {message: {role: 'assistant', text: '新分支结果'}, stop: 'complete'};}});
  try {
    const j = f.app.journal, snapshots = f.app.tools.snapshots, file = join(f.cwd, 'one.txt'), created = join(f.cwd, 'new.txt');
    await seed(j, 'first', 'keep', '保留轮', 10);
    await seed(j, 'first', 'cut', '回退目标', 20, 'techne');
    await seed(j, 'first', 'future', '未来轮', 30);
    await writeFile(file, 'original');
    const signal = new AbortController().signal;
    await snapshots.apply(file, Buffer.from('original'), Buffer.from('v1'), 'cut', signal);
    await snapshots.apply(file, Buffer.from('v1'), Buffer.from('v2'), 'cut', signal);
    await snapshots.apply(created, null, Buffer.from('created'), 'future', signal);
    const rawBefore = await readFile(j.path('first', 'logox'), 'utf8');
    await f.app.submit('/resume first');
    await f.app.submit('/rewind'); await choose(f.app, id => id === 'cut');
    assert.equal(await readFile(file, 'utf8'), 'original');
    await assert.rejects(readFile(created), {code: 'ENOENT'});
    assert.equal(await readFile(j.path('first', 'logox'), 'utf8'), rawBefore);
    assert.deepEqual((await j.load('first', 'logox')).map(entry => entry.activityId), ['keep', 'keep']);
    assert.deepEqual(await j.load('first', 'techne'), []);
    await submit(f.app, '分支输入');
    assert.ok(!JSON.stringify(requests.at(-1)).includes('未来轮'));
    assert.ok(JSON.stringify(requests.at(-1)).includes('保留轮'));
    await f.app.submit('/new'); await f.app.submit('/resume first');
    assert.ok(!f.app.store.getSnapshot().messages.some(message => message.text === '未来轮'));
    const effective = await j.load('first', 'logox');
    assert.equal(effective.filter(entry => entry.role === 'user').length, 2);
    assert.ok((await j.loadRaw('first', 'logox')).length > effective.length);
  } finally {await f.cleanup();}
});

test('回退保留用户漂移，失败不推进分支；未完成操作重启后禁止新任务并可重试', async () => {
  const f = await fixture();
  try {
    const file = join(f.cwd, 'file.txt'), signal = new AbortController().signal;
    await seed(f.app.journal, 'first', 'target', '目标', 10);
    await writeFile(file, 'before');
    await f.app.tools.snapshots.apply(file, Buffer.from('before'), Buffer.from('after'), 'target', signal);
    await writeFile(file, 'user-edit');
    await f.app.submit('/rewind'); await choose(f.app);
    assert.equal(await readFile(file, 'utf8'), 'user-edit');
    assert.equal((await f.app.journal.load('first', 'logox')).length, 2);
    assert.ok(f.app.surfaces.getSnapshot()?.kind === 'picker'); f.app.surfaces.cancel();
    await assert.rejects(f.app.submit('不能开始'), /回退未完成/);
    await f.app.close();
    const app = await createApplication({cwd: f.cwd, resourceOptions: {home: f.cwd, boundary: f.cwd}, env: {}, authPath: join(f.cwd, "auth.json"), resume: true, config: f.config, provider: f.provider});
    try {
      await assert.rejects(app.submit('/compact'), /回退未完成/);
      await writeFile(file, 'after');
      await app.submit('/rewind'); await choose(app);
      assert.equal(await readFile(file, 'utf8'), 'before');
      assert.deepEqual(await app.journal.load('first', 'logox'), []);
      assert.equal(await app.journal.pending('first'), undefined);
    } finally {await app.close();}
  } finally {await f.cleanup();}
});

test('多文件执行中部分失败列明结果；重试识别已恢复版本', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-partial-')));
  class FailingSnapshots extends Snapshots {
    fail = true;
    protected override async writeRestored(path: string, bytes: Buffer | null) {
      if (this.fail && path.endsWith('a.txt')) throw new Error('模拟磁盘写入失败');
      await super.writeRestored(path, bytes);
    }
  }
  try {
    const snapshots = new FailingSnapshots(join(cwd, 'snapshots')), signal = new AbortController().signal;
    for (const name of ['a.txt', 'b.txt']) {
      const path = join(cwd, name); await writeFile(path, 'before');
      await snapshots.apply(path, Buffer.from('before'), Buffer.from('after'), 'round', signal);
    }
    const result = await snapshots.restore(['round']);
    assert.equal(result.success, false); assert.deepEqual(result.restored, [join(cwd, 'b.txt')]); assert.deepEqual(result.failed, [join(cwd, 'a.txt')]);
    assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'before');
    snapshots.fail = false;
    assert.equal((await snapshots.restore(['round'])).success, true);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'before');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('坏尾行阻止追加；恢复 picker 创建完整前缀的新会话，源账本不变', async () => {
  const f = await fixture();
  try {
    const j = f.app.journal;
    await seed(j, 'damaged', 'ok', '完整轮', 10);
    await f.app.sessions.touch('damaged', '坏账本');
    const file = j.path('damaged', 'logox'), broken = (await readFile(file, 'utf8')) + '{"partial":';
    await writeFile(file, broken);
    await assert.rejects(j.append({version: 1, sessionId: 'damaged', ownerId: 'logox', role: 'user', text: '不能覆盖'}), /末行未完整/);
    await f.app.submit('/resume damaged');
    assert.equal(f.app.sessionId, 'first'); f.app.surfaces.cancel(); assert.equal(await readFile(file, 'utf8'), broken);
    await f.app.submit('/resume'); await choose(f.app, value => JSON.parse(value)[0] === 'damaged');
    assert.notEqual(f.app.sessionId, 'damaged'); assert.notEqual(f.app.sessionId, 'first');
    assert.equal(await readFile(file, 'utf8'), broken);
    assert.ok((await f.app.journal.load(f.app.sessionId, 'logox')).some(entry => entry.text === '完整轮'));
    await submit(f.app, '恢复后继续');
  } finally {await f.cleanup();}
});

test('应用多文件部分失败不提交历史；原目标重试成功后才推进分支', async () => {
  const f = await fixture();
  class FailingSnapshots extends Snapshots {
    fail = true;
    protected override async writeRestored(path: string, bytes: Buffer | null) {
      if (this.fail && path.endsWith('a.txt')) throw new Error('磁盘拒绝写入');
      await super.writeRestored(path, bytes);
    }
  }
  try {
    await seed(f.app.journal, 'first', 'target', '回退', 1);
    const snapshots = new FailingSnapshots(join(f.cwd, '.logox', 'snapshots'));
    for (const name of ['a.txt', 'b.txt']) {
      const path = join(f.cwd, name); await writeFile(path, 'before');
      await snapshots.apply(path, Buffer.from('before'), Buffer.from('after'), 'target', new AbortController().signal);
    }
    f.app.tools.snapshots.restore = snapshots.restore.bind(snapshots);
    await f.app.submit('/rewind'); await choose(f.app);
    const state = f.app.surfaces.getSnapshot(); assert.ok(state?.kind === 'picker' && state.error.includes('b.txt'));
    assert.equal((await f.app.journal.load('first', 'logox')).length, 2);
    assert.equal(await readFile(join(f.cwd, 'b.txt'), 'utf8'), 'before');
    assert.ok(await f.app.journal.pending('first'));
    snapshots.fail = false; await choose(f.app);
    assert.deepEqual(await f.app.journal.load('first', 'logox'), []);
    assert.equal(await f.app.journal.pending('first'), undefined);
  } finally {await f.cleanup();}
});

test('/undo 仅筛选当前会话文件，不冒充对话回退', async () => {
  const f = await fixture();
  try {
    const path = join(f.cwd, 'one.txt'); await writeFile(path, 'before');
    await seed(f.app.journal, 'first', 'old', '旧轮', 1);
    await f.app.tools.snapshots.apply(path, Buffer.from('before'), Buffer.from('after'), 'old', new AbortController().signal);
    await f.app.submit('/new'); await f.app.submit('/undo'); assert.equal(await readFile(path, 'utf8'), 'after');
    await f.app.submit('/resume first'); await f.app.submit('/undo'); assert.equal(await readFile(path, 'utf8'), 'before');
    assert.equal((await f.app.journal.load('first', 'logox')).length, 2);
  } finally {await f.cleanup();}
});

test('旧 TS 无 catalog 的会话仍可列出并选择，不改原始账本', async () => {
  const f = await fixture();
  try {
    const journal = f.app.journal;
    await seed(journal, 'unindexed', 'old', '旧 TS 输入', 1);
    const file = journal.path('unindexed', 'logox'), before = await readFile(file, 'utf8');
    assert.equal(await f.app.sessions.info('unindexed'), undefined);
    assert.ok((await f.app.sessions.list()).sessions.some(info => info.id === 'unindexed' && info.title === '旧 TS 输入'));
    await f.app.submit('/resume'); await choose(f.app, value => JSON.parse(value)[0] === 'unindexed');
    assert.equal(f.app.sessionId, 'unindexed');
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {await f.cleanup();}
});

test('重启的排队/待回答检查点标记中断，未配对工具不会自动重放', async () => {
  let calls = 0;
  const f = await fixture({async respond() {calls++; return {message: {role: 'assistant', text: '完成'}, stop: 'complete'};}});
  try {
    const j = f.app.journal;
    await j.checkpoint('first', {activityId: 'queued', ownerId: 'techne', prompt: '未开始任务', source: 'logox', status: 'queued', time: 1});
    await j.checkpoint('first', {activityId: 'waiting', ownerId: 'logox', prompt: '等待许可', source: 'logox', status: 'waiting_input', time: 2});
    await j.append({version: 1, sessionId: 'first', ownerId: 'logox', activityId: 'waiting', role: 'user', text: '等待许可'});
    await j.append({version: 1, sessionId: 'first', ownerId: 'logox', activityId: 'waiting', role: 'assistant', text: '',
      message: {role: 'assistant', text: '', toolCalls: [{id: 'never-repeat', name: 'write', arguments: '{"path":"must-not-exist","content":"x"}'}]}});
    await f.app.close();
    const app = await createApplication({cwd: f.cwd, resourceOptions: {home: f.cwd, boundary: f.cwd}, env: {}, authPath: join(f.cwd, "auth.json"), resume: true, config: f.config, provider: f.provider});
    try {
      assert.equal(calls, 0);
      assert.ok(app.store.getSnapshot().activities.every(activity => activity.status === 'cancelled'));
      assert.equal(app.store.interactions.list().length, 0);
      assert.ok((await app.journal.activeTasks('first')).every(task => task.status === 'cancelled'));
      await submit(app, '手动新任务'); assert.equal(calls, 1);
      assert.ok((await app.journal.load('first', 'logox')).some(entry => entry.message?.role === 'tool' && entry.message.callId === 'never-repeat' && entry.message.isError));
      await assert.rejects(readFile(join(f.cwd, 'must-not-exist')), {code: 'ENOENT'});
    } finally {await app.close();}
  } finally {await f.cleanup();}
});

test('分支保留有效前缀压缩状态，剪掉未来摘要后从有效原文重建', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-branch-context-'));
  try {
    const j = new Journal(cwd);
    await seed(j, 's', 'a', '保留', 1);
    const first = await j.load('s', 'logox');
    await j.saveContext({version: 1, sessionId: 's', ownerId: 'logox', sourceLength: first.length, sourceHash: digest(first), folded: [0], archives: []});
    await seed(j, 's', 'b', '未来', 3);
    await j.fork('s', ['logox'], ['b']);
    assert.deepEqual((await j.loadContext('s', 'logox', await j.load('s', 'logox')))?.folded, [0]);
    await seed(j, 's', 'c', '新分支', 5);
    const active = await j.load('s', 'logox');
    await j.saveContext({version: 1, sessionId: 's', ownerId: 'logox', sourceLength: active.length, sourceHash: digest(active), folded: [0, 2], archives: [], memo: {end: active.length, text: '包含新分支'}});
    await j.fork('s', ['logox'], ['c']);
    assert.equal(await j.loadContext('s', 'logox', await j.load('s', 'logox')), undefined);
    assert.equal((await j.loadRaw('s', 'logox')).length, 6);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('跨进程会话锁竞争、退出释放和死亡锁恢复；损坏锁不覆盖', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-lock-'));
  const module = new URL('../src/store/sessions.js', import.meta.url).href;
  const script = `import {SessionManager} from ${JSON.stringify(module)}; const manager = await SessionManager.open(process.argv[1]); const lease = await manager.acquire('shared'); process.stdout.write('locked\\n'); process.stdin.once('data', async () => {await lease.release(); process.exit(0);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, cwd], {stdio: ['pipe', 'pipe', 'pipe']});
  try {
    await new Promise<void>((resolve, reject) => {child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', code => {if (code) reject(new Error('锁测试子进程失败'));});});
    const manager = await SessionManager.open(cwd);
    await assert.rejects(manager.acquire('shared'), /占用/);
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve())); child.stdin.write('release'); await exit;
    const lease = await manager.acquire('shared'); await lease.release();
    await lease.release();
    const directory = join(manager.directory, 'locks');
    const files = await import('node:fs/promises').then(fs => fs.readdir(directory)); assert.deepEqual(files, []);
    const crashed = spawn(process.execPath, ['--input-type=module', '-e', script, cwd], {stdio: ['pipe', 'pipe', 'pipe']});
    await new Promise<void>(resolve => crashed.stdout.once('data', () => resolve()));
    const killed = new Promise<void>(resolve => crashed.once('exit', () => resolve())); crashed.kill(); await killed;
    const recovered = await manager.acquire('shared'); await recovered.release();
    const corruptLease = await manager.acquire('bad');
    const lock = (await import('node:fs/promises').then(fs => fs.readdir(directory))).find(file => file.endsWith('.lock'))!;
    await writeFile(join(directory, lock), 'broken');
    await assert.rejects(manager.acquire('bad'), /锁损坏/);
    await assert.rejects(corruptLease.release(), /拥有者发生变化/);
    assert.equal(await readFile(join(directory, lock), 'utf8'), 'broken');
  } finally {child.kill(); await rm(cwd, {recursive: true, force: true});}
});

test('真实审批等待检查点、取消与退出收尾保存终态', async () => {
  const f = await fixture({async respond(request) {
    if (request.messages.at(-1)?.role === 'tool') return {message: {role: 'assistant', text: '结果'}, stop: 'complete'};
    return {message: {role: 'assistant', text: '', toolCalls: [{id: 'approval', name: 'write', arguments: JSON.stringify({path: 'file.txt', content: 'value'})}]}, stop: 'tools'};
  }});
  try {
    await f.app.submit('写文件');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    await f.app.journal.flush();
    assert.equal((await f.app.journal.activeTasks('first'))[0]?.status, 'waiting_input');
    const request = f.app.store.interactions.list()[0]!;
    f.app.store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: 'deny'}));
    await waitForSnapshot(f.app.store, snapshot => snapshot.activities[0]?.status === 'completed');
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.app.submit('取消写文件');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    await f.app.close();
    const tasks = await f.app.journal.activeTasks('first');
    assert.deepEqual(tasks.map(task => task.status), ['completed', 'cancelled']);
    await assert.rejects(readFile(join(f.cwd, 'file.txt')), {code: 'ENOENT'});
  } finally {await f.cleanup();}
});
