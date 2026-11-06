import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {act} from 'react';
import {RuntimeStore} from '../src/runtime/store.js';
import {App, type AppProps} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import type {StageStatus} from '../src/runtime/stage-status.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
const status = (ownerId: string): StageStatus => ({ownerId, name: ownerId === 'logox' ? 'Logox' : ownerId, state: 'Running', color: '#7a9ee0',
  model: {provider: 'anthropic', model: 'claude-opus-5-5'}, effort: 'high', permission: 'auto',
  modelInfo: {window: 200000, maxOutput: 64000}, context: {tokens: 121300, window: 200000, high: 168000, estimated: false, over: false,
    categories: {system: 9200, prompt: 6400, assistant: 26000, thinking: 7700, tools: 72000}},
  usage: {window: {input: 100, output: 50, cached: 900}, session: {input: 100, output: 50, cached: 900}}});

async function mount(extra: Partial<AppProps> = {}, rows = 24, columns = 100, store = new RuntimeStore()) {
  const input = new Input(), output = new TerminalScreen(), submitted: string[] = [];
  output.columns = columns; output.rows = rows;
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {
    instance = renderTerminal(<App store={store} sessionId="s" stage getStatus={status} onSubmit={async text => {submitted.push(text);}}
      onCancel={() => {}} onClose={async () => {}} {...extra}/>, {stdin: input, stdout: output, stderr: output, interactive: true,
      alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const mouse = async (x: number, y: number, code = 35, end = 'M') => {await act(async () => {input.write(`\x1b[<${code};${x};${y}${end}`); await delay(30);}); await instance.waitUntilRenderFlush();};
  const lines = () => output.lines;
  const close = async () => {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();};
  return {store, mouse, lines, submitted, close, output, input, instance};
}
/** 1-based column of the first cell of `needle` on the status row. */
const columnOf = (line: string, needle: string) => [...line.slice(0, line.indexOf(needle))].length + 1;

test('footer is two rows: status line above a quiet key-hint line', async () => {
  const f = await mount();
  try {
    const lines = f.lines();
    assert.match(lines[22]!, /Logox/); assert.match(lines[22]!, /█/);
    assert.match(lines[23]!, /Enter send · Shift\+Enter newline/);
  } finally {await f.close();}
});

test('very small heights drop the notification row', async () => {
  const f = await mount({}, 6);
  try {
    assert.match(f.lines()[5]!, /Logox/);
    assert.doesNotMatch(f.lines().join('\n'), /Enter send/);
  } finally {await f.close();}
});

test('hovering the gauge shows its detail on row 2 and leaving restores the hints', async () => {
  const f = await mount({}, 24, 140);
  try {
    const gauge = columnOf(f.lines()[22]!, '█');
    await f.mouse(gauge + 2, 23);
    assert.match(f.lines()[23]!, /ctx 121k\/200k 61%.*system 5%.*tools 36%.*free 39%.*compacts at 84%/);
    await f.mouse(2, 5);
    assert.match(f.lines()[23]!, /Enter send/);
  } finally {await f.close();}
});

test('hovering the model shows facts, and clicking it opens /model for the window', async () => {
  const f = await mount();
  try {
    const at = columnOf(f.lines()[22]!, 'claude-opus-5-5') + 1;
    await f.mouse(at, 23);
    assert.match(f.lines()[23]!, /claude-opus-5-5.*anthropic.*window 200k.*max out 64k.*click to change/);
    await f.mouse(at, 23, 0, 'M'); await f.mouse(at, 23, 0, 'm');
    assert.deepEqual(f.submitted, ['/model']);
    const perm = columnOf(f.lines()[22]!, 'Permission auto') + 3;
    await f.mouse(perm, 23); assert.match(f.lines()[23]!, /auto — /);
    await f.mouse(perm, 23, 0, 'M'); await f.mouse(perm, 23, 0, 'm');
    assert.deepEqual(f.submitted, ['/model', '/permissions']);
  } finally {await f.close();}
});

test('a notice owns row 2 over hover and hints, then expires', async () => {
  const f = await mount();
  try {
    // Ctrl+C on an empty draft asks for confirmation: a warning notice on row 2, status row untouched.
    await act(async () => {f.input.write('\x03'); await delay(40);}); await f.instance.waitUntilRenderFlush();
    assert.match(f.lines()[23]!, /▲ Press Ctrl\+C again to exit/);
    assert.match(f.lines()[22]!, /Logox/);
    const gauge = columnOf(f.lines()[22]!, '█');
    await f.mouse(gauge + 2, 23);
    assert.doesNotMatch(f.lines()[23]!, /ctx 121k/, 'notice outranks hover');
    await act(async () => {await delay(1700);}); await f.instance.waitUntilRenderFlush();
    assert.match(f.lines()[23]!, /ctx 121k/, 'after expiry the hover detail shows');
  } finally {await f.close();}
});

test('actor pills show state glyphs and hovering one shows its detail', async () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a1', ownerId: 'kalon', kind: 'actor', title: 'Retro SVG', taskTitle: 'Retro SVG', status: 'running', stage: 'Editing', detail: ''});
  store.activities.create({sessionId: 's', activityId: 'a2', ownerId: 'techne', kind: 'actor', title: 'Build', status: 'queued', stage: '', detail: ''});
  store.message('s', 'kalon', 'assistant', '⏵ Editing index.html\nbody', {activityId: 'a1'});
  const f = await mount({getActors: () => [
    {id: 'logox', name: 'Logox', title: 'Director', color: '#7a9ee0', symbol: '◈'},
    {id: 'kalon', name: 'Kalon', title: 'Reviewer', color: '#e8a8dc', symbol: '✦'},
    {id: 'techne', name: 'Techne', title: 'Builder', color: '#e5b567', symbol: '◇'}]}, 24, 120, store);
  try {
    const row = f.lines()[22]!;
    assert.match(row, /kalon/); assert.match(row, /◷ techne queued/);
    await f.mouse(columnOf(row, 'kalon') + 1, 23);
    assert.match(f.lines()[23]!, /✦ Kalon.*Retro SVG.*Editing index\.html.*click to open/);
    await f.mouse(columnOf(row, 'techne') + 1, 23);
    assert.match(f.lines()[23]!, /◇ Techne.*Queued/);
  } finally {await f.close();}
});
