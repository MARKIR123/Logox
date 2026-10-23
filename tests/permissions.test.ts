import test from 'node:test';

import assert from 'node:assert/strict';

import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';

import {tmpdir} from 'node:os';

import {join} from 'node:path';

import {PermissionEngine, shellWords} from '../src/permissions/engine.js';

import {pathDanger} from '../src/permissions/paths.js';

import {createTestApplication as createApplication, finalizingProvider} from './runtime-fixture.js';

import {loadConfig} from '../src/config/config.js';

import {fork} from 'node:child_process';
import {once} from 'node:events';
import {withFileLock} from '../src/store/file-lock.js';
import {Tools} from '../src/tools/tools.js';

import {createAgent} from '../src/kernel/agent.js';

import {RuntimeStore} from '../src/runtime/store.js';

import type {ActorContext} from '../src/actors/ensemble.js';

import type {ModelMessage, ModelTurn} from '../src/runtime/messages.js';



async function fixture() {

  const cwd = await mkdtemp(join(tmpdir(), 'logox-permissions-'));

  const messages: ModelMessage[] = [], requests: string[] = [];

  const controller = new AbortController();

  const context: ActorContext = {sessionId: 's', ownerId: 'logox', activityId: 'a', history: [], signal: controller.signal,

    report() {}, say() {}, async record(message) {messages.push(message);}, async permission(request) {requests.push(request.tool); return false;},

    async ask() {return {status: 'cancelled', reason: '测试取消'};}};

  const permissions = new PermissionEngine(cwd), tools = new Tools(cwd, undefined, permissions);

  return {cwd, tools, permissions, context, controller, messages, requests, async close() {await rm(cwd, {recursive: true, force: true});}};

}

function call(name: string, args: unknown, id = name) {return {id, name, arguments: JSON.stringify(args)};}



test('真实 Tools：deny 优先、creative 普通写、敏感和链接直接阻止', async () => {

  const f = await fixture();

  try {

    await writeFile(join(f.cwd, 'a.txt'), 'hello');

    await f.permissions.add({scope: 'session', decision: 'allow', tool: 'read', pattern: '*'});

    const denied = await f.permissions.add({scope: 'session', decision: 'deny', tool: 'read', pattern: 'a.txt'});

    assert.match((await f.tools.execute(call('read', {file_path: 'a.txt'}), f.context)).text, /(?:denied|拒绝)/i);

    await f.permissions.revoke(denied.id);

    assert.equal((await f.tools.execute(call('read', {file_path: 'a.txt'}), f.context)).isError, false);

    f.permissions.mode = 'creative';

    assert.equal((await f.tools.execute(call('write', {file_path: 'b.txt', content: 'b'}), f.context)).isError, false);

    await writeFile(join(f.cwd, '.env'), 'secret');

    assert.equal((await f.tools.execute(call('read', {file_path: '.env'}), f.context)).isError, true);

    await mkdir(join(f.cwd, '.git'));

    await writeFile(join(f.cwd, '.git', 'config'), 'private');

    await symlink(join(f.cwd, '.git'), join(f.cwd, 'link'), 'junction');

    assert.equal((await f.tools.execute(call('read', {file_path: 'link/config'}), f.context)).isError, true);

    assert.equal((await f.tools.execute(call('shell', {command: 'Get-Content link/config'}), f.context)).isError, true);

    assert.deepEqual(f.requests, []);

  } finally {await f.close();}

});



test('creative 允许写入运行目录，凭据与版本库仍阻止', async () => {

  const cwd = await mkdtemp(join(tmpdir(), 'logox-runtime-write-'));

  try {

    const decide = (mode: 'default' | 'auto' | 'creative', path: string) => {

      const danger = pathDanger(path, 'write');

      return new PermissionEngine(cwd, mode).evaluate({tool: 'write', paths: [path], effect: 'write', risky: true, ...(danger ? {danger} : {})}).decision;

    };

    assert.equal(decide('creative', join(cwd, '.logox-ts', 'skills', 'public', 'note.md')), 'allow');

    assert.equal(decide('creative', join(cwd, '.logox', 'bulletin.md')), 'allow');

    assert.equal(decide('creative', join(cwd, '.ssh', 'id_rsa')), 'deny');

    assert.equal(decide('creative', join(cwd, '.git', 'config')), 'deny');

    assert.equal(decide('default', join(cwd, '.logox', 'bulletin.md')), 'ask');

  } finally {await rm(cwd, {recursive: true, force: true});}

});

