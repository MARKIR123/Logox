import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig} from '../src/config/config.js';
import {SessionManager} from '../src/store/sessions.js';
import {Journal} from '../src/store/journal.js';
import {waitForSnapshot} from './runtime-fixture.js';
import type {Provider} from '../src/runtime/messages.js';

const completed: Provider = {async respond() {return {message: {role: 'assistant', text: '完成'}, stop: 'complete'};}};
const run = promisify(execFile);
type Application = Awaited<ReturnType<typeof createApplication>>;
async function fixture(provider: Provider = completed) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-lifecycle-')));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const apps: Application[] = [];
  const open = async (options: {sessionId?: string; resume?: boolean} = {}) => {
    const app = await createApplication({cwd, config, provider, resourceOptions: {home: cwd, boundary: cwd}, env: {},
      authPath: join(cwd, 'auth.json'), ...options});
    apps.push(app); return app;
  };
  return {cwd, open, async close() {await Promise.all(apps.map(app => app.close())); await rm(cwd, {recursive: true, force: true});}};
}
async function finish(app: Application, text: string) {
  await app.submit(text);
  await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('打开、草稿和本地命令不保存空白；首次任务前登记；普通启动恢复最近正式会话', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 2; index++) {
      const app = await f.open();
      app.noteDraft();
      await app.submit('/status'); app.surfaces.cancel();
      await app.submit('/model changed');
      assert.equal(app.isSessionPersistent(), false);
      assert.deepEqual((await app.sessions.list()).sessions, []);
      assert.deepEqual(await app.journal.tasks(app.sessionId), []);
      await app.close();
    }
    const first = await f.open();
    await finish(first, '正式首轮');
    const id = first.sessionId;
    assert.equal(first.isSessionPersistent(), true);
    assert.equal((await first.sessions.list()).sessions[0]?.title, '正式首轮');
    let updates = 0;
    const unsubscribe = first.subscribeStatus(() => {updates++;}), oldStore = first.store;
    const previousStatus = first.getStatusSnapshot();
    await first.submit('/new');
    assert.notEqual(first.sessionId, id);
    assert.notEqual(first.getStatusSnapshot(), previousStatus);
    const afterSwitch = updates;
    first.store.message(first.sessionId, 'logox', 'notice', '当前窗口更新');
    assert.ok(updates > afterSwitch);
    const beforeOldMessage = updates;
    oldStore.message(id, 'logox', 'notice', '已离开的窗口更新');
    assert.equal(updates, beforeOldMessage, '状态订阅不再消费旧会话');
    unsubscribe();
    assert.equal(first.isSessionPersistent(), false);
    assert.equal((await first.sessions.list()).sessions.length, 1);
    await first.submit('/resume ' + id);
    assert.equal(first.sessionId, id);
    assert.equal((await first.sessions.list()).sessions.length, 1);
    await first.close();
    const restored = await f.open();
    assert.equal(restored.sessionId, id);
    assert.ok(restored.store.getSnapshot().messages.some(message => message.text === '正式首轮'));
  } finally {await f.close();}
});

test('首次登记失败拒绝派发，重试可以保存；失败和取消都属于正式历史', async () => {
  let requests = 0;
  const f = await fixture({async respond() {requests++; throw new Error('合成模型失败');}});
  try {
    const app = await f.open(), touch = app.sessions.touch.bind(app.sessions);
    app.sessions.touch = async () => {throw new Error('合成索引保存失败');};
    await assert.rejects(app.submit('不能派发'), /索引保存失败/);
    assert.equal(requests, 0);
    assert.equal(app.store.getSnapshot().activities.length, 0);
    assert.equal(app.isSessionPersistent(), false);
    app.sessions.touch = touch;
    await app.submit('失败仍保存');
    await waitForSnapshot(app.store, snapshot => snapshot.activities[0]?.status === 'failed');
    await app.ensemble.close();
    assert.equal((await app.sessions.list()).sessions.length, 1);
    assert.equal((await app.journal.tasks(app.sessionId))[0]?.status, 'failed');
  } finally {await f.close();}
  const waiting = await fixture({async respond(_request, _delta, signal) {
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    throw new Error('不应继续');
  }});
  try {
    const app = await waiting.open();
    await app.submit('取消仍保存');
    await waitForSnapshot(app.store, snapshot => snapshot.activities[0]?.status === 'running');
    app.cancel(app.store.getSnapshot().activities[0]!.activityId);
    await waitForSnapshot(app.store, snapshot => snapshot.activities[0]?.status === 'cancelled');
    await app.ensemble.close();
    assert.equal((await app.sessions.list()).sessions.length, 1);
    assert.equal((await app.journal.tasks(app.sessionId))[0]?.status, 'cancelled');
  } finally {await waiting.close();}
});

