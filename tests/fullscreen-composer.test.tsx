import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {act} from 'react';
import stringWidth from 'string-width';
import chalk from 'chalk';
import type {SubmitDelivery} from '../src/application.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {AuthStorage} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {LoginFlow} from '../src/providers/login.js';
import {App, type AppProps} from '../src/tui/app.js';
import {palette} from '../src/tui/appearance/theme.js';
import {COMPOSER_EXPAND_LABEL, COMPOSER_EXPAND_PADDING, fullscreenEditorLayout} from '../src/tui/input/fullscreen-editor.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class FakeInput extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}

type Submission = {text: string; source: string | undefined; delivery: SubmitDelivery | undefined};
const actors: NonNullable<AppProps['getActors']> = () => [
  {id: 'logox', name: 'Logox', title: 'Director', symbol: '◇', color: palette.accent},
  {id: 'techne', name: 'Techne', title: 'Builder', symbol: '◇', color: palette.accent},
];

function addTask(store: RuntimeStore, id: string, ownerId = 'logox') {
  store.activities.create({sessionId: 's', activityId: id, ownerId, kind: ownerId === 'logox' ? 'director' : 'actor',
    title: id, status: 'running', stage: 'Working', detail: ''});
  store.message('s', ownerId, 'user', id + ' goal', {activityId: id, inputKind: 'human'});
  return store.message('s', ownerId, 'assistant', 'Working on ' + id, {activityId: id, kind: 'thinking',
    step: {title: 'Thinking', state: 'running', elapsedMs: 0}});
}

