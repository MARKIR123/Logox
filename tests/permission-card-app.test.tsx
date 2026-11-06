import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {App} from '../src/tui/app.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}

async function run(script: (key: (text: string) => Promise<void>, screen: () => string) => Promise<void>, extra: Record<string, unknown> = {}) {
  const input = new Input(), output = new TerminalScreen(), store = new RuntimeStore();
  output.columns = 100; output.rows = 30;
  const ticket = store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a', ownerId: 'techne', title: 'Allow shell?', tool: 'shell',
    arguments: {command: 'npm ci --ignore-scripts'}, reason: 'installs packages', mode: 'auto', suggestion: {tool: 'shell', pattern: 'npm ci', label: 'npm ci *'}, ...extra});
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App store={store} sessionId="s" onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>, {
      stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const key = async (text: string) => {await act(async () => {input.write(text); await delay(40);}); await act(async () => {await instance.waitUntilRenderFlush();});};
  const screen = () => output.text.split('\x1b[1;1H\x1b[J').at(-1)!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  try {await key('\t'); await script(key, screen); return await Promise.race([ticket.result, delay(500).then(() => undefined)]);}
  finally {store.interactions.close(); await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}
}

test('审批卡渲染：头部、$ 命令、风险行与模式、四个选项和快捷键', {timeout: 8000}, async () => {
  let shown = '';
  await run(async (_key, screen) => {shown = screen();});
  assert.match(shown, /Techne/); assert.match(shown, /wants to run · Shell/); assert.match(shown, /Awaiting approval/);
  assert.match(shown, /\$ npm ci --ignore-scripts/); assert.match(shown, /▲ installs packages\s+·\s+mode auto/);
  assert.match(shown, /Allow once\s+y/); assert.match(shown, /for this session\s+s/); assert.match(shown, /in this project\s+a/); assert.match(shown, /Deny and tell Techne why…\s+n/);
});

test('单键快捷键：y 允许一次，s 会话授权，a 项目授权；Enter 确认当前选项', {timeout: 8000}, async () => {
  for (const [shortcut, decision] of [['y', 'allow_once'], ['s', 'allow_session'], ['a', 'allow_project']] as const) {
    const outcome = await run(async key => {await key(shortcut);});
    assert.ok(outcome?.status === 'answered' && outcome.response.kind === 'permission' && outcome.response.decision === decision, shortcut);
  }
  const enter = await run(async key => {await key('\x1b[B'); await key('\r');});
  assert.ok(enter?.status === 'answered' && enter.response.kind === 'permission' && enter.response.decision === 'allow_session', '↓ 后 Enter');
});

test('拒绝说明：n 打开单行说明，Esc 返回，Enter 发送并带上说明；空说明直接拒绝', {timeout: 8000}, async () => {
  let opened = '';
  const outcome = await run(async (key, screen) => {
    await key('n'); opened = screen();
    await key('\x1b'); await key('n'); await key('先跑测试'); await key('\r');
  });
  assert.match(opened, /Tell Techne why/);
  assert.ok(outcome?.status === 'answered' && outcome.response.kind === 'permission' && outcome.response.decision === 'deny' && outcome.response.note === '先跑测试');
  const bare = await run(async key => {await key('n'); await key('\r');});
  assert.ok(bare?.status === 'answered' && bare.response.kind === 'permission' && bare.response.decision === 'deny' && bare.response.note === undefined);
});
