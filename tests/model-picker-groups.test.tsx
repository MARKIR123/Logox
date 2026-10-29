import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {TerminalScreen} from './terminal-screen.js';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {App} from '../src/tui/app.js';
import {Picker} from '../src/tui/panels/picker.js';
import {loadConfig} from '../src/config/config.js';
import {createApplication} from '../src/application.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
class TerminalOutput extends TerminalScreen {}
function frame(output: TerminalOutput): string {return output.lines.join('\n');}
function rowIndex(output: TerminalOutput, needle: RegExp): number {return output.lines.findIndex(line => needle.test(line));}
async function press(input: TerminalInput, instance: ReturnType<typeof render>, value: string): Promise<void> {
  await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();
}

test('Picker: two separators group title/tabs, search/models/effort, and shortcuts', async () => {
  const input = new TerminalInput(), output = new TerminalOutput();
  const items = [
    {id: 'inherit', label: 'Inherit current session model', description: 'Default'},
    {id: 'a1', label: 'same', description: '128k · ✦ low/high', group: 'alpha', effort: 'high', effortLevels: ['low', 'high']},
    {id: 'a2', label: 'alpha-only', description: '128k · -', group: 'alpha'},
    {id: 'b1', label: 'beta-only', description: '64k · ✦ high', group: 'beta', effort: 'high', effortLevels: ['high']},
  ];
  const chosen: string[] = [];
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<Picker title="Select Model for Techne" items={items} current="a1" width={80} height={16}
      onSelect={id => chosen.push(id)} onCancel={() => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  try {
    await instance.waitUntilRenderFlush();
    const screen = frame(output);
    // Header (title + tabs) → rule → page (search + models + effort) → rule → shortcuts.
    assert.match(screen, /Select Model for Techne/);
    assert.match(screen, /\[ alpha \]/);
    assert.match(screen, /\bbeta\b/);
    const tabRow = rowIndex(output, /\[ alpha \]/);
    const searchRow = rowIndex(output, /Search:/);
    assert.ok(tabRow > 0 && searchRow > tabRow, 'Search 在标签页下方');
    const titleRow = rowIndex(output, /Select Model for Techne/);
    assert.equal(tabRow, titleRow + 1, 'No rule separates title from provider tabs');
    const rules = output.lines.flatMap((line, index) => /^─+$/.test(line.trim()) ? [index] : []);
    const shortcutRow = rowIndex(output, /↑↓ Select/);
    assert.deepEqual(rules, [titleRow - 1, tabRow + 1, shortcutRow - 1], 'Retain outer rule and exactly two section rules');
    assert.equal(output.cursorPosition.y, searchRow, 'Native search caret follows the new header height');
    assert.ok(output.lines[searchRow + 1]?.replace(/│/g, '').trim() === '', 'Search 之后有一行空行（仅含面板侧边界）');
    assert.match(screen, /❯ .*same/);
    assert.match(screen, /alpha-only/);
    assert.doesNotMatch(screen, /beta-only/, '非当前标签页的模型不可见');
    assert.match(screen, /Inherit current session model/, '未分组条目在每个标签页都可见');
    // Effort remains in the page, separated from models by whitespace, not a rule.
    const effortRow = rowIndex(output, /✦ Thinking:/);
    const lastModelRow = rowIndex(output, /alpha-only/);
    assert.ok(effortRow > lastModelRow, '思考档位在模型列表下方');
    assert.equal(output.lines[effortRow - 1]?.trim(), '', 'Natural whitespace separates model list and effort');
    assert.ok(effortRow < shortcutRow - 1, 'Effort precedes the footer separator');
    assert.match(screen, /Tab Provider/);
    // Tab 切到 beta 标签页
    await press(input, instance, '\t');
    assert.match(frame(output), /\[ beta \]/);
    assert.match(frame(output), /beta-only/);
    assert.doesNotMatch(frame(output), /alpha-only/);
    assert.match(frame(output), /Inherit current session model/);
    await press(input, instance, '\r');
    assert.deepEqual(chosen, ['inherit'], '切页后默认选中本页首项');
    output.columns = 48; output.rows = 20;
    await act(async () => {output.emit('resize');});
    await instance.waitUntilRenderFlush();
    assert.match(frame(output), /Select Model for Techne/);
  } finally {
    await act(async () => {instance.unmount();});
  }
});

test('正式 /model：按供应商标签页呈现，标题带目标角色，Tab 切换供应商', {timeout: 15000}, async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({data: [{id: 'same'}, {id: request.url?.startsWith('/beta') ? 'beta-only' : 'alpha-only'}]}));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const cwd = await mkdtemp(join(tmpdir(), 'logox-model-tabs-')), input = new TerminalInput(), output = new TerminalOutput();
  const config = await loadConfig(cwd, {provider: {name: 'alpha', model: 'same'}, providers: {
    alpha: {base_url: 'http://127.0.0.1:' + address.port + '/alpha'},
    beta: {base_url: 'http://127.0.0.1:' + address.port + '/beta'},
  }}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'),
    provider: {respond: async () => {throw new Error('不应调用模型');}}});
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App stage sessionId={app.sessionId} store={app.store} surfaces={app.surfaces} authentication={app.authentication}
      getCommandContext={app.commandContext} onSubmit={app.submit} onCancel={app.cancel} onClose={app.close}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const key = async (value: string) => press(input, instance, value);
  try {
    await key('/model');
    await act(async () => {
      input.write('\r');
      for (let i = 0; i < 300; i++) {
        const state = app.surfaces.getSnapshot();
        if (state?.kind === 'picker' && state.status === 'ready') return;
        await delay(10);
      }
      throw new Error('模型目录未完成');
    });
    await instance.waitUntilRenderFlush();
    const snapshot = app.surfaces.getSnapshot();
    assert.equal(snapshot?.kind, 'picker');
    if (snapshot?.kind !== 'picker') throw new Error('picker expected');
    assert.match(snapshot.title, /^Select Model for /, '标题标明目标角色');
    const groups = new Set(snapshot.items.map(item => item.group).filter(Boolean));
    assert.ok(groups.has('alpha') && groups.has('beta'), '模型条目按供应商分组');
    assert.ok(!snapshot.items.some(item => item.label.includes(' / ')), '模型行不再拼 provider 前缀');
    const screen = frame(output);
    assert.match(screen, /\[ alpha \]/);
    assert.match(screen, /Search:/);
    assert.match(screen, /❯ .*same/);
    assert.doesNotMatch(screen, /alpha \/ same/);
    for (let i = 0; i < 8 && !/\[ beta \]/.test(frame(output)); i++) await key('\t');
    assert.match(frame(output), /\[ beta \]/);
    assert.match(frame(output), /beta-only/);
    // 取消后回到对话，不留下命令界面
    await key('\x1b');
    assert.equal(app.surfaces.getSnapshot(), null);
  } finally {
    await act(async () => {await app.close(); instance.unmount();});
    await instance.waitUntilExit(); input.destroy(); output.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(cwd, {recursive: true, force: true});
  }
});