async function appFixture(options: Partial<AppProps> = {}, columns = 90, rows = 24) {
  const input = new FakeInput(), output = new TerminalScreen(), store = options.store ?? new RuntimeStore();
  output.columns = columns; output.rows = rows;
  const submissions: Submission[] = [], cancelled: string[] = [];
  let closed = 0;
  const props: AppProps = {sessionId: 's', stage: true, getActors: actors,
    getStatus: ownerId => ({ownerId, name: ownerId === 'logox' ? 'Logox' : 'Techne', state: 'running'}),
    ...options, store,
    onSubmit: async (text, source, delivery) => {submissions.push({text, source, delivery}); await options.onSubmit?.(text, source, delivery);},
    onCancel: id => {cancelled.push(id); options.onCancel?.(id);},
    onClose: async () => {closed++; await options.onClose?.();},
  };
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {
    instance = renderTerminal(<App {...props}/>, {stdin: input, stdout: output, stderr: output,
      interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const flush = () => act(async () => {await instance.waitUntilRenderFlush();});
  await flush();
  const key = async (text: string) => {
    await act(async () => {
      input.write(text);
      // Exercise a real bare Esc, including Ink's Alt-sequence disambiguation timer.
      if (text === '\x1b') await delay(40);
    });
    await flush();
  };
  const mouse = (button: number, x: number, y: number, release = false) => key(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
  const label = (text: string) => {
    const y = output.lines.findIndex(line => line.includes(text));
    assert.ok(y >= 0, `Visible control ${text} must exist`);
    const line = output.lines[y]!;
    return {x: stringWidth(line.slice(0, line.indexOf(text))), y};
  };
  const click = async (x: number, y: number) => {await mouse(0, x, y); await mouse(0, x, y, true);};
  return {
    input, output, store, submissions, cancelled, flush, key, mouse, label, click,
    get closed() {return closed;}, text: () => output.lines.join('\n'),
    async expand() {const p = label(COMPOSER_EXPAND_LABEL); await click(p.x + 1, p.y);},
    async select(foldId: string) {
      const rows = buildStageRows(store.getSnapshot(), 's', 'logox', output.columns - 1, {}, null);
      const ids = [...new Set(rows.flatMap(row => row.action?.foldId ? [row.action.foldId] : []))];
      const target = ids.indexOf(foldId); assert.ok(target >= 0, 'The task must have a selectable visible fold');
      const count = (target - 4 % ids.length + ids.length) % ids.length || ids.length;
      for (let index = 0; index < count; index++) await key('\x0e');
    },
    async resize(width: number, height: number) {await act(async () => {output.resize(width, height);}); await flush();},
    async close() {
      try {await act(async () => {instance.unmount();}); await instance.waitUntilExit();}
      finally {store.interactions.close(); input.destroy(); output.destroy();}
    },
  };
}

function assertCaretVisible(output: TerminalScreen) {
  assert.equal([...output.text.matchAll(/\x1b\[\?25([hl])/g)].at(-1)?.[1], 'h', 'The native IME caret must be visible');
  assert.ok(output.cursorPosition.x >= 0 && output.cursorPosition.x < output.columns);
  assert.ok(output.cursorPosition.y >= 0 && output.cursorPosition.y < output.rows);
}

test('normal composer adds only a right-aligned expand button and keeps Shift+Enter as newline', {timeout: 10000}, async () => {
  const f = await appFixture();
  try {
    const p = f.label(COMPOSER_EXPAND_LABEL), width = f.output.columns - 1;
    assert.equal(p.x, width - COMPOSER_EXPAND_PADDING - stringWidth(COMPOSER_EXPAND_LABEL));
    assert.equal(f.output.lines[p.y]!.slice(0, p.x).trim(), '', 'No leading pointer or placeholder is introduced');
    await f.key('left'); await f.key('\x1b[13;2u'); await f.key('second');
    assert.deepEqual(f.submissions, []);
    const first = f.label(COMPOSER_EXPAND_LABEL);
    assert.ok(f.output.lines[first.y]!.startsWith('left'));
    assert.equal(f.output.lines[first.y + 1], 'second');
    await f.key('\r');
    assert.deepEqual(f.submissions, [{text: 'left\nsecond', source: 'logox', delivery: {mode: 'queue'}}]);
    await f.resize(6, 8);
    assert.ok(!f.text().includes(COMPOSER_EXPAND_LABEL), 'Widths below six editor columns omit the entry');
    await f.resize(90, 24);
    assert.equal(f.label(COMPOSER_EXPAND_LABEL).x, width - COMPOSER_EXPAND_PADDING - stringWidth(COMPOSER_EXPAND_LABEL));
  } finally {await f.close();}
});

test('expand entry is only the four-corner icon and hover changes its foreground without moving the draft or caret', {timeout: 10000}, async () => {
  const previousLevel = chalk.level;
  chalk.level = 3;
  const f = await appFixture();
  const lastIconColor = () => [...f.output.text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m([^\x1b]*)/g)]
    .filter(match => match[4]!.includes(COMPOSER_EXPAND_LABEL)).at(-1)?.slice(1, 4).map(Number);
  const rgb = (color: string) => [1, 3, 5].map(start => Number.parseInt(color.slice(start, start + 2), 16));
  try {
    await f.key('draft');
    const p = f.label(COMPOSER_EXPAND_LABEL), before = f.text(), caret = {...f.output.cursorPosition};
    assert.equal(COMPOSER_EXPAND_LABEL, '⛶');
    assert.doesNotMatch(before, /\[⛶\]|[╭╮╰╯│]/, 'No brackets, rounded rectangle or new side borders');
    assert.deepEqual(lastIconColor(), rgb(palette.muted));
    const background = f.output.backgroundColors[p.y]?.[p.x];
    await f.mouse(35, p.x, p.y);
    assert.deepEqual(lastIconColor(), rgb(palette.strong));
    assert.equal(f.text(), before, 'Hover never changes icon size, input spacing or border geometry');
    assert.deepEqual(f.output.cursorPosition, caret, 'Hover never steals the input caret');
    assert.equal(f.output.backgroundColors[p.y]?.[p.x], background, 'Hover adds no background rectangle');
    assert.equal(f.submissions.length, 0); assert.equal(f.cancelled.length, 0);
    await f.mouse(35, p.x - 4, p.y);
    assert.deepEqual(lastIconColor(), rgb(palette.muted), 'Leaving restores the idle foreground');
    await f.mouse(35, p.x, p.y);
    assert.deepEqual(lastIconColor(), rgb(palette.strong));
    await f.resize(60, 24);
    const moved = f.label(COMPOSER_EXPAND_LABEL);
    assert.deepEqual(lastIconColor(), rgb(palette.muted), 'A moved control does not retain stale hover');
    await f.mouse(35, moved.x + 1, moved.y);
    assert.deepEqual(lastIconColor(), rgb(palette.strong), 'Transparent hit padding also highlights the icon');
    await f.mouse(35, f.output.columns - 1, moved.y);
    assert.deepEqual(lastIconColor(), rgb(palette.muted), 'The reserved terminal column is outside the hit area');
    await f.click(moved.x - COMPOSER_EXPAND_PADDING, moved.y);
    assert.match(f.text(), /Compose · Logox/, 'The unchanged padded target opens the editor');
    await f.key('\x1b');
    assert.match(f.text(), /draft/);
    assert.deepEqual(lastIconColor(), rgb(palette.muted), 'Returning from fullscreen starts with a non-stale icon');
  } finally {try {await f.close();} finally {chalk.level = previousLevel;}}
});

test('opening shares the exact draft/cursor, hides the timeline plane and Esc does not reach the running task', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'director-live');
  store.message('s', 'logox', 'assistant', 'Timeline-only sentinel');
  store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'director-live', ownerId: 'logox',
    title: 'Permission-only sentinel', tool: 'Write', arguments: {}, reason: 'Waiting for approval'});
  const f = await appFixture({store});
  try {
    assert.match(f.text(), /Timeline-only sentinel/);
    await f.key('abcd'); await f.key('\x1b[D'); await f.key('\x1b[D');
    await f.expand();
    assert.match(f.text(), /Compose · Logox/);
    assert.doesNotMatch(f.text(), /Timeline-only sentinel|Permission-only sentinel/);
    const g = fullscreenEditorLayout(f.output.columns - 1, f.output.rows);
    assertCaretVisible(f.output);
    assert.deepEqual(f.output.cursorPosition, {x: g.padding + 2, y: g.bodyY});
    await f.key('X');
    await f.key('\x07'); await f.key('\x0e'); await f.key('\x0f');
    assert.match(f.text(), /Compose · Logox/, 'Parent Actor/fold navigation cannot consume fullscreen keys');
    await f.mouse(0, 0, 0); await f.mouse(0, 0, 0, true);
    await f.key('\x1b');
    assert.doesNotMatch(f.text(), /Compose ·/);
    assert.match(f.text(), /Timeline-only sentinel/);
    assert.match(f.text(), /abXcd/);
    assert.deepEqual(f.cancelled, [], 'Fullscreen Esc is not a task cancellation');
    assert.equal(store.interactions.list()[0]!.status, 'pending');
    await f.key('Y'); await f.key('\r');
    assert.deepEqual(f.submissions, [{text: 'abXYcd', source: 'logox', delivery: {mode: 'queue'}}]);
    assert.equal(store.interactions.list()[0]!.status, 'pending');
  } finally {await f.close();}
});