test('项目规则持久、撤销、项目身份隔离与保存失败不生效', async () => {

  const f = await fixture();

  try {

    const rule = await f.permissions.add({scope: 'project', decision: 'allow', tool: 'write', pattern: '**'});

    await f.permissions.setMode('creative');

    const loaded = new PermissionEngine(f.cwd); await loaded.load(); assert.equal(loaded.mode, 'creative');

    assert.equal(loaded.snapshot()[0]?.id, rule.id);

    await loaded.revoke(rule.id);

    const next = new PermissionEngine(f.cwd); await next.load(); assert.equal(next.snapshot().length, 0);

    await assert.rejects(new PermissionEngine(tmpdir(), 'default', join(f.cwd, '.logox', 'permissions.json')).load(), /身份/);

    const blocker = join(f.cwd, 'block'); await writeFile(blocker, 'file');

    const failed = new PermissionEngine(f.cwd, 'default', join(blocker, 'rules'));

    await assert.rejects(failed.add({scope: 'project', decision: 'allow', tool: 'write', pattern: '*'}));

    assert.equal(failed.snapshot().length, 0);

  } finally {await f.close();}

});



test('Shell词元前缀与creative复合动态允许、明确危险阻止', async () => {

  const f = await fixture();

  try {

    await f.permissions.add({scope: 'session', decision: 'allow', tool: 'shell', pattern: 'git status'});

    const evaluate = (command: string) => f.permissions.evaluate({tool: 'shell', paths: [], risky: false, command}).decision;

    assert.equal(evaluate('git status --short'), 'allow'); assert.equal(evaluate('git status-other'), 'ask');

    f.permissions.mode = 'creative';

    for (const command of ['git status; echo x', 'git status | cat', 'echo $(whoami)', 'echo $HOME', 'Remove-Item a.txt', 'cat ../a']) assert.equal(evaluate(command), 'allow', command);
    for (const command of ['git reset --hard', 'cat .env']) assert.equal(evaluate(command), 'deny', command);

    assert.equal(evaluate('format C:'), 'deny');

    assert.equal(shellWords('echo "a;b"').compound, false);

    assert.equal(shellWords('echo "unterminated').dynamic, true);

    assert.equal((await f.tools.execute(call('shell', {command: 'echo x; echo y'}), f.context)).isError, false);

    assert.deepEqual(f.requests, []);

  } finally {await f.close();}

});



test('扩展所有嵌套路径经入口审核，未知工具默认审批且legacy不执行', async () => {

  const f = await fixture();

  try {

    assert.equal(await f.tools.authorizeExtension(call('mcp_read', {cwd: '.', paths: ['.env', '../outside'], nested: {file_path: '.git/config'}}), f.context), false);

    await assert.rejects(f.tools.authorizeExtension(call('mcp_read', {path: 'legacy/file'}), f.context), /legacy/);

    assert.deepEqual(f.requests, ['mcp_read']);

  } finally {await f.close();}

});



