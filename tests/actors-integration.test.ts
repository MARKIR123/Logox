import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {builtinActors} from '../src/actors/builtins.js';
import {serializeActor} from '../src/actors/definitions.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {ProviderError} from '../src/providers/http.js';
import {waitForSnapshot} from './runtime-fixture.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {buildStageRows} from '../src/tui/stage.js';

test('Actor 自动压缩通知保留任务身份，跟随原卡收起展开，重启后仍归原卡', async () => {
  let calls = 0;
  const f = await fixture(async () => {calls++; return complete('已完成调查');});
  try {
    await direct(f.app, '整理资料');
    const activity = f.app.store.getSnapshot().activities.find(item => item.ownerId === 'scout')!;
    const notices = f.app.store.getSnapshot().messages.filter(message => message.ownerId === 'scout' && message.role === 'system' && message.text.startsWith('扬弃：'));
    assert.ok(notices.length > 0, '实际任务收尾应发布压缩结果');
    assert.ok(notices.every(message => message.activityId === activity.activityId));
    const rows = (app: typeof f.app, open: boolean) => buildStageRows(app.store.getSnapshot(), 'actors', 'logox', 119, {[activity.activityId]: open}, null);
    assert.ok(!rows(f.app, false).some(row => row.messageId === notices[0]!.id));
    assert.ok(rows(f.app, true).some(row => row.messageId === notices[0]!.id));
    await f.app.close();
    const restored = await createApplication(f.options);
    try {
      assert.equal(calls, 1, '恢复不重放任务或压缩');
      assert.ok(!rows(restored, false).some(row => row.messageId === notices[0]!.id));
      assert.ok(rows(restored, true).some(row => row.messageId === notices[0]!.id));
    } finally {await restored.close();}
  } finally {await f.cleanup();}
});

const complete = (title: string, report = '验证通过'): ModelTurn => ({stop: 'complete',
  message: {role: 'assistant', text: '原始工作细节\n【轮次摘要】\n标题：' + title + '\n报告：' + report}});
const call = (name: string, args: unknown): ModelTurn => ({stop: 'tools', message: {role: 'assistant', text: '',
  toolCalls: [{id: name, name, arguments: JSON.stringify(args)}]}});