test('fullscreen newline keys never submit or steer; Ctrl+Enter queues exactly once and ignores release', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'actor-live', 'techne');
  const f = await appFixture({store});
  try {
    await f.expand(); await f.key('one'); await f.key('\r');
    await f.key('two'); await f.key('\x1b[13;2u');
    await f.key('three'); await f.key('\x0a'); await f.key('four');
    assert.deepEqual(f.submissions, []);
    assertCaretVisible(f.output);
    await f.key('\x1b[13;5:1u'); await f.key('\x1b[13;5:3u');
    assert.deepEqual(f.submissions, [{text: 'one\ntwo\nthree\nfour', source: 'logox', delivery: {mode: 'queue'}}]);
    assert.doesNotMatch(f.text(), /Compose ·/);
    await f.expand();
    assert.match(f.text(), /Compose · Logox/, 'Ctrl+Enter must not leak to the parent Actor-card shortcut');
    assert.doesNotMatch(f.text(), /one|three/);
    await f.key('\x1b[13;5u');
    assert.equal(f.submissions.length, 1, 'An empty fullscreen draft is not dispatched');
    assert.deepEqual(f.cancelled, []);
  } finally {await f.close();}
});

test('mouse Send/collapse preserve failed drafts and never activate the pending permission underneath', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'director-live');
  store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'director-live', ownerId: 'logox',
    title: 'Do not answer this', tool: 'Write', arguments: {}, reason: 'Waiting'});
  let reject = true;
  const f = await appFixture({store, onSubmit: async () => {if (reject) throw new Error('Delivery rejected.');}});
  try {
    await f.key('retain me'); await f.expand();
    let g = fullscreenEditorLayout(f.output.columns - 1, f.output.rows);
    await f.click(g.sendX + 1, g.footerY);
    assert.equal(f.submissions.length, 1);
    assert.match(f.text(), /Delivery rejected\./);
    assert.match(f.text(), /retain me/);
    assert.equal(store.interactions.list()[0]!.status, 'pending');
    await f.expand();
    g = fullscreenEditorLayout(f.output.columns - 1, f.output.rows);
    await f.click(g.collapseX + 1, g.top);
    assert.doesNotMatch(f.text(), /Compose ·/);
    assert.match(f.text(), /retain me/);
    assert.equal(f.submissions.length, 1);
    reject = false; await f.expand();
    await f.click(g.sendX + 1, g.footerY);
    assert.deepEqual(f.submissions.map(item => item.text), ['retain me', 'retain me']);
    assert.ok(f.submissions.every(item => item.source === 'logox' && item.delivery?.mode === 'queue'));
    assert.equal(store.interactions.list()[0]!.status, 'pending');
    assert.deepEqual(f.cancelled, []);
  } finally {await f.close();}
});