test('真实 Agent 有界只读并发、模型序落账、写工具边界与整批参数校验', async () => {

  const f = await fixture();

  try {

    let active = 0, maximum = 0; const execution: string[] = [];

    const original = f.tools.execute.bind(f.tools);

    f.tools.execute = async (item, context) => {

      execution.push(item.id); active++; maximum = Math.max(maximum, active);

      await new Promise(resolve => setTimeout(resolve, item.id === 'r1' ? 30 : 2));

      try {return await original(item, context);} finally {active--;}

    };

    await writeFile(join(f.cwd, 'a'), 'a'); f.permissions.mode = 'creative';

    const turns: ModelTurn[] = [{stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('read', {file_path: 'a'}, 'r1'), call('read', {file_path: 'a'}, 'r2'), call('read', {file_path: 'a'}, 'r3'), call('write', {file_path: 'b', content: 'b'}, 'w'), call('read', {file_path: 'b'}, 'r4')]}}, {stop: 'complete', message: {role: 'assistant', text: '完成'}}];

    const run = createAgent({cwd: f.cwd, store: new RuntimeStore(), tools: f.tools, provider: () => finalizingProvider({async respond() {return turns.shift()!;}}), iterations: 10, retries: 0, readonlyConcurrency: 2});

    await run('任务', f.context);

    assert.equal(maximum, 2); assert.deepEqual(execution, ['r1', 'r2', 'r3', 'w', 'r4']);

    assert.deepEqual(f.messages.filter(m => m.role === 'tool' && m.name !== '_FinishRound').map(m => m.role === 'tool' ? m.callId : ''), execution);

    turns.push({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('write', {file_path: 'bad', content: 'x'}), call('read', {file_path: 'a', limit: -1})]}}, {stop: 'complete', message: {role: 'assistant', text: '已修正'}});

    await run('参数错误', f.context); await assert.rejects(readFile(join(f.cwd, 'bad')));

    assert.equal(execution.length, 5);

  } finally {await f.close();}

});





test('真实 Agent 扩展 schema 合法才审批；拒绝不执行；无效扩展使整批不执行', async () => {

  const f = await fixture();

  try {

    let executed = 0;

    const turns: ModelTurn[] = [{stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('mcp_test', {path: 'a'})]}}, {stop: 'complete', message: {role: 'assistant', text: '完成'}}];

    const run = createAgent({cwd: f.cwd, store: new RuntimeStore(), tools: f.tools, provider: () => finalizingProvider({async respond() {return turns.shift()!;}}), iterations: 10, retries: 0,

      extraTools: [{name: 'mcp_test', description: 'test', parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false}}],

      async executeExtra() {executed++; return {text: 'done', isError: false};}});

    await run('扩展', f.context); assert.deepEqual(f.requests, ['mcp_test']); assert.equal(executed, 0);

    turns.push({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('write', {file_path: 'bad', content: 'x'}), call('mcp_test', {path: 5})]}}, {stop: 'complete', message: {role: 'assistant', text: '修正'}});

    await run('无效', f.context); await assert.rejects(readFile(join(f.cwd, 'bad'))); assert.equal(f.requests.length, 1);

  } finally {await f.close();}

});



test('真实 Tools 审批等待取消释放，Agent 保持工具配对', async () => {

  const f = await fixture();

  try {

    let entered!: () => void;

    const waiting = new Promise<void>(resolve => {entered = resolve;});

    f.context.permission = async () => {entered(); await new Promise<void>(resolve => f.controller.signal.addEventListener('abort', () => resolve(), {once: true})); return false;};

    const turns: ModelTurn[] = [{stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('write', {file_path: 'bad', content: 'x'}, 'w1'), call('write', {file_path: 'bad2', content: 'x'}, 'w2')]}}];

    const run = createAgent({cwd: f.cwd, store: new RuntimeStore(), tools: f.tools, provider: () => finalizingProvider({async respond() {return turns.shift()!;}}), iterations: 10, retries: 0});

    const task = run('等待', f.context); await waiting; f.controller.abort(); await assert.rejects(task);

    assert.deepEqual(f.messages.filter(message => message.role === 'tool').map(message => message.role === 'tool' ? message.callId : ''), ['w1', 'w2']);

    await assert.rejects(readFile(join(f.cwd, 'bad')));

  } finally {await f.close();}

});