test('旧空白清理索引保留文件；失败、排队和没有成功回复的 Actor 任务保留', async () => {
  const f = await fixture();
  try {
    const manager = await SessionManager.open(f.cwd), journal = new Journal(join(manager.directory, 'sessions'));
    await manager.touch('old-empty'); await manager.remember('old-empty');
    await journal.append({version: 1, sessionId: 'old-empty', ownerId: 'logox', role: 'assistant', text: '旧展示通知'});
    const file = journal.path('old-empty', 'logox'), bytes = await readFile(file, 'utf8');
    await manager.touch('actor-failed');
    await journal.checkpoint('actor-failed', {activityId: 'actor', ownerId: 'techne', prompt: '已正式提交', source: 'direct', status: 'failed', time: 5});
    await manager.touch('queued');
    await journal.checkpoint('queued', {activityId: 'queued', ownerId: 'aletheia', prompt: '尚未执行', source: 'direct', status: 'queued', time: 6});
    const catalog = await manager.list();
    assert.deepEqual(new Set(catalog.sessions.map(info => info.id)), new Set(['actor-failed', 'queued']));
    assert.equal(await manager.info('old-empty'), undefined);
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.ok(['actor-failed', 'queued'].includes((await manager.recent())!));
    const lease = await manager.acquire('first-save');
    try {
      await manager.touch('first-save');
      assert.ok(!(await manager.list()).sessions.some(info => info.id === 'first-save'));
      assert.ok(await manager.info('first-save'), '持有租约时保留尚未落检查点的索引');
    } finally {await lease.release();}
    await manager.list();
    assert.equal(await manager.info('first-save'), undefined);
  } finally {await f.close();}
});

test('已接受任务的标题更新失败只记录系统错误，不让提交失败或丢失历史', async () => {
  let requests = 0;
  const f = await fixture({async respond() {requests++; return {message: {role: 'assistant', text: '完成'}, stop: 'complete'};}});
  try {
    const app = await f.open(), touch = app.sessions.touch.bind(app.sessions);
    let writes = 0;
    app.sessions.touch = async (id, title) => {if (++writes > 1) throw new Error('合成标题更新失败'); await touch(id, title);};
    await finish(app, '已接受任务');
    assert.equal(requests, 1);
    assert.equal(app.isSessionPersistent(), true);
    assert.equal((await app.sessions.list()).sessions[0]?.title, '已接受任务');
    assert.ok(app.store.getSnapshot().messages.some(message => message.text.includes('标题更新失败')));
  } finally {await f.close();}
});

test('最近正式会话占用时打开列表与临时空白；不悄悄进入更旧会话；显式恢复明确失败', async () => {
  const f = await fixture();
  try {
    const old = await f.open({sessionId: 'older'}); await finish(old, '旧任务'); await old.close();
    const latest = await f.open({sessionId: 'latest'}); await finish(latest, '最近任务');
    const fallback = await f.open();
    assert.notEqual(fallback.sessionId, latest.sessionId);
    assert.notEqual(fallback.sessionId, 'older');
    assert.equal(fallback.isSessionPersistent(), false);
    assert.equal(fallback.surfaces.getSnapshot()?.kind, 'picker');
    assert.ok(fallback.store.getSnapshot().messages.some(message => message.text.includes('其他进程占用')));
    assert.equal((await fallback.sessions.list()).sessions.length, 2);
    await assert.rejects(f.open({sessionId: 'latest'}), /占用/);
    await assert.rejects(f.open({resume: true}), /占用/);
  } finally {await f.close();}
});

