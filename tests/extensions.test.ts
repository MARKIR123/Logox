import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Mcp} from '../src/extensions/mcp.js';
import {McpClient} from '../src/extensions/mcp-client.js';
import {mcpServerSchema, hooksSchema} from '../src/extensions/config.js';
import {Hooks} from '../src/extensions/hooks.js';
import {observeTasks, ProjectExtensions} from '../src/extensions/runtime.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {waitForSnapshot} from './runtime-fixture.js';
import {answerEnvelope} from '../src/runtime/interactions.js';

function context(signal = new AbortController().signal): ActorContext {
  return {sessionId: 'synthetic', activityId: 'task', ownerId: 'logox', history: [], signal,
    report() {}, say() {}, record: async () => {}, ask: async () => ({status: 'cancelled', reason: 'fixture'}), permission: async () => false};
}
async function fixture(mode = 'normal', timeout = 2) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-mcp-')), log = join(cwd, 'server.jsonl');
  const config = mcpServerSchema.parse({command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs'), log, mode], timeout, startup_timeout_s: 1});
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {pid?: number; method?: string});
  return {cwd, log, config, events, cleanup: () => rm(cwd, {recursive: true, force: true})};
}
const call = (args: unknown) => ({id: 'c', name: 'mcp', arguments: JSON.stringify(args)});
const invoke = (toolArgs: unknown) => call({server: 'fixture', action: 'call', tool: 'echo', arguments: toolArgs});
async function waitForCall(f: Awaited<ReturnType<typeof fixture>>) {
  for (let count = 0; count < 100; count++) {if ((await f.events().catch(() => [])).some(event => event.method === 'tools/call')) return; await delay(10);}
  throw new Error('服务未收到调用');
}
test('MCP 惰性连接、分页目录、完整 schema 校验和唯一审批，拒绝不发远端调用', async () => {
  const f = await fixture(); let approvals = 0, allow = false;
  const mcp = new Mcp(f.cwd, {fixture: f.config}, async (request, ctx) => {
    if (request.action === 'list') return true;
    assert.equal(ctx.activityId, 'task'); assert.equal(request.tool, 'echo'); approvals++; return allow;
  });
  try {
    assert.equal(mcp.status()[0]?.state, 'stopped'); await assert.rejects(readFile(f.log));
    assert.equal(mcp.definitions()[0]?.name, 'mcp');
    const directory = await mcp.execute(call({server: 'fixture', action: 'list'}), context());
    assert.equal(directory.isError, false); assert.ok(directory.text.includes('choice'));
    for (const args of [{value: 0}, {value: 1, extra: true}, {value: 1, nested: {tag: 'wrong'}}, {value: '1'}, {value: 1, email: 'invalid'}]) {
      assert.equal((await mcp.execute(invoke(args), context())).isError, true);
    }
    assert.equal(approvals, 0);
    assert.equal((await mcp.execute(invoke({value: 1}), context())).isError, true);
    assert.equal(approvals, 1); assert.ok(!(await f.events()).some(event => event.method === 'tools/call'));
    allow = true;
    assert.deepEqual(await mcp.execute(invoke({value: 2, nested: {tag: 'ok'}}), context()), {text: 'echo:2', isError: false});
    assert.equal(approvals, 2);
    assert.equal((await mcp.execute(invoke({value: 2, mode: 'error'}), context())).isError, true);
  } finally {await mcp.close(); await mcp.close();
    const pid = (await f.events())[0]?.pid; assert.ok(pid); assert.throws(() => process.kill(pid, 0)); await f.cleanup();}
});
test('MCP preserves image blocks alongside text', async () => {
  const f = await fixture('image');
  const mcp = new Mcp(f.cwd, {fixture: f.config}, async () => true);
  try {
    const result = await mcp.execute(invoke({value: 1}), context());
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Screenshot captured/);
    assert.equal(result.images?.length, 1);
    assert.equal(result.images[0]!.mimeType, 'image/png');
    assert.equal(Buffer.from(result.images[0]!.data, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.doesNotMatch(result.text, /iVBOR/);
  } finally {await mcp.close(); await f.cleanup();}
});

test('MCP accepts screenshot responses over one MiB without discarding the image', async () => {
  const f = await fixture('large-image');
  const mcp = new Mcp(f.cwd, {fixture: f.config}, async () => true);
  try {
    const result = await mcp.execute(invoke({value: 1}), context());
    assert.equal(result.isError, false, result.text);
    assert.equal(result.images?.length, 1);
    assert.ok(result.text.length < 65_000);
  } finally {await mcp.close(); await f.cleanup();}
});

test('MCP rejects malformed image blocks instead of reporting successful visual evidence', async () => {
  const f = await fixture('bad-image');
  const mcp = new Mcp(f.cwd, {fixture: f.config}, async () => true);
  try {assert.equal((await mcp.execute(invoke({value: 1}), context())).isError, true);}
  finally {await mcp.close(); await f.cleanup();}
});

test('MCP images reach the next model request through the application', async () => {
  const f = await fixture('image');
  const config = await loadConfig(f.cwd, {provider: {model: 'test', context_window: 131072},
    mcp: {playwright: false, servers: {fixture: f.config}}}, {}, f.cwd, f.cwd);
  const extensions = new ProjectExtensions(f.cwd, config, {home: f.cwd, boundary: f.cwd}, async () => true);
  let turns = 0;
  const app = await createApplication({cwd: f.cwd, config, extensions, resourceOptions: {home: f.cwd, boundary: f.cwd},
    authPath: join(f.cwd, 'auth.json'), provider: {async respond(request) {
      if (++turns === 1) return {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [invoke({value: 1})]}};
      const result = request.messages.find(message => message.role === 'tool' && message.callId === 'c');
      assert.ok(result?.role === 'tool');
      assert.equal(result.isError, false, result.text);
      assert.equal(result.images?.length, 1);
      assert.equal(result.images[0]!.mimeType, 'image/png');
      assert.equal(Buffer.from(result.images[0]!.data, 'base64').subarray(1, 4).toString(), 'PNG');
      return {stop: 'tools', message: {role: 'assistant', text: 'Screenshot received.', toolCalls: [{
        id: 'finish', name: '_FinishRound', arguments: JSON.stringify({title: 'Screenshot verified', verification: 'Image received', carry_forward: []}),
      }]}};
    }}});
  try {
    const handle = app.ensemble.dispatch('logox', 'Inspect the screenshot.');
    await handle.done;
    assert.equal(turns, 2);
    assert.equal(app.store.getSnapshot().activities.find(item => item.activityId === handle.activityId)?.status, 'completed');
  } finally {await app.close(); await extensions.close(); await f.cleanup();}
});