test('pending acceptance cannot duplicate a fullscreen submission or erase edits made after sending', {timeout: 10000}, async () => {
  let release!: () => void;
  const accepted = new Promise<void>(resolve => {release = resolve;});
  const f = await appFixture({onSubmit: async () => {await accepted;}});
  try {
    await f.key('first'); await f.expand(); await f.key('\x1b[13;5u');
    await f.expand(); await f.key('\x1b[13;5u');
    assert.equal(f.submissions.length, 1);
    await f.key(' plus');
    await act(async () => {release(); await accepted;}); await f.flush();
    assert.match(f.text(), /first plus/);
    await f.key('\x1b[13;5u');
    assert.deepEqual(f.submissions.map(item => item.text), ['first', 'first plus']);
  } finally {release(); await f.close();}
});

test('fullscreen paste is not duplicated by the parent, survives resizing and submits only source newlines', {timeout: 10000}, async () => {
  const f = await appFixture();
  const lines = Array.from({length: 40}, (_, index) => `line ${index}: 中文🙂👩‍💻 e\u0301 ${'wrap '.repeat(8)}`);
  try {
    await f.key('AB'); await f.key('\x1b[D'); await f.expand();
    await f.key('\x1b[200~' + lines.join('\r\n') + '\x1b[201~');
    assert.deepEqual(f.submissions, []);
    for (const [columns, rows] of [[24, 8], [8, 4], [3, 2], [2, 1], [90, 24]]) {
      await f.resize(columns!, rows!);
      assert.ok(f.output.lines.every(line => stringWidth(line) <= columns!));
      assertCaretVisible(f.output);
    }
    await f.key('!'); await f.key('\x1b[13;5u');
    assert.deepEqual(f.submissions, [{text: 'A' + lines.join('\n') + '!B', source: 'logox', delivery: {mode: 'queue'}}]);
  } finally {await f.close();}
});

test('fullscreen Ctrl+T keeps the exact selected activity and stale targets retain the draft', {timeout: 10000}, async () => {
  const store = new RuntimeStore(), target = addTask(store, 'director-a'); addTask(store, 'director-b');
  const f = await appFixture({store});
  try {
    await f.select(target); await f.key('precise correction'); await f.expand(); await f.key('\x14');
    assert.deepEqual(f.submissions, [{text: 'precise correction', source: 'logox', delivery: {mode: 'steer', activityId: 'director-a'}}]);
    await f.key('keep this correction'); await f.expand();
    await act(async () => {store.activities.update('s', 'director-a', {status: 'completed'});}); await f.flush();
    await f.key('\x14');
    assert.equal(f.submissions.length, 1, 'A stale target cannot redirect to director-b');
    assert.match(f.text(), /keep this correction/);
    assert.match(f.text(), /no longer active|Select an active/i);
    await f.key('\x1b[13;5u');
    assert.deepEqual(f.submissions[1], {text: 'keep this correction', source: 'logox', delivery: {mode: 'queue'}});
    assert.deepEqual(f.cancelled, []);
  } finally {await f.close();}
});

