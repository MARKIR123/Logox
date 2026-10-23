import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Tools} from '../src/tools/tools.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import type {ActorContext} from '../src/actors/ensemble.js';

const call = (name: string, args: unknown) => ({id: name, name, arguments: JSON.stringify(args)});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-creative-reading-'));
  const engine = new PermissionEngine(cwd, 'creative'), tools = new Tools(cwd, undefined, engine);
  let questions = 0;
  const context: ActorContext = {sessionId: 'session', activityId: 'task', ownerId: 'logox', history: [], signal: new AbortController().signal,
    say() {}, report() {}, record: async () => {}, permission: async () => {questions++; return false;}, ask: async () => ({status: 'cancelled', reason: 'test'})};
  await mkdir(join(cwd, '.logox/state/sessions'), {recursive: true});
  await mkdir(join(cwd, '.logox/state/usage'), {recursive: true});
  await writeFile(join(cwd, '.logox/state/sessions/sample.json'), '{"error":"timeout-marker"}');
  await writeFile(join(cwd, '.logox/state/usage/sample.json'), '{"input":100,"output":10}');
  await writeFile(join(cwd, '.logox/auth.json'), 'credential-marker');
  return {cwd, engine, tools, context, questions: () => questions, cleanup: () => rm(cwd, {recursive: true, force: true})};
}

test('creative实际读取与搜索指定运行账本，无审批、不隐藏匹配；根目录默认搜索保持过滤', async () => {
  const f = await fixture();
  try {
    for (const name of ['read', 'grep', 'glob'] as const) {
      const args = name === 'read' ? {file_path: '.logox/state/sessions/sample.json'}
        : name === 'grep' ? {path: '.logox/state/sessions', pattern: 'timeout-marker', output_mode: 'content'}
        : {path: '.logox/state/sessions', pattern: '*.json'};
      const result = await f.tools.execute(call(name, args), f.context);
      assert.equal(result.isError, false, name + ': ' + result.text);
      assert.match(result.text, name === 'glob' ? /sample.json/ : /timeout-marker/);
    }
    assert.match((await f.tools.execute(call('grep', {path: '.logox/state/sessions/sample.json', pattern: 'timeout-marker', output_mode: 'content'}), f.context)).text, /timeout-marker/);
    assert.match((await f.tools.execute(call('glob', {pattern: '.logox/state/sessions/*.json'}), f.context)).text, /sample.json/);
    assert.match((await f.tools.execute(call('read', {file_path: '.logox/state/usage/sample.json'}), f.context)).text, /input/);
    const shell = process.platform === 'win32' ? "Get-Content '.logox/state/sessions/sample.json'" : "cat '.logox/state/sessions/sample.json'";
    assert.match((await f.tools.execute(call('shell', {command: shell}), f.context)).text, /timeout-marker/);
    assert.doesNotMatch((await f.tools.execute(call('grep', {pattern: 'timeout-marker|credential-marker'}), f.context)).text, /sample.json|credential-marker/);
    assert.equal(f.questions(), 0);
  } finally {await f.cleanup();}
});

test('运行记录读取在三档均走安全快路，扩展属性明确只读才免审，未知副作用按模式判断', async () => {
  const f = await fixture(); let reviews = 0;
  try {
    f.tools.configurePermissions('session', {reviewer: () => ({model: 'test', provider: {respond: async () => {
      reviews++; return {stop: 'complete', message: {role: 'assistant', text: '{"decision":"allow","reason":"普通运行记录诊断"}'}};
    }}})});
    await mkdir(join(f.cwd, '.logox-ts/state'), {recursive: true});
    await writeFile(join(f.cwd, '.logox-ts/state/sample.json'), 'runtime-marker');
    await writeFile(join(f.cwd, '.logox-ts/auth.json'), 'credential-marker');
    for (const mode of ['default', 'auto', 'creative'] as const) {
      f.engine.mode = mode;
      assert.equal((await f.tools.execute(call('read', {file_path: '.logox-ts/state/sample.json'}), f.context)).isError, false);
      assert.equal(await f.tools.authorizeExtension(call('mcp:diagnostics:read', {path: '.logox/state/usage/sample.json'}), f.context, 'read'), true);
    }
    assert.equal(reviews, 0); assert.equal(f.questions(), 0);
    f.engine.mode = 'creative';
    assert.equal(await f.tools.authorizeExtension(call('mcp:diagnostics:unknown', {path: '.logox/state/usage/sample.json'}), f.context), true);
    assert.equal(await f.tools.authorizeExtension(call('mcp:diagnostics:write', {path: '.logox/state/usage/sample.json'}), f.context, 'write'), true);
    assert.equal(await f.tools.authorizeExtension(call('mcp:diagnostics:read', {path: '.logox-ts/auth.json'}), f.context, 'read'), false);
    const command = process.platform === 'win32' ? "Get-Content '.logox-ts/auth.json'" : "cat '.logox-ts/auth.json'";
    assert.equal((await f.tools.execute(call('shell', {command}), f.context)).isError, true);
    f.engine.mode = 'auto';
    assert.equal(await f.tools.authorizeExtension(call('mcp:diagnostics:unknown', {path: '.logox/state/usage/sample.json'}), f.context), true);
    assert.equal(reviews, 1);
  } finally {await f.cleanup();}
});

test('creative区分诊断读取与真实凭据、运行状态修改，保留deny和链接复核', async () => {
  const f = await fixture();
  try {
    for (const name of ['read', 'grep'] as const) {
      const args = name === 'read' ? {path: '.logox/auth.json'} : {path: '.logox/auth.json', pattern: 'credential-marker'};
      assert.equal((await f.tools.execute(call(name, args), f.context)).isError, true);
    }
    // Creative mode permits modifying runtime state
    assert.equal((await f.tools.execute(call('write', {file_path: '.logox/state/sessions/sample.json', content: 'changed'}), f.context)).isError, false);
    assert.equal(await readFile(join(f.cwd, '.logox/state/sessions/sample.json'), 'utf8'), 'changed');
    assert.doesNotMatch((await f.tools.execute(call('grep', {path: '.logox', pattern: 'credential-marker|timeout-marker'}), f.context)).text, /credential-marker/);
    await mkdir(join(f.cwd, '.ssh'));
    await writeFile(join(f.cwd, '.ssh/id_ed25519'), 'credential-marker');
    await symlink(join(f.cwd, '.ssh'), join(f.cwd, '.logox/state/sessions/linked'), 'junction');
    assert.equal((await f.tools.execute(call('read', {file_path: '.logox/state/sessions/linked/id_ed25519'}), f.context)).isError, true);
    await f.engine.add({scope: 'session', decision: 'deny', tool: 'read', pattern: '.logox/state/**'});
    assert.equal((await f.tools.execute(call('read', {file_path: '.logox/state/sessions/sample.json'}), f.context)).isError, true);
    const command = process.platform === 'win32' ? "Remove-Item '.logox/state/sessions' -Recurse" : "rm -rf '.logox/state/sessions'";
    assert.equal((await f.tools.execute(call('shell', {command}), f.context)).isError, true);
    assert.equal(await readFile(join(f.cwd, '.logox/state/sessions/sample.json'), 'utf8'), 'changed');
    assert.equal(f.questions(), 0);
  } finally {await f.cleanup();}
});