test('Playwright is a lazy local default and can be disabled or explicitly overridden', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-browser-config-'));
  try {
    for (const [mcp, expected] of [[{}, true], [{playwright: false}, false],
      [{servers: {playwright: {command: process.execPath, args: ['custom-browser.mjs'], enabled: false}}}, true]] as const) {
      const config = await loadConfig(cwd, {mcp}, {}, cwd, cwd);
      const extensions = new ProjectExtensions(cwd, config, {home: cwd, boundary: cwd});
      try {
        const server = extensions.mcp.servers.playwright;
        assert.equal(!!server, expected);
        if ('servers' in mcp) {
          assert.equal(server?.enabled, false);
          assert.deepEqual(server?.args, ['custom-browser.mjs']);
        } else if (expected) {
          assert.equal(server?.command, process.execPath);
          assert.ok(server?.args[0]?.endsWith('cli.js'));
          assert.ok(server?.args.includes('--isolated'));
          assert.ok(server?.args.includes('--headless'));
          assert.equal(extensions.mcp.status().find(item => item.name === 'playwright')?.state, 'stopped');
        }
      } finally {await extensions.close();}
    }
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('MCP 同 $id 按工具和服务隔离，目录刷新释放旧校验并应用新约束及本地 $ref', async () => {
  for (const mode of ['schema-id-07', 'schema-id-2020']) {
    const first = await fixture(mode), second = await fixture('schema-id-other');
    let approvals = 0;
    const mcp = new Mcp(first.cwd, {first: first.config, second: second.config}, async request => {if (request.action !== 'list') approvals++; return true;});
    const invokeAt = (server: string, tool: string, value: string) => call({server, action: 'call', tool, arguments: {value}});
    const refresh = () => mcp.execute(call({server: 'first', action: 'list'}), context());
    try {
      assert.deepEqual(await mcp.execute(invokeAt('first', 'echo', 'old'), context()), {text: 'echo:old', isError: false});
      assert.deepEqual(await mcp.execute(invokeAt('first', 'choice', 'choice'), context()), {text: 'echo:choice', isError: false});
      assert.deepEqual(await mcp.execute(invokeAt('second', 'echo', 'other'), context()), {text: 'echo:other', isError: false});
      assert.equal((await mcp.execute(invokeAt('second', 'echo', 'old'), context())).isError, true);
      for (let iteration = 0; iteration < 3; iteration++) {
        assert.equal((await refresh()).isError, false);
        const before = approvals;
        assert.match((await mcp.execute(invokeAt('first', 'echo', 'old'), context())).text, /参数不符合完整 schema/);
        assert.equal(approvals, before);
        assert.deepEqual(await mcp.execute(invokeAt('first', 'echo', 'new'), context()), {text: 'echo:new', isError: false});
      }
      assert.equal(approvals, 6);
      assert.equal((await first.events()).filter(event => event.method === 'tools/call').length, 5);
      assert.equal((await second.events()).filter(event => event.method === 'tools/call').length, 1);
    } finally {await mcp.close(); await Promise.all([first.cleanup(), second.cleanup()]);}
  }
});

test('MCP 2020 schema 的 oneOf/const 生效，不只按目录类型校验', async () => {
  const f = await fixture(); let approvals = 0;
  const mcp = new Mcp(f.cwd, {fixture: f.config}, async request => {if (request.action !== 'list') approvals++; return true;});
  try {
    for (const value of ['no', 2]) assert.equal((await mcp.execute(call({server: 'fixture', action: 'call', tool: 'choice', arguments: {value}}), context())).isError, true);
    assert.equal(approvals, 0);
    assert.equal((await mcp.execute(call({server: 'fixture', action: 'call', tool: 'choice', arguments: {value: 'yes'}}), context())).text, 'echo:yes');
    assert.equal(approvals, 1);
  } finally {await mcp.close(); await f.cleanup();}
});
test('MCP 取消、超时、坏消息回收进程，下一次调用重新连接', async () => {
  for (const mode of ['cancel', 'timeout', 'bad'] as const) {
    const f = await fixture('normal', mode === 'timeout' ? 0.1 : 2);
    const mcp = new Mcp(f.cwd, {fixture: f.config}, async () => true);
    try {
      const controller = new AbortController();
      const operation = mcp.execute(invoke({value: 1, mode: mode === 'bad' ? 'bad' : 'wait'}), context(controller.signal));
      await waitForCall(f);
      if (mode === 'cancel') controller.abort();
      const result = await operation; assert.equal(result.isError, true); assert.match(result.text, /取消|超时|坏消息/);
      const pid = (await f.events())[0]?.pid; assert.ok(pid); assert.throws(() => process.kill(pid, 0));
      assert.equal((await mcp.execute(invoke({value: 1}), context())).isError, false);
    } finally {await mcp.close(); await f.cleanup();}
  }
});
test('MCP 启动取消、并行惰性连接、坏初始化、分页重复与不支持 transport', async () => {
  for (const mode of ['wait-init', 'bad-init', 'repeat-page', 'normal']) {
    const f = await fixture(mode); const client = new McpClient(f.config, f.cwd);
    try {
      const controller = new AbortController();
      const first = client.request('tools/list', {}, controller.signal);
      if (mode === 'wait-init') {await delay(80); controller.abort(); await assert.rejects(first, /取消/);}
      else if (mode === 'bad-init') await assert.rejects(first, /坏消息/);
      else if (mode === 'normal') {
        const second = client.request('tools/list', {}, controller.signal); await Promise.all([first, second]);
        assert.equal((await f.events()).filter(event => event.pid).length, 1);
      } else {
        await first;
        const mcp = new Mcp(f.cwd, {fixture: f.config});
        try {assert.match((await mcp.execute(call({server: 'fixture', action: 'list'}), context())).text, /cursor 重复/);}
        finally {await mcp.close();}
      }
    } finally {await Promise.all([client.close(), client.close()]); await f.cleanup();}
  }
  const f = await fixture();
  for (const config of [{...f.config, transport: 'http' as const}, {...f.config, command: join(f.cwd, 'missing.exe')}]) {
    const client = new McpClient(config, f.cwd);
    try {await assert.rejects(client.request('tools/list', {}, new AbortController().signal), /stdio|启动失败/);}
    finally {await client.close();}
  }
  await f.cleanup();
});
test('Application MCP 经真实交互审批与 Agent 落账，拒绝后能继续完成', async () => {
  const f = await fixture(); let turns = 0;
  const entries = ['session_start', 'post_tool_use', 'pre_compact', 'notification', 'stop'].map(event => ({event, command: process.execPath,
    args: ['-e', "process.stdin.on('data', d => process.stdout.write(d))"]}));
  const config = await loadConfig(f.cwd, {provider: {model: 'test', context_window: 131072}, mcp: {servers: {fixture: f.config}},
    hooks: {enabled: true, entries}}, {}, f.cwd, f.cwd);
  const app = await createApplication({cwd: f.cwd, config, resourceOptions: {home: f.cwd, boundary: f.cwd}, authPath: join(f.cwd, 'auth.json'),
    provider: {async respond(request) {
      if (++turns === 1) {assert.ok(request.tools.some(tool => tool.name === 'mcp')); return {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [invoke({value: 1})]}};}
      assert.ok(request.messages.some(message => message.role === 'tool' && message.isError));
      return {stop: 'complete', message: {role: 'assistant', text: '已按拒绝保留结果'}};
    }}});
  try {
    const handle = app.ensemble.dispatch('logox', '调用合成工具');
    await waitForSnapshot(app.store, state => state.interactions.some(item => item.status === 'pending'));
    const permission = app.store.interactions.list().find(item => item.status === 'pending')!;
    assert.equal(permission.kind, 'permission');
    app.store.interactions.respond(answerEnvelope(permission, {kind: 'permission', decision: 'deny'})); await handle.done;
    assert.equal(app.store.getSnapshot().activities.find(item => item.activityId === handle.activityId)?.status, 'completed');
    assert.ok(!(await f.events()).some(event => event.method === 'tools/call'));
    assert.ok((await app.journal.load(app.sessionId, 'logox')).some(item => item.message?.role === 'tool' && item.message.isError));
    await app.submit('/compact'); await app.extensions.hooks.drain();
    const history = app.extensions.hooks.history();
    for (const event of ['session_start', 'post_tool_use', 'pre_compact', 'notification', 'stop']) assert.ok(history.some(item => item.event === event && item.ok));
    const payload = JSON.parse(history.find(item => item.event === 'post_tool_use')!.output) as Record<string, unknown>;
    assert.equal(payload.tool, 'mcp'); assert.equal(payload.ok, false); assert.equal(payload.arguments, undefined);
    assert.equal(payload.text, undefined);
  } finally {await app.close(); await f.cleanup();}
});
test('外层项目扩展跨会话保留 MCP 连接，最终关闭才回收', async () => {
  const f = await fixture();
  try {
    const config = await loadConfig(f.cwd, {mcp: {servers: {fixture: f.config}}}, {}, f.cwd, f.cwd);
    const extensions = new ProjectExtensions(f.cwd, config, {home: f.cwd, boundary: f.cwd}, async () => true);
    await extensions.initialize();
    const first = await createApplication({cwd: f.cwd, config, extensions, authPath: join(f.cwd, 'auth.json')});
    await extensions.mcp.execute(invoke({value: 1}), context()); await first.close();
    assert.equal(extensions.mcp.status()[0]?.state, 'connected');
    const second = await createApplication({cwd: f.cwd, config, extensions, authPath: join(f.cwd, 'auth.json')});
    assert.equal((await extensions.mcp.execute(invoke({value: 2}), context())).text, 'echo:2');
    assert.equal((await f.events()).filter(item => item.pid).length, 1); await second.close();
    await extensions.close(); assert.equal(extensions.mcp.status()[0]?.state, 'closed');
  } finally {await f.cleanup();}
});
test('观察 hooks 接收 JSON、筛选工具、限制输出与历史；非零退出不阻止任务', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-hooks-')), diagnostics: string[] = [];
  const config = hooksSchema.parse({enabled: true, entries: [
    {event: 'post_tool_use', tool: 'read', command: process.execPath, args: ['-e', "process.stdin.on('data', d => process.stdout.write(d));"]},
    {event: 'stop', command: process.execPath, args: ['-e', "console.log('x'.repeat(20000));process.exitCode=3"]},
  ]});
  const hooks = new Hooks(cwd, config, text => diagnostics.push(text));
  try {
    hooks.emit('post_tool_use', {tool: 'write'}); await hooks.drain(); assert.equal(hooks.history().length, 0);
    hooks.emit('post_tool_use', {tool: 'read', ok: true}); await hooks.drain();
    assert.equal(JSON.parse(hooks.history()[0]!.output).event, 'post_tool_use');
    const execute = observeTasks(hooks, async () => {throw new Error('合成失败');});
    await assert.rejects(execute('x', context()), /合成失败/); await hooks.drain();
    assert.equal(hooks.history()[1]?.ok, false); assert.equal(hooks.history()[1]?.output.length, 8192);
    assert.match(diagnostics[0]!, /退出码 3/);
  } finally {await hooks.close(); await rm(cwd, {recursive: true, force: true});}
});
test('hooks 超时与关闭等待子进程回收，失败可诊断', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-hooks-stop-'));
  try {
    for (const close of [false, true]) {
      const hooks = new Hooks(cwd, hooksSchema.parse({enabled: true, timeout_s: close ? 5 : 0.1, entries: [
        {event: 'notification', command: process.execPath, args: ['-e', "console.log(process.pid);setInterval(() => {},1000)"]},
      ]}));
      hooks.emit('notification', {source: 'synthetic'});
      if (close) {await delay(80); await hooks.close();} else await hooks.drain();
      const result = hooks.history()[0]!; assert.equal(result.ok, false); assert.equal(result.reason, close ? '已取消' : '超时');
      const pid = Number(result.output.trim()); assert.ok(pid); assert.throws(() => process.kill(pid, 0)); await hooks.close();
    }
    const hooks = new Hooks(cwd, hooksSchema.parse({enabled: true, entries: [{event: 'stop', command: join(cwd, 'missing.exe'), args: ['--version']}]}));
    hooks.emit('stop', {ok: true}); await hooks.drain(); assert.equal(hooks.history()[0]?.reason, '启动失败'); await hooks.close();
  } finally {await rm(cwd, {recursive: true, force: true});}
});
test('用户与项目目录 hooks 发现、Shell 命令兼容与 notification 明确触发', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-hooks-discovery-')), home = join(cwd, 'home');
  try {
    for (const directory of [join(cwd, '.logox', 'hooks'), join(home, '.logox', 'hooks')]) {
      await mkdir(directory, {recursive: true}); await writeFile(join(directory, 'session_start.mjs'), "process.stdin.on('data', d => console.log(JSON.parse(d).event))");
    }
    const hooks = new Hooks(cwd, hooksSchema.parse({enabled: true, entries: [{event: 'notification', command: 'echo synthetic-notice'}]}), () => {}, home);
    await hooks.initialize(); hooks.emit('session_start', {session_id: 'synthetic'}); await hooks.drain();
    assert.equal(hooks.history().length, 2); assert.ok(hooks.history().every(item => item.ok && item.output.includes('session_start')));
    hooks.emit('notification', {session_id: 'synthetic'}); await hooks.drain();
    assert.ok(hooks.history()[2]?.output.includes('synthetic-notice')); await hooks.close();
  } finally {await rm(cwd, {recursive: true, force: true});}
});