test('正式应用 /permissions 页签、新增、撤销和模式重启恢复', async () => {

  const cwd = await mkdtemp(join(tmpdir(), 'logox-permission-command-'));

  const config = await loadConfig(cwd, {provider: {model: 'test'}}, {}, cwd, cwd);

  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, sessionId: 's'});

  try {

    await app.submit('/permissions'); assert.equal(app.surfaces.getSnapshot()?.kind, 'page'); app.surfaces.close();

    await app.submit('/permissions add project deny read private/**');

    const id = app.permissions.snapshot()[0]!.id;

    await app.submit('/permissions mode creative');

    await app.submit('/permissions revoke ' + id); assert.equal(app.permissions.snapshot().length, 0);

    await app.close();

    const restored = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, sessionId: 's'});

    try {assert.equal(restored.permissions.mode, 'creative'); assert.equal(restored.permissions.snapshot().length, 0);} finally {await restored.close();}

  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}

});


test('可信装配交接 MCP 审批：远端参数无效不询问，有效唯一审批；模型参数不能交接', async () => {
  const f = await fixture();
  try {
    let remoteExecutions = 0, validations = 0;
    const turns: ModelTurn[] = [];
    const outer = {name: 'mcp', description: 'MCP入口', parameters: {type: 'object', properties: {server: {type: 'string'}, tool: {type: 'string'}, arguments: {type: 'object'}}, required: ['server', 'tool', 'arguments'], additionalProperties: false}};
    const run = createAgent({cwd: f.cwd, store: new RuntimeStore(), tools: f.tools, provider: () => finalizingProvider({async respond() {return turns.shift()!;}}), iterations: 10, retries: 0,
      extraTools: [outer], extraApprovalHandled: ['mcp'], async executeExtra(item, context) {
        validations++;
        const raw: {arguments: {path?: unknown}} = JSON.parse(item.arguments);
        if (typeof raw.arguments.path !== 'string') return {text: '远端参数无效', isError: true};
        if (!await f.tools.authorizeExtension({id: item.id, name: 'mcp:test:read', arguments: JSON.stringify(raw.arguments)}, context)) return {text: '拒绝', isError: true};
        remoteExecutions++; return {text: '完成', isError: false};
      }});
    const turn = (args: unknown): ModelTurn => ({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('mcp', args)]}});
    const complete: ModelTurn = {stop: 'complete', message: {role: 'assistant', text: '结束'}};
    turns.push(turn({server: 'test', tool: 'read', arguments: {path: 1}}), complete);
    await run('无效', f.context); assert.equal(validations, 1); assert.equal(f.requests.length, 0); assert.equal(remoteExecutions, 0);
    turns.push(turn({server: 'test', tool: 'read', arguments: {path: 'a'}}), complete);
    await run('有效', f.context); assert.deepEqual(f.requests, ['mcp:test:read']); assert.equal(remoteExecutions, 0);
    const unknownRun = createAgent({cwd: f.cwd, store: new RuntimeStore(), tools: f.tools, provider: () => finalizingProvider({async respond() {return turns.shift()!;}}), iterations: 10, retries: 0,
      extraTools: [{name: 'unknown', description: 'unknown', parameters: {type: 'object', additionalProperties: true}}], async executeExtra() {remoteExecutions++; return {text: 'bad', isError: false};}});
    turns.push({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [call('unknown', {extraApprovalHandled: ['unknown']})]}}, complete);
    await unknownRun('模型伪造', f.context); assert.deepEqual(f.requests, ['mcp:test:read', 'unknown']); assert.equal(remoteExecutions, 0);
  } finally {await f.close();}
});

test('两个权限实例并行新增与撤销保留其他进程 deny，不复活已撤销规则', async () => {
  const f = await fixture();
  try {
    const deny = await f.permissions.add({scope: 'project', decision: 'deny', tool: 'read', pattern: 'private/**'});
    const left = new PermissionEngine(f.cwd), right = new PermissionEngine(f.cwd);
    await Promise.all([left.load(), right.load()]);
    const [a, b] = await Promise.all([left.add({scope: 'project', decision: 'allow', tool: 'write', pattern: 'a/**'}), right.add({scope: 'project', decision: 'allow', tool: 'write', pattern: 'b/**'})]);
    const check = new PermissionEngine(f.cwd); await check.load();
    assert.deepEqual(new Set(check.snapshot().map(rule => rule.id)), new Set([deny.id, a.id, b.id]));
    await Promise.all([left.load(), right.load()]);
    const [, c] = await Promise.all([left.revoke(a.id), right.add({scope: 'project', decision: 'allow', tool: 'write', pattern: 'c/**'})]);
    await check.load(); assert.deepEqual(new Set(check.snapshot().map(rule => rule.id)), new Set([deny.id, b.id, c.id]));
    assert.equal(check.evaluate({tool: 'read', paths: ['private/file'], risky: false}).decision, 'deny');
    await left.add({scope: 'session', decision: 'deny', tool: 'write', pattern: 'local/**'});
    await left.setMode('creative');
    assert.ok(left.snapshot().some(rule => rule.scope === 'session')); await check.load(); assert.ok(check.snapshot().every(rule => rule.scope === 'project'));
  } finally {await f.close();}
});

