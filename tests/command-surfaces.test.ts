import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import {loadConfig} from '../src/config/config.js';
import {createApplication} from '../src/application.js';

const spec = {title: '选择', description: '说明', current: 'a'};
test('命令界面取消中止查询，旧响应不能复活或覆盖新页面', async () => {
  const results: string[] = [], surfaces = new CommandSurfaces(result => {if (result.message) results.push(result.message);});
  let finish!: () => void, querySignal!: AbortSignal;
  const loading = surfaces.openPicker(spec, async signal => {querySignal = signal; await new Promise<void>(resolve => {finish = resolve;}); return {items: [{id: 'a', label: 'A'}]};}, () => ({message: '选中'}));
  const old = surfaces.getSnapshot()!;
  surfaces.cancel(); assert.equal(querySignal.aborted, true);
  surfaces.openPage('页面', [{id: 'status', title: '状态', lines: ['内容']}], 'status');
  finish(); await loading;
  assert.equal(surfaces.getSnapshot()!.kind, 'page');
  await surfaces.choose(old.id, 'a'); assert.deepEqual(results, []);
  surfaces.cancel(); assert.equal(surfaces.getSnapshot(), null);
});
test('选择结果由命令处理：禁用、身份、失败重试与重复确认', async () => {
  const results: string[] = [], surfaces = new CommandSurfaces(result => {if (result.message) results.push(result.message);});
  let calls = 0, finish!: () => void;
  await surfaces.openPicker(spec, async () => ({items: [{id: 'a', label: 'A'}, {id: 'b', label: 'B', disabled: true}]}), async () => {
    calls++; if (calls === 1) throw new Error('任务处理中');
    await new Promise<void>(resolve => {finish = resolve;}); return {message: '完成'};
  });
  const id = surfaces.getSnapshot()!.id;
  await surfaces.choose('wrong', 'a'); await surfaces.choose(id, 'b'); assert.equal(calls, 0);
  await surfaces.choose(id, 'a');
  const failed = surfaces.getSnapshot(); assert.ok(failed?.kind === 'picker'); assert.equal(failed.error, '任务处理中');
  const selecting = surfaces.choose(id, 'a'); surfaces.cancel(); await surfaces.choose(id, 'a');
  assert.equal(calls, 2); assert.equal(surfaces.getSnapshot()?.kind, 'picker');
  finish(); await selecting; assert.equal(surfaces.getSnapshot(), null); assert.deepEqual(results, ['完成']);
});
test('模型目录汇集已认证提供商、区分同名模型、保留部分成功和当前选择', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-catalog-'));
  const config = await loadConfig(cwd, {provider: {name: 'local', model: 'original'}, providers: {
    alpha: {base_url: 'https://alpha.invalid/v1', api_key_env: 'ALPHA'},
    beta: {base_url: 'https://beta.invalid/v1', api_key_env: 'BETA'},
    offline: {base_url: 'https://offline.invalid/v1', api_key_env: 'OFFLINE'},
    local: {base_url: 'http://127.0.0.1:7777/v1'},
  }}, {}, cwd, cwd);
  const requests: string[] = [], fetcher: typeof fetch = async (url, init) => {
    const address = String(url); requests.push(address);
    if (address.includes('offline')) return new Response('private response', {status: 401});
    if (address.includes('alpha')) assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-alpha');
    if (address.includes('beta')) assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-beta');
    return Response.json({data: [{id: 'same-model'}, {id: 'same-model'}]});
  };
  try {
    const auth = new AuthStorage(join(cwd, 'auth.json'));
    await auth.save('beta', 'synthetic-beta', new AbortController().signal);
    const registry = new ProviderRegistry(config, {ALPHA: 'synthetic-alpha', OFFLINE: 'synthetic-offline'}, fetcher, auth);
    const result = await registry.modelCatalog(new AbortController().signal);
    assert.deepEqual(result.models, [{provider: 'alpha', id: 'same-model'}, {provider: 'beta', id: 'same-model'}, {provider: 'local', id: 'same-model'}]);
    assert.equal(result.issues.length, 1); assert.ok(result.issues[0]!.includes('offline'));
    assert.ok(!JSON.stringify(result).includes('synthetic-')); assert.ok(!JSON.stringify(result).includes('private response'));
    assert.equal(requests.length, 4, '未登录云端和未配置本地不查询');
    assert.equal(registry.selection().model, 'original');
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(registry.modelCatalog(cancelled.signal), {name: 'AbortError'});
  } finally {await rm(cwd, {recursive: true, force: true});}
});
test('页签命令和提供商选择不触发模型、不进账本；确认才更新并支持限定模型名', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-pages-'));
  const config = await loadConfig(cwd, {provider: {name: 'alpha', model: 'first'}, providers: {
    alpha: {base_url: 'http://127.0.0.1:7777/v1'}, beta: {base_url: 'http://127.0.0.1:8888/v1', default_model: 'second'},
  }}, {}, cwd, cwd);
  let calls = 0;
  const app = await createApplication({cwd, config, env: {}, authPath: join(cwd, 'auth.json'), provider: {respond: async () => {calls++; throw new Error('不该调用模型');}}});
  try {
    const before = app.store.getSnapshot().messages.length;
    for (const [command, tab] of [['/status', 'status'], ['/config', 'config'], ['/help', 'commands']]) {
      await app.submit(command!); const page = app.surfaces.getSnapshot(); assert.ok(page?.kind === 'page'); assert.equal(page.initialTab, tab);
      app.surfaces.cancel();
    }
    await app.submit('/provider'); await Promise.resolve();
    const picker = app.surfaces.getSnapshot(); assert.ok(picker?.kind === 'picker');
    app.surfaces.cancel(); assert.equal(app.store.getSnapshot().messages.length, before);
    await app.submit('/providers'); await Promise.resolve();
    await app.surfaces.choose(app.surfaces.getSnapshot()!.id, 'beta');
    assert.equal(app.commandContext().models[0], 'second');
    await app.submit('/model alpha/custom/model'); assert.equal(app.commandContext().models[0], 'custom/model');
    assert.equal(calls, 0); assert.deepEqual(await app.journal.load(app.sessionId, 'logox'), []);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