test('Actor drafts and cursors remain independent when expanding, collapsing and returning to Logox', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'actor-live', 'techne');
  const f = await appFixture({store});
  try {
    await f.key('director draft'); await f.expand(); await f.key('!'); await f.key('\x1b');
    await f.key('\x07'); await f.key('actor draft'); await f.key('\x1b[D');
    await f.expand(); assert.match(f.text(), /Compose · Techne/); assert.doesNotMatch(f.text(), /director draft/);
    await f.key('X'); await f.key('\x1b');
    assert.doesNotMatch(f.text(), /director draft/, 'Esc collapses the Actor editor without returning to Logox');
    await f.key('Y'); await f.key('\r');
    assert.deepEqual(f.submissions[0], {text: 'actor drafXYt', source: 'techne', delivery: {mode: 'queue'}});
    await f.key('\x1b'); assert.match(f.text(), /director draft!/);
    await f.key('\r');
    assert.deepEqual(f.submissions[1], {text: 'director draft!', source: 'logox', delivery: {mode: 'queue'}});
    assert.deepEqual(f.cancelled, []);
  } finally {await f.close();}
});

test('question answer editing has no expand entry and does not share the normal composer draft', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'question-task');
  const ticket = store.interactions.open({kind: 'question', sessionId: 's', activityId: 'question-task', ownerId: 'logox', title: 'Question',
    questions: [{id: 'note', header: 'Note', question: 'What should be kept?'}]});
  const f = await appFixture({store});
  try {
    await f.key('normal draft'); await f.key('\t');
    assert.doesNotMatch(f.text(), /\[⛶\]/);
    await f.key('answer only'); await f.key('\x1b');
    await f.expand(); await f.key('!'); await f.key('\x1b');
    await f.key('\t'); await f.key('\r');
    const result = await ticket.result;
    assert.equal(result.status, 'answered');
    if (result.status === 'answered' && result.response.kind === 'question')
      assert.deepEqual(result.response.answers, {note: {type: 'text', text: 'answer only'}});
    else assert.fail('The pending question must receive a question answer');
    assert.deepEqual(f.submissions, []);
    await f.key('\r');
    assert.deepEqual(f.submissions, [{text: 'normal draft!', source: 'logox', delivery: {mode: 'queue'}}]);
  } finally {await f.close();}
});

test('local authentication keeps secret drafts outside the fullscreen composer and runtime streams', {timeout: 10000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-fullscreen-login-'));
  const authentication = new LoginFlow(new AuthStorage(join(directory, 'auth.json'), []), () => [], () => {},
    new CustomProviderStorage(join(directory, 'custom.json')), async () => {throw new Error('Network must not be used');}, undefined, async () => []);
  const f = await appFixture({authentication});
  let answer: ReturnType<LoginFlow['ask']> | undefined;
  try {
    await f.key('ordinary draft');
    await act(async () => {answer = authentication.ask({title: 'Local login', question: 'Synthetic key', secret: true});}); await f.flush();
    assert.doesNotMatch(f.text(), /\[⛶\]|Compose ·/);
    await f.key('fixture-secret-not-a-credential');
    assert.ok(!f.output.text.includes('fixture-secret-not-a-credential'));
    assert.ok(!JSON.stringify(f.store.getSnapshot()).includes('fixture-secret-not-a-credential'));
    assert.deepEqual(f.submissions, []);
    await act(async () => {authentication.cancel();}); await f.flush();
    assert.deepEqual(await answer, {status: 'cancelled'});
    await f.expand();
    assert.match(f.text(), /ordinary draft/);
    assert.doesNotMatch(f.text(), /fixture-secret|Synthetic key/);
    await f.key('\x1b[13;5u');
    assert.deepEqual(f.submissions, [{text: 'ordinary draft', source: 'logox', delivery: {mode: 'queue'}}]);
  } finally {
    await act(async () => {authentication.cancel();});
    await f.close(); await rm(directory, {recursive: true, force: true});
  }
});