function worker(root: string, operation: string, value = '') {
  return fork(new URL('./fixtures/permission-worker.js', import.meta.url), [root, operation, value], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
}
async function event(child: ReturnType<typeof worker>, kind: string) {
  const [message] = await once(child, 'message');
  assert.equal(message.kind, kind, JSON.stringify(message));
}
async function stop(child: ReturnType<typeof worker>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

test('真实两个进程并行 add/revoke：最新项目规则合并，deny 不丢失', {timeout: 10000}, async () => {
  const f = await fixture();
  const children: ReturnType<typeof worker>[] = [];
  try {
    await f.permissions.add({scope: 'project', decision: 'deny', tool: 'read', pattern: 'private/**'});
    const a = worker(f.cwd, 'add', 'a/**'), b = worker(f.cwd, 'add', 'b/**'); children.push(a, b);
    await Promise.all([event(a, 'ready'), event(b, 'ready')]);
    const done = Promise.all([event(a, 'done'), event(b, 'done')]); a.send('start'); b.send('start'); await done;
    await f.permissions.load(); assert.equal(f.permissions.snapshot().length, 3);
    const revoked = f.permissions.snapshot().find(rule => rule.pattern === 'a/**')!;
    const c = worker(f.cwd, 'revoke', revoked.id), d = worker(f.cwd, 'add', 'c/**'); children.push(c, d);
    await Promise.all([event(c, 'ready'), event(d, 'ready')]);
    const second = Promise.all([event(c, 'done'), event(d, 'done')]); c.send('start'); d.send('start'); await second;
    await f.permissions.load(); assert.deepEqual(f.permissions.snapshot().map(rule => rule.pattern).sort(), ['b/**', 'c/**', 'private/**']);
    assert.equal(f.permissions.evaluate({tool: 'read', paths: ['private/file'], risky: false}).decision, 'deny');
  } finally {await Promise.all(children.map(stop)); await f.close();}
});

test('真实持锁进程中断后两实例竞争恢复，不抢占活锁、不覆盖坏文件', {timeout: 10000}, async () => {
  const f = await fixture(); const file = join(f.cwd, '.logox', 'permissions.json');
  const child = worker(f.cwd, 'hold');
  try {
    await event(child, 'ready'); const locked = event(child, 'locked'); child.send('start'); await locked;
    await assert.rejects(f.permissions.add({scope: 'project', decision: 'deny', tool: 'read', pattern: '*'}), /另一个进程/);
    assert.equal(f.permissions.snapshot().length, 0);
    await stop(child);
    const other = new PermissionEngine(f.cwd);
    await Promise.all([f.permissions.add({scope: 'project', decision: 'deny', tool: 'read', pattern: 'a/**'}), other.add({scope: 'project', decision: 'deny', tool: 'read', pattern: 'b/**'})]);
    await f.permissions.load(); assert.equal(f.permissions.snapshot().length, 2);
    const before = f.permissions.snapshot(); await writeFile(file, 'broken');
    await assert.rejects(f.permissions.add({scope: 'project', decision: 'allow', tool: 'write', pattern: '*'}));
    assert.equal(await readFile(file, 'utf8'), 'broken'); assert.deepEqual(f.permissions.snapshot(), before);
    // 错误路径也应释放自己持有的锁。
    await withFileLock(file, async () => {});
  } finally {await stop(child); await f.close();}
});
