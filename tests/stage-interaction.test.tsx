import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Profiler} from 'react';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/stage.js';
import {actionAt} from '../src/tui/scene.js';
import {extractSelection} from '../src/tui/viewport.js';
import {contentPoint, selectionRange, type ContentSelection} from '../src/tui/selection.js';
import {decorateRow, stepIcon} from '../src/tui/row-presentation.js';
import {encodeRow} from '../src/tui/terminal-plane.js';
import {StatusbarPreferences} from '../src/config/statusbar-preferences.js';
import {App} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
function clipboard(output: TerminalScreen): string {const all = [...output.text.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)]; return Buffer.from(all.at(-1)?.[1] ?? '', 'base64').toString('utf8');}
function strip(text: string): string {return text.replace(/\x1b\[[\d;]*m/g, '');}
function mount(store: RuntimeStore, extra: Partial<React.ComponentProps<typeof App>> = {}, height = 24) {
  const input = new Input(), output = new TerminalScreen(), stopped: string[] = [];
  output.columns = 80; output.rows = height; let commits = 0;
  const instance = renderTerminal(<Profiler id="app" onRender={() => {commits++;}}><App stage sessionId="s" store={store} onSubmit={async () => {}} onCancel={id => stopped.push(id)} onClose={async () => {}} {...extra}/></Profiler>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false});
  const settle = async (ms = 60) => {await delay(ms); await instance.waitUntilRenderFlush();};
  const key = async (text: string) => {input.write(text); await settle();};
  const mouse = async (kind: number, x: number, y: number, release = false) => key(`\x1b[<${kind};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
  return {input, output, instance, stopped, settle, key, mouse, commits: () => commits,
    async close() {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
function actor(store: RuntimeStore) {
  store.activities.create({sessionId: 's', ownerId: 'techne', activityId: 'actor', kind: 'actor', title: '整理布局', status: 'running', stage: '执行', detail: ''});
  store.message('s', 'techne', 'user', '整理布局', {activityId: 'actor', inputKind: 'director', source: 'logox'});
}

test('折叠只命中实际图标标题，展开灰底优先，露出背景命中 Actor，标题与框线均可复制', () => {
  const store = new RuntimeStore(); actor(store);
  const id = store.message('s', 'techne', 'notice', 'read\n完整结果', {activityId: 'actor', kind: 'tool', step: {title: 'read README.md', state: 'completed', elapsedMs: 1200}});
  const folded = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {actor: true}, null);
  const row = folded.find(row => row.messageId === id)!;
  assert.equal(actionAt(row, row.gutterCols)?.foldId, id);
  assert.equal(actionAt(row, row.gutterCols - 1)?.foldId, 'actor');
  assert.equal(actionAt(row, row.gutterCols + stringWidth('▮ read README.md'))?.foldId, 'actor', '耗时与行尾空白不扩大标题命中');
  const open = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {actor: true, [id]: true}, null);
  const body = open.find(row => row.text === '完整结果')!;
  assert.equal(body.bg, '#22252a'); assert.equal(actionAt(body, 76)?.foldId, id);
  assert.equal(actionAt(body, 2)?.foldId, 'actor');
  const header = open.findIndex(row => row.messageId === 'actor');
  assert.match(extractSelection(open, {anchor: {x: 2, y: header}, focus: {x: 78, y: header}}), /Techne.*整理布局.*停止/);
  const cap = open.findIndex(row => row.messageId === 'actor-top');
  assert.match(extractSelection(open, {anchor: {x: 2, y: cap}, focus: {x: 78, y: cap}}), /^▄+$/);
  for (const [index, row] of open.entries()) assert.equal(strip(encodeRow(row, index, {anchor: {x: 3, y: index}, focus: {x: 23, y: index}})), strip(encodeRow(row, index, null)), '选中不改变字符、内边距和字距');
});

test('内容端点在滚动、追加和缩放后保持正文与角色标题位置', () => {
  const store = new RuntimeStore(); actor(store);
  const id = store.message('s', 'logox', 'assistant', '正文 ' + 'abcdefgh 中文🙂 '.repeat(30));
  const wide = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {}, null);
  const at = wide.findIndex(row => row.messageId === id), header = wide.findIndex(row => row.messageId === 'actor');
  const selection: ContentSelection = {anchor: contentPoint(wide, at, 8), focus: contentPoint(wide, at + 2, 22)};
  const copied = extractSelection(wide, selectionRange(wide, selection));
  store.appendMessage(id, '\n追加内容'); store.message('s', 'logox', 'assistant', '新的消息');
  const narrow = buildStageRows(store.getSnapshot(), 's', 'logox', 30, {}, null);
  assert.equal(extractSelection(narrow, selectionRange(narrow, selection)), copied);
  const title = wide[header]!;
  const titleColumn = 2 + title.selectionCells!.find(cell => cell.key === 'actor:title')!.column;
  const heading: ContentSelection = {anchor: contentPoint(wide, header, titleColumn), focus: contentPoint(wide, header, titleColumn + 6)};
  assert.equal(extractSelection(narrow, selectionRange(narrow, heading)), '整理布局');
});

test('真实 Ink 鼠标松开才折叠，拖选标题和停止文字不会操作，内层灰底与 Actor 背景各自收起', {timeout: 7000}, async () => {
  const store = new RuntimeStore(); actor(store);
  store.message('s', 'techne', 'notice', 'read\n可选择的工具结果', {activityId: 'actor', kind: 'tool'});
  const ui = mount(store);
  try {
    await ui.settle();
    const heading = ui.output.lines.findIndex(line => line.includes('Techne'));
    await ui.mouse(0, 8, heading); await ui.mouse(0, 8, heading, true); await ui.settle(200);
    let line = ui.output.lines.findIndex(line => line.includes('read'));
    assert.ok(line >= 0);
    const titleX = ui.output.lines[line]!.indexOf('read');
    await ui.mouse(0, titleX, line);
    assert.ok(!ui.output.lines.some(line => line.includes('可选择的工具结果')), '按下不展开');
    await ui.mouse(32, titleX + 3, line); await ui.mouse(0, titleX + 3, line, true);
    assert.equal(clipboard(ui.output), 'read'); assert.deepEqual(ui.stopped, []);
    assert.ok(!ui.output.lines.some(line => line.includes('可选择的工具结果')));
    const stopLine = ui.output.lines.findIndex(line => line.includes('■ 停止')), stopX = stringWidth(ui.output.lines[stopLine]!.split('■')[0]!);
    await ui.mouse(0, stopX, stopLine); await ui.mouse(32, stopX + 5, stopLine); await ui.mouse(0, stopX + 5, stopLine, true);
    assert.equal(clipboard(ui.output), '■ 停止'); assert.deepEqual(ui.stopped, []);
    await ui.mouse(0, titleX, line); await ui.mouse(0, titleX, line, true);
    const resultLine = ui.output.lines.findIndex(line => line.includes('可选择的工具结果')); assert.ok(resultLine >= 0);
    await ui.mouse(0, 70, resultLine); await ui.mouse(0, 70, resultLine, true);
    assert.ok(!ui.output.lines.some(line => line.includes('可选择的工具结果')));
    assert.ok(ui.output.lines.some(line => line.includes('read')), '关闭内层保留 Actor');
    line = ui.output.lines.findIndex(line => line.includes('read'));
    await ui.mouse(0, 70, line); await ui.mouse(0, 70, line, true); await ui.settle(200);
    assert.ok(!ui.output.lines.some(line => line.includes('read')), '露出 Actor 底色收起 Actor');
    assert.ok(ui.output.lines.some(line => line.includes('Techne')));
  } finally {await ui.close();}
});

test('真实 Ink 选区跨滚动和追加保持内容，拖到边缘自动滚动，缩放后仍复制同一段', {timeout: 7000}, async () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', Array.from({length: 60}, (_, i) => 'LINE-' + String(i).padStart(2, '0') + ' abcdefghijklmnopqrstuvwxyz').join('\n'));
  const ui = mount(store, {}, 18);
  try {
    await ui.settle();
    await ui.mouse(0, 2, 4); await ui.mouse(32, 20, 5); await ui.mouse(0, 20, 5, true);
    const before = clipboard(ui.output); assert.match(before, /LINE-/);
    await ui.key('\x1b[<64;5;5M'); store.appendMessage(id, '\n追加'); await ui.settle(); await ui.key('\x03');
    assert.equal(clipboard(ui.output), before);
    ui.output.resize(25, 18); await ui.settle(); await ui.key('\x03'); assert.equal(clipboard(ui.output), before);
    ui.output.resize(80, 18); await ui.settle();
    const top = ui.output.lines[0];
    await ui.mouse(0, 2, 4); await ui.mouse(32, 15, 0); await ui.settle(220);
    assert.notEqual(ui.output.lines[0], top, '边缘拖动自动向历史滚动');
    await ui.mouse(0, 15, 0, true); const extended = clipboard(ui.output);
    assert.ok(extended.split('\n').length >= 7, '选区覆盖越过视口边缘的历史');
  } finally {await ui.close();}
});

test('运行点阵、Thinking 流光和 Actor 呼吸只刷新画布，等待/终态静止，关闭动效仍更新耗时', {timeout: 7000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-motion-')), prefs = new StatusbarPreferences(join(dir, 'ui.json'));
  const store = new RuntimeStore(); actor(store);
  const steps = new Steps(store, {sessionId: 's', ownerId: 'techne', activityId: 'actor'}), thinking = steps.thinking();
  const ui = mount(store, {statusbar: prefs});
  try {
    await ui.settle();
    const before = ui.commits(), revision = store.getSnapshot().revision; ui.output.text = '';
    await ui.settle(1000);
    assert.equal(ui.commits(), before); assert.equal(store.getSnapshot().revision, revision);
    assert.ok(ui.output.text.includes('\x1b[48;2;'), 'Actor 背景在可见卡片中变化');
    // Open the actor and expose its active Thinking, then compare fixed geometry.
    const heading = ui.output.lines.findIndex(line => line.includes('Techne'));
    await ui.mouse(0, 8, heading); await ui.mouse(0, 8, heading, true); await ui.settle(200);
    assert.ok(ui.output.lines.some(line => line.includes('Thinking')));
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {actor: true}, null);
    const original = rows.find(row => row.messageId === thinking)!;
    const early = decorateRow(original, Date.now()), later = decorateRow(original, Date.now() + 320);
    assert.equal(stringWidth(early.displayText!), stringWidth(later.displayText!)); assert.notDeepEqual(early.segments, later.segments);
    assert.ok(early.segments!.length < 25, '相邻同色文字合并，局部动画不逐字发送 ANSI');
    const actorRow = rows.find(row => row.messageId === 'actor')!;
    const breathed = decorateRow(actorRow, Date.now()).bg!;
    const channels = (hex: string) => hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16));
    assert.ok(channels(breathed).every((value, index) => Math.abs(value - channels(actorRow.bg!)[index]!) <= 35), '呼吸缓慢改变暗底，不变成高亮填充');
    const minimum = decorateRow(actorRow, 1875).bg!;
    const maximum = decorateRow(actorRow, 625).bg!;
    assert.ok(channels(maximum).some((value, index) => Math.abs(value - channels(minimum)[index]!) >= 15), '一轮呼吸必须有肉眼可辨的底色色差');
    const resume = steps.wait(thinking, '等待回答'); await ui.settle(); ui.output.text = ''; await ui.settle(220);
    assert.equal(ui.output.text, '', '等待时可见活动动画全部停止');
    resume(); await ui.settle(); await prefs.saveMotion(false); await ui.settle();
    const disabled = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {actor: true}, null).find(row => row.messageId === thinking)!;
    const first = decorateRow(disabled, Date.now(), false), second = decorateRow(disabled, Date.now() + 400, false);
    assert.equal(first.bg, second.bg);
    assert.deepEqual(first.segments?.map(segment => [segment.color, segment.bg]), second.segments?.map(segment => [segment.color, segment.bg]));
    assert.notEqual(first.displayText, second.displayText, '关闭动效仍更新实际耗时');
    assert.equal(stepIcon(steps.get(thinking), Date.now(), false), '·');
    steps.finish(thinking, 'completed'); store.activities.update('s', 'actor', {status: 'completed'}); await ui.settle(); ui.output.text = ''; await ui.settle(220);
    assert.equal(ui.output.text, '', '终态停止计时与背景刷新');
    const restored = new StatusbarPreferences(join(dir, 'ui.json')); await restored.load(); assert.equal(restored.getSnapshot().motion, false);
    await writeFile(join(dir, 'ui.json'), '{bad'); await assert.rejects(prefs.saveMotion(true)); assert.equal(prefs.getSnapshot().motion, false);
  } finally {await ui.close(); await rm(dir, {recursive: true, force: true});}
});