test('最近坏账本保留原文并打开列表；显式 ID 不隐藏错误；可选择新建临时会话', async () => {
  const f = await fixture();
  try {
    const app = await f.open({sessionId: 'damaged'}); await finish(app, '原任务'); await app.close();
    const file = app.journal.path('damaged', 'logox'), bytes = await readFile(file, 'utf8') + '{"partial":';
    await writeFile(file, bytes);
    const fallback = await f.open();
    assert.equal(fallback.isSessionPersistent(), false);
    assert.ok(fallback.store.getSnapshot().messages.some(message => message.text.includes('最近会话无法进入')));
    await assert.rejects(f.open({sessionId: 'damaged'}), /末行未完整/);
    const surface = fallback.surfaces.getSnapshot();
    assert.ok(surface?.kind === 'picker');
    const fresh = surface.items.find(item => JSON.parse(item.id)[1] === 'new');
    assert.ok(fresh); await fallback.surfaces.choose(surface.id, fresh.id);
    assert.equal(fallback.isSessionPersistent(), false);
    assert.equal((await fallback.sessions.list()).sessions.length, 1);
    assert.equal(await readFile(file, 'utf8'), bytes);
  } finally {await f.close();}
});

test('无索引旧 TS 账本从正式用户输入识别历史，Actor 独立提交也在执行前登记', async () => {
  const f = await fixture();
  try {
    const manager = await SessionManager.open(f.cwd), journal = new Journal(join(manager.directory, 'sessions'));
    await journal.append({version: 1, sessionId: 'uncatalogued', ownerId: 'kalon', role: 'assistant', text: '先前显示信息'});
    await journal.append({version: 1, sessionId: 'uncatalogued', ownerId: 'kalon', role: 'user', text: '实际任务'});
    assert.equal((await manager.list()).sessions[0]?.title, '实际任务');
    const app = await f.open({sessionId: 'actor-new'});
    await finish(app, '@techne 完成独立任务');
    assert.equal(app.isSessionPersistent(), true);
    assert.ok((await app.journal.tasks('actor-new')).some(task => task.ownerId === 'techne'));
    assert.ok((await app.sessions.list()).sessions.some(info => info.id === 'actor-new'));
  } finally {await f.close();}
});

test('索引扫描在元数据读取变慢时仍能结束，不遗漏已经流出的记录', {timeout: 15000}, async () => {
  const f = await fixture();
  try {
    const manager = await SessionManager.open(f.cwd), journal = new Journal(join(manager.directory, 'sessions'));
    await journal.append({version: 1, sessionId: 'slow-stat', ownerId: 'logox', role: 'user', text: '扫描任务'});
    const module = new URL('../src/store/sessions.js', import.meta.url).href;
    // 内置 fs 的延迟替身隔离在子进程，稳定扩大读取流与 stat 之间的竞态窗口。
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      import {setTimeout as delay} from 'node:timers/promises'; import {SessionManager} from ${JSON.stringify(module)};
      const stat = fs.promises.stat;
      fs.promises.stat = async (...args) => {const result = await stat(...args); if (String(args[0]).endsWith('.jsonl')) await delay(80); return result;};
      syncBuiltinESMExports();
      const timeout = setTimeout(() => {process.stderr.write('索引扫描没有结束'); process.exit(1);}, 5000);
      try {const manager = await SessionManager.open(process.argv[1]); const result = await manager.list();
        process.stdout.write(JSON.stringify(result.sessions.map(info => info.id)));}
      finally {clearTimeout(timeout);}`;
    const {stdout} = await run(process.execPath, ['--input-type=module', '-e', script, f.cwd], {windowsHide: true, timeout: 10000});
    assert.deepEqual(JSON.parse(stdout), ['slow-stat']);
  } finally {await f.close();}
});