test('fullscreen selection copies through OSC52 and Esc clears selection before collapsing', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'director-live');
  const f = await appFixture({store});
  try {
    await f.key('A🙂e\u0301Z'); await f.expand(); await f.key('\x01'); await f.key('\x03');
    const encoded = Buffer.from('A🙂e\u0301Z', 'utf8').toString('base64');
    assert.ok(f.output.text.includes(`\x1b]52;c;${encoded}\x07`));
    await f.key('\x1b');
    assert.match(f.text(), /Compose · Logox/, 'The first Esc clears selection, not the editor');
    await f.key('!');
    assert.match(f.text(), /A🙂e\u0301Z!/);
    await f.key('\x1b');
    assert.doesNotMatch(f.text(), /Compose ·/);
    assert.deepEqual(f.cancelled, []);
    await f.key('\r');
    assert.deepEqual(f.submissions, [{text: 'A🙂e\u0301Z!', source: 'logox', delivery: {mode: 'queue'}}]);
  } finally {await f.close();}
});

test('fullscreen wheel hides an offscreen native caret and restores it without moving the draft cursor', {timeout: 10000}, async () => {
  const f = await appFixture({}, 50, 12);
  const text = Array.from({length: 30}, (_, index) => 'row' + String(index).padStart(2, '0')).join('\n');
  try {
    await f.key('\x1b[200~' + text + '\x1b[201~'); await f.expand();
    assert.match(f.text(), /row29/); assertCaretVisible(f.output);
    await f.mouse(64, 3, 3);
    assert.doesNotMatch(f.text(), /row29/);
    assert.equal([...f.output.text.matchAll(/\x1b\[\?25([hl])/g)].at(-1)?.[1], 'l', 'A browsed-away caret must be hidden');
    await f.mouse(65, 3, 3);
    assert.match(f.text(), /row29/); assertCaretVisible(f.output);
    const g = fullscreenEditorLayout(f.output.columns - 1, f.output.rows);
    assert.deepEqual(f.output.cursorPosition, {x: g.padding + 5, y: g.bodyY + g.bodyHeight - 1});
    await f.mouse(64, 3, 3); await f.key('!');
    assert.match(f.text(), /row29!/); assertCaretVisible(f.output);
    await f.key('\x1b[13;5u');
    assert.deepEqual(f.submissions, [{text: text + '!', source: 'logox', delivery: {mode: 'queue'}}]);
  } finally {await f.close();}
});

test('collapse restores the original timeline anchor instead of following history updates or fullscreen wheel events', {timeout: 10000}, async () => {
  const store = new RuntimeStore();
  for (let index = 0; index < 60; index++) store.message('s', 'logox', 'assistant', 'history ' + String(index).padStart(2, '0'));
  const f = await appFixture({store});
  try {
    await f.mouse(64, 3, 2); await f.mouse(64, 3, 2);
    const original = f.output.lines.filter(line => /history \d+/.test(line));
    assert.ok(original.length > 0);
    assert.ok(!original.some(line => line.includes('history 59')), 'The fixture must start away from the tail');
    await f.expand();
    await act(async () => {store.message('s', 'logox', 'assistant', 'history 60');}); await f.flush();
    await f.mouse(64, 3, 3); await f.mouse(65, 3, 3);
    const g = fullscreenEditorLayout(f.output.columns - 1, f.output.rows);
    await f.click(g.collapseX + 1, g.top);
    assert.deepEqual(f.output.lines.filter(line => /history \d+/.test(line)), original);
    assert.equal(f.submissions.length, 0);
  } finally {await f.close();}
});

test('fullscreen Ctrl+D exits globally exactly once rather than editing or submitting the draft', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); addTask(store, 'director-live');
  const f = await appFixture({store});
  try {
    await f.key('do not submit'); await f.expand(); await f.key('\x04');
    assert.equal(f.closed, 1);
    assert.deepEqual(f.submissions, []);
    assert.deepEqual(f.cancelled, []);
  } finally {await f.close();}
});