async function fixture(respond: Provider['respond'], defaultModel = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-actors-integration-'));
  await mkdir(join(cwd, '.logox', 'actors'), {recursive: true});
  const role = {...builtinActors[1]!, id: 'scout', name: '自定义侦察者', prompt: '你是自定义侦察者。', skills: [],
    ...(defaultModel ? {defaultModel: {provider: 'local', model: 'special'}} : {})};
  await writeFile(join(cwd, '.logox', 'actors', 'scout.md'), serializeActor(role));
  await mkdir(join(cwd, '.logox', 'skills', 'paint'), {recursive: true});
  await writeFile(join(cwd, '.logox', 'skills', 'paint', 'SKILL.md'), '---\nname: paint\ndescription: 配色技能\n---\n检查配色。');
  const config = await loadConfig(cwd, {provider: {name: 'local', model: 'main'},
    providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}},
    models: {'local/main': {context_window: 131072}, 'local/special': {context_window: 131072}},
    context: {reserve_tokens: 20000}}, {}, cwd, cwd);
  const options = {cwd, sessionId: 'actors', config, env: {}, authPath: join(cwd, 'auth.json'),
    resourceOptions: {home: cwd, boundary: cwd}, provider: {respond}};
  const app = await createApplication(options);
  return {app, options, cwd, cleanup: async () => {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
async function direct(app: Awaited<ReturnType<typeof createApplication>>, text: string) {
  const count = app.store.getSnapshot().activities.length;
  await app.submit('@scout ' + text);
  await waitForSnapshot(app.store, snapshot => snapshot.activities.length > count && snapshot.activities.at(-1)?.status === 'completed');
}
test('正式动态角色：0旧轮收尾、原账本保留、主上下文只留锚点、重启与回退覆盖已删除角色', async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture(async request => {requests.push(request); return complete('找到边界', '证据位于 sample.ts:2');});
  try {
    await f.app.submit('/actors');
    const page = f.app.surfaces.getSnapshot();
    assert.ok(page?.kind === 'page' && page.tabs.some(tab => tab.id === 'actors' && tab.lines.join('\n').includes('自定义侦察者')));
    assert.ok(page.tabs.some(tab => tab.id === 'actors' && tab.lines.join('\n').includes('20000')), '展示继承项目后的生效预算');
    f.app.surfaces.cancel();
    await direct(f.app, '第一次调查');
    const first = f.app.store.getSnapshot().activities.at(-1)!;
    assert.equal(first.summary?.title, '找到边界');
    assert.equal(f.app.ensemble.isBusy(), false, '终态发布前完成收尾');
    const entries = await f.app.journal.load('actors', 'scout');
    assert.ok(entries.some(entry => entry.text.includes('原始工作细节')));
    const state = await f.app.journal.loadContext('actors', 'scout', entries);
    assert.deepEqual(state?.folded, [0]);
    assert.equal((await f.app.journal.load('actors', 'logox')).length, 0, '直接提示不改写主对话旧轮');
    const main = await f.app.contexts.prepare({sessionId: 'actors', ownerId: 'logox'}, {system: '检查索引', tools: []}, new AbortController().signal);
    assert.ok(main.request.messages.some(entry => entry.text.includes(first.activityId)));
    assert.ok(main.request.messages.every(entry => !entry.text.includes('sample.ts:2') && !entry.text.includes('原始工作细节')));
    await direct(f.app, '第二次调查');
    assert.ok(requests[1]!.messages.some(message => message.text.includes('找到边界')));
    assert.ok(requests[1]!.messages.every(message => !message.text.includes('原始工作细节')));
    assert.ok(!requests[0]!.system.includes('配色技能'), '未分配技能不进入Actor索引');
    await f.app.close();
    await rm(join(f.cwd, '.logox', 'actors', 'scout.md'));
    const restored = await createApplication(f.options);
    try {
      assert.equal(requests.length, 2, '恢复没有模型重放');
      assert.equal(restored.store.activities.get('actors', first.activityId)?.summary?.title, '找到边界');
      await restored.submit('/rewind');
      const picker = restored.surfaces.getSnapshot(); assert.ok(picker?.kind === 'picker');
      await restored.surfaces.choose(picker.id, first.activityId);
      assert.equal((await restored.journal.load('actors', 'scout')).length, 0);
      assert.equal(requests.length, 2);
    } finally {await restored.close();}
  } finally {await f.cleanup();}
});
test('正式任务模型不可用先确认，卡片保留转用身份；确认后预算与摘要使用实际模型', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    if (++calls === 1) throw new ProviderError('模型不存在', false, 'model_missing');
    return complete('任务接续完成');
  }, true);
  try {
    await f.app.submit('@scout 调查');
    await waitForSnapshot(f.app.store, state => state.interactions.some(item => item.status === 'pending'));
    const question = f.app.store.interactions.list().find(item => item.status === 'pending')!;
    assert.equal(calls, 1, '确认前没有替代请求');
    assert.equal(f.app.store.activities.get('actors', question.activityId)?.taskModel?.phase, 'confirming');
    f.app.store.interactions.respond(answerEnvelope(question, {kind: 'question', answers: {task_model: {type: 'option', optionId: 'switch'}}}));
    await waitForSnapshot(f.app.store, state => state.activities.at(-1)?.status === 'completed');
    const model = f.app.store.getSnapshot().activities.at(-1)!.taskModel;
    assert.equal(model?.actual.model, 'main'); assert.equal(model.initial.model, 'special'); assert.equal(model.switched, true);
    assert.equal(calls, 2);
    assert.equal(f.app.contexts.status({sessionId: 'actors', ownerId: 'scout'})?.window, 131072);
  } finally {await f.cleanup();}
});
test('任务借阅只改变本次技能索引，后续任务不继承', async () => {
  let calls = 0;
  const f = await fixture(async request => {
    calls++;
    if (calls === 1) {assert.ok(!request.system.includes('配色技能')); return call('borrow_skill', {name: 'paint'});}
    if (calls === 2) assert.ok(request.system.includes('配色技能'));
    if (calls === 3) assert.ok(!request.system.includes('配色技能'));
    return complete('配色要求已核对');
  });
  try {await direct(f.app, '借阅技能'); await direct(f.app, '新的任务'); assert.equal(calls, 3);}
  finally {await f.cleanup();}
});
test('塑造角色走精确正文审批，拒绝不落盘、不加入目录', async () => {
  const content = serializeActor({...builtinActors[2]!, id: 'builder'});
  let calls = 0;
  const f = await fixture(async request => ++calls === 1 ? call('craft_actor', {content}) : (() => {
    const result = request.messages.at(-1); assert.ok(result?.role === 'tool' && result.isError);
    return complete('保留角色方案');
  })());
  try {
    await f.app.submit('塑造角色');
    await waitForSnapshot(f.app.store, state => state.interactions.some(item => item.status === 'pending'));
    const permission = f.app.store.interactions.list().find(item => item.status === 'pending')!;
    assert.ok(permission.kind === 'permission'); assert.equal(permission.arguments.content, content);
    f.app.store.interactions.respond(answerEnvelope(permission, {kind: 'permission', decision: 'deny'}));
    await waitForSnapshot(f.app.store, state => state.activities.at(-1)?.status === 'completed');
    assert.equal(f.app.actors.find('builder'), undefined);
    await assert.rejects(readFile(join(f.cwd, '.logox', 'actors', 'builder.md')), {code: 'ENOENT'});
  } finally {await f.cleanup();}
});
