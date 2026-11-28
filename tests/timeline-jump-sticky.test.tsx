import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {viewport, type Anchor} from '../src/tui/timeline/viewport.js';
import {actionAt, type SceneRow} from '../src/tui/timeline/scene.js';
import {clickTimeline} from '../src/tui/timeline/timeline-click.js';
import {FADE_MS, JUMP_ID, STICKY_ID, glowStep, overlayView, pillBox, pillLabel, scrolledUp, stickyIndex, timelineView, unseenCount} from '../src/tui/timeline/timeline-overlay.js';
import {encodeRow, TerminalPlane} from '../src/tui/terminal/terminal-plane.js';
import {App} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {waitFor} from './wait-for.js';

const strip = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');
const lines = (prefix: string, count: number) => Array.from({length: count}, (_, i) => `${prefix} line ${i + 1}`).join('\n\n');

function conversation() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'completed', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'First question about the parser, please explain how tokens become a tree', {activityId: 'main', inputKind: 'human'});
  store.message('s', 'logox', 'assistant', lines('Answer one', 14), {activityId: 'main'});
  store.message('s', 'user', 'user', 'Second question about the printer', {activityId: 'main', inputKind: 'human'});
  store.message('s', 'logox', 'assistant', lines('Answer two', 14), {activityId: 'main'});
  return store;
}
const rowsOf = (store: RuntimeStore, width = 80) => buildStageRows(store.getSnapshot(), 's', 'logox', width, {}, null);
const at = (rows: readonly SceneRow[], index: number, height: number): Anchor => ({messageId: '__top__', line: Math.min(index, Math.max(0, rows.length - height))});
const top = (rows: readonly {text: string}[]) => strip(rows.map(row => row.text).join('\n'));

test('the jump pill shows only while the reading position is above the end, a one-row chip above the composer', () => {
  const rows = rowsOf(conversation()), height = 20, width = 80;
  const bottom = overlayView({rows, height, width, anchor: null});
  assert.equal(bottom.overlay.pill, undefined, 'hidden at the bottom');
  assert.equal(scrolledUp(rows, height, null), false);
  const up = overlayView({rows, height, width, anchor: at(rows, 0, height)});
  assert.ok(scrolledUp(rows, height, at(rows, 0, height)));
  const pill = up.overlay.pill!;
  assert.ok(pill, 'shown when scrolled up');
  assert.equal(pill.height, 1);
  assert.equal(pill.y + pill.height, height - 1, 'one row of air above the composer rule');
  assert.equal(pill.x, Math.floor((width - pill.width) / 2), 'centred');
  const shown = strip(encodeRow(up.rows[pill.y]!, 0, null, width));
  assert.match(shown, /▐ ↓ Latest {2}End ▌/);
  assert.doesNotMatch(shown, /[╭╮╰╯│]s*↓/, 'no box border');
  assert.equal(up.rows.length, height, 'floating: the row count never changes');
  for (let y = 0; y < height; y++) if (y !== pill.y) assert.equal(up.rows[y], viewport(rows, height, at(rows, 0, height)).rows[y], 'rows outside the pill are the real rows');
  assert.equal(pillBox(40, 3, 0), undefined, 'too short for a pill');
  assert.equal(pillBox(40, 5, 0)!.y, 4, 'flush when the timeline is short');
});

test('the pill over a card row keeps that row\'s rail and never spreads the card background into the gutter', () => {
  const rows = rowsOf(conversation()), height = 20, width = 80;
  const anchor = at(rows, 0, height), plain = viewport(rows, height, anchor).rows;
  const pill = overlayView({rows, height, width, anchor}).overlay.pill!;
  const under = plain[pill.y] as SceneRow;
  assert.ok(under.gutterCols > 0, 'the fixture row has a rail');
  const card = {...under, bg: '#223344'} as SceneRow;
  const covered = [...rows];
  covered[rows.indexOf(under)] = card;
  const view = overlayView({rows: covered, height, width, anchor});
  const row = view.rows[pill.y] as SceneRow;
  assert.equal(row.gutterCols, under.gutterCols, 'the rail stays the plane\'s, with its focus easing');
  assert.equal(row.railColor, under.railColor);
  assert.equal(encodeRow(row, 0, null, width).split('│')[0], encodeRow(card, 0, null, width).split('│')[0], 'the rail cell is painted exactly as on the covered row');
  const first = row.segments!.findIndex(segment => segment.text === '▐');
  assert.equal(stripWidth(row.segments!.slice(0, first)) + row.gutterCols, pill.x, 'the body starts after the rail and the chip sits where it should');
  assert.deepEqual(row.hits![0], {startCol: pill.x, endCol: pill.x + pill.width, action: {kind: 'jump_bottom'}}, 'hits stay in row columns');
});
const stripWidth = (segments: readonly {text: string}[]) => segments.reduce((sum, segment) => sum + [...segment.text].length, 0);

test('the label counts new messages, shortens with the width and drops out when nothing fits', () => {
  assert.equal(pillLabel(0, 80), '↓ Latest  End');
  assert.equal(pillLabel(3, 80), '↓ 3 new  End');
  assert.equal(pillLabel(150, 80), '↓ 99+ new  End');
  assert.equal(pillLabel(0, 16), '↓ Latest');
  assert.equal(pillLabel(0, 6), '↓');
  assert.equal(pillLabel(0, 4), '');
  const store = conversation(); const before = rowsOf(store).length;
  store.message('s', 'logox', 'assistant', 'A fresh reply', {activityId: 'main'});
  store.message('s', 'logox', 'assistant', 'And another one', {activityId: 'main'});
  const rows = rowsOf(store);
  assert.ok(unseenCount(rows, before) >= 2);
  assert.equal(unseenCount(rows, rows.length), 0);
  const baselines = {current: {} as Record<string, number>};
  assert.equal(timelineView(rowsOf(conversation()), 20, 80, null, baselines, 'logox').overlay.pill, undefined);
  assert.equal(baselines.current.logox, rowsOf(conversation()).length, 'the baseline follows the end while reading there');
  const grown = timelineView(rows, 20, 80, {messageId: '__top__', line: 0}, baselines, 'logox');
  assert.match(grown.overlay.pill!.label, /^↓ \d+ new  End$/, 'new items since leaving the bottom');
});

test('clicking the pill and the sticky header run the jump actions; outside the pill nothing happens', () => {
  const rows = rowsOf(conversation()), height = 20, width = 80;
  const view = overlayView({rows, height, width, anchor: at(rows, 0, height)});
  const pill = view.overlay.pill!;
  const set: (Anchor | null)[] = [];
  const ctx = {setAnchor: (next: Anchor | null) => {set.push(next);}} as never;
  {
    const row = view.rows[pill.y] as SceneRow;
    const act = actionAt(row, pill.x + 2)!;
    assert.equal(act.kind, 'jump_bottom'); assert.equal(row.hover?.foldId, JUMP_ID);
    clickTimeline(ctx, act, row, {x: pill.x + 2, y: pill.y} as never);
  }
  assert.deepEqual(set, [null], 'a jump to the bottom clears the anchor (follow the end)');
  assert.equal(actionAt(view.rows[pill.y] as SceneRow, pill.x - 1), undefined);
  assert.equal(actionAt(view.rows[pill.y] as SceneRow, pill.x + pill.width), undefined);
  assert.equal(viewport(rows, height, null).start, rows.length - height);
});

test('the sticky header pins the user message that began the exchange being read, and switches as you scroll', () => {
  const rows = rowsOf(conversation(), 80), height = 20, width = 80;
  const heads = rows.map((row, index) => row.turnStart ? index : -1).filter(index => index >= 0);
  assert.equal(heads.length, 2, 'each user message marks its turn');
  const [first, second] = heads as [number, number];
  // The message is visible: nothing pinned.
  assert.equal(overlayView({rows, height, width, anchor: at(rows, 0, height)}).overlay.sticky, undefined);
  assert.equal(stickyIndex(rows, first), -1, 'the header is the top row');
  // Scrolled into the first answer: the first message is pinned in the top row.
  const mid = first + 6;
  const view = overlayView({rows, height, width, anchor: at(rows, mid, height)});
  assert.equal(view.overlay.sticky, first);
  const sticky = strip(encodeRow(view.rows[0]!, 0, null, width));
  assert.match(sticky, /^❯ /, 'the user rail glyph');
  assert.match(sticky, /First question about the parser/);
  assert.match(sticky, /↑ Jump\s*$/);
  assert.equal(stringWidthOf(sticky), width, 'a full-width row');
  assert.equal(view.rows[1], viewport(rows, height, at(rows, mid, height)).rows[1], 'only the top row is covered');
  // Past the second message: the pin follows.
  const later = overlayView({rows, height, width, anchor: at(rows, second + 4, height)});
  assert.equal(later.overlay.sticky, second);
  assert.match(strip(encodeRow(later.rows[0]!, 0, null, width)), /Second question about the printer/);
  // The header of the next exchange is the top row: nothing is hidden under a stale pin.
  assert.equal(stickyIndex(rows, second), -1);
  // A narrow pin clips with an ellipsis.
  const narrow = overlayView({rows: rowsOf(conversation(), 30), height, width: 30, anchor: {messageId: '__top__', line: first + 6}});
  assert.match(strip(encodeRow(narrow.rows[0]!, 0, null, 30)), /…\s*$/);
});

test('clicking the sticky header puts that message at the top of the timeline', () => {
  const rows = rowsOf(conversation()), height = 12, width = 80;
  const first = rows.findIndex(row => row.turnStart);
  const anchor = {messageId: '__top__', line: first + 8} as Anchor;
  const view = overlayView({rows, height, width, anchor});
  const row = view.rows[0] as SceneRow;
  const act = actionAt(row, 10)!;
  assert.equal(act.kind, 'jump_message'); assert.equal(row.hover?.foldId, STICKY_ID);
  const set: (Anchor | null)[] = [];
  clickTimeline({setAnchor: (next: Anchor | null) => {set.push(next);}} as never, act, row, {x: 10, y: 0} as never);
  assert.equal(set.length, 1);
  assert.equal(viewport(rows, height, set[0]!).start, first, 'the message header is now the first row');
  assert.equal(overlayView({rows, height, width, anchor: set[0]!}).overlay.sticky, undefined, 'and the pin goes away');
});

test('an actor window pins the assignment that started its round', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'Port the parser', taskTitle: 'Port the parser', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'techne', 'user', 'Port the parser to the new token stream and keep the tests green', {activityId: 'a', inputKind: 'director', source: 'logox'});
  store.message('s', 'techne', 'assistant', lines('Working', 20), {activityId: 'a'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'techne', 80, {}, null);
  const head = rows.findIndex(row => row.turnStart);
  assert.ok(head >= 0, 'the assignment header is a turn start');
  const view = overlayView({rows, height: 14, width: 80, anchor: {messageId: '__top__', line: head + 7}});
  assert.equal(view.overlay.sticky, head);
  assert.match(strip(encodeRow(view.rows[0]!, 0, null, 80)), /Assignment.*Port the parser/);
});

test('the hover fade eases over about 150 ms in a few frames, both ways, and is immediate without motion', () => {
  let state = undefined as ReturnType<typeof glowStep>['state'] | undefined;
  const levels: number[] = [];
  for (const t of [0, 40, 80, 120, 150, 190]) {const step = glowStep(state, true, 1000 + t, true); state = step.state; levels.push(step.level); if (t >= FADE_MS) assert.equal(step.busy, false);}
  assert.equal(levels[0], 0); assert.equal(levels.at(-1), 1);
  assert.ok(levels.every((value, i) => i === 0 || value >= levels[i - 1]!), 'monotonic rise');
  assert.ok(levels.slice(1, 4).every(value => value > 0 && value < 1), 'three frames in between');
  const out = glowStep(state, false, 2000, true);
  assert.equal(out.level, 1); assert.equal(out.busy, true);
  const half = glowStep(out.state, false, 2075, true);
  assert.ok(half.level < 1 && half.level > 0, 'fades back');
  assert.deepEqual(glowStep(undefined, false, 5, true), {state: {from: 0, to: 0, since: -Infinity}, level: 0, busy: false}, 'a control nobody hovers is idle');
  const instant = glowStep(undefined, true, 0, false);
  assert.equal(instant.level, 1); assert.equal(instant.busy, false);
});

test('the plane repaints the hovered control through the fade and settles on the full colour', async () => {
  const rows = rowsOf(conversation()), height = 20, width = 80;
  const view = overlayView({rows, height, width, anchor: at(rows, 0, height)});
  const writes: string[] = [];
  const plane = new TerminalPlane(text => writes.push(text));
  plane.afterInkWrite('\x1b[?1049h');
  const frame = (hovered: string | null, motion = true) => ({rows: view.rows, start: view.start, width, height, selection: null, motion, hoveredFoldId: hovered});
  const middle = view.overlay.pill!.y;
  plane.present(frame(null)); plane.flush();
  const rest = strip((plane.rows[middle] as SceneRow).segments?.map(s => s.text).join('') ?? '');
  assert.match(rest, /▐ ↓ Latest {2}End ▌/);
  const colours = () => (plane.rows[middle] as SceneRow).segments!.map(segment => segment.bg ?? '').join(',');
  const restColours = colours();
  writes.length = 0;
  plane.present(frame(JUMP_ID));
  const first = colours();
  await waitFor(async () => colours(), value => value !== first, {timeoutMs: 2000, label: 'a fade frame'});
  const seen = new Set([first]);
  await waitFor(async () => {seen.add(colours()); return seen.size;}, count => count >= 3, {timeoutMs: 2000, label: 'several fade frames'});
  await waitFor(async () => {const before = colours(); await delay(80); return before === colours();}, same => same, {timeoutMs: 3000, label: 'the fade settles'});
  assert.notEqual(colours(), restColours, 'the hovered pill is filled');
  assert.ok(writes.length >= 3, 'each fade frame is its own write');
  plane.present(frame(null));
  await waitFor(async () => colours(), value => value === restColours, {timeoutMs: 3000, label: 'fades back'});
  plane.present(frame(JUMP_ID, false));
  assert.notEqual(colours(), restColours, 'without motion the hover applies at once');
  plane.dispose();
});

// -- the whole app: End and Enter on an empty composer, the mouse on the pill, the wheel, the sticky header on screen ------------------------------------

class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
function mount(store: RuntimeStore, height = 24) {
  const input = new Input(), output = new TerminalScreen();
  output.columns = 80; output.rows = height;
  const instance = renderTerminal(<App stage sessionId="s" store={store} onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false});
  const settle = async (ms = 80) => {await delay(ms); await instance.waitUntilRenderFlush();};
  const key = async (text: string) => {input.write(text); await settle();};
  const mouse = async (kind: number, x: number, y: number, release = false) => key(`\x1b[<${kind};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
  return {output, settle, key, mouse, async close() {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
const screen = (output: TerminalScreen) => output.lines.join('\n');

test('in the app: PageUp shows the pill and the pinned message; End and Enter jump back; a click on the pill jumps; typed text keeps End for the composer', async () => {
  const ui = mount(conversation());
  try {
    await ui.settle(200);
    assert.doesNotMatch(screen(ui.output), /↓ Latest/, 'at the bottom there is no pill');
    await ui.key('\x1b[5~'); await ui.key('\x1b[5~');
    await waitFor(async () => screen(ui.output), text => /↓ Latest {2}End/.test(text), {timeoutMs: 5000, label: 'the pill after scrolling up'});
    assert.match(screen(ui.output), /▐ ↓ Latest {2}End ▌/);
    await ui.key('\x1b[F');
    await waitFor(async () => screen(ui.output), text => !/↓ Latest/.test(text), {timeoutMs: 5000, label: 'End jumps to the bottom'});
    await ui.key('\x1b[5~'); await ui.key('\x1b[5~');
    await waitFor(async () => screen(ui.output), text => /↓ Latest/.test(text), {timeoutMs: 5000, label: 'up again'});
    await ui.key('\r');
    await waitFor(async () => screen(ui.output), text => !/↓ Latest/.test(text), {timeoutMs: 5000, label: 'Enter on an empty composer jumps'});
    await ui.key('\x1b[5~'); await ui.key('\x1b[5~');
    await waitFor(async () => screen(ui.output), text => /↓ Latest/.test(text), {timeoutMs: 5000, label: 'up a third time'});
    const lines = ui.output.lines;
    const y = lines.findIndex(line => /▐ ↓ Latest {2}End ▌/.test(line));
    assert.ok(y > 0);
    const x = lines[y]!.indexOf('↓');
    await ui.mouse(35, x, y);
    await ui.mouse(0, x, y); await ui.mouse(0, x, y, true);
    await waitFor(async () => screen(ui.output), text => !/↓ Latest/.test(text), {timeoutMs: 5000, label: 'a click on the pill jumps'});
    // With a draft, End belongs to the composer.
    await ui.key('\x1b[5~'); await ui.key('\x1b[5~');
    await waitFor(async () => screen(ui.output), text => /↓ Latest/.test(text), {timeoutMs: 5000, label: 'up a fourth time'});
    await ui.key('hello'); await ui.key('\x1b[F');
    assert.match(screen(ui.output), /↓ Latest/, 'End moved the caret, not the timeline');
  } finally {await ui.close();}
});

test('in the app: scrolling into an answer pins the question; clicking the pin scrolls to it', async () => {
  const ui = mount(conversation(), 20);
  try {
    await ui.settle(200);
    for (let i = 0; i < 40 && !/↑ Jump/.test(ui.output.lines[0] ?? ''); i++) await ui.mouse(64, 10, 5);
    await ui.settle(200);
    const pinned = ui.output.lines[0] ?? '';
    assert.match(pinned, /^❯ You.*question.*↑ Jump/, 'the top row is the pinned user message: ' + pinned);
    await ui.mouse(35, 6, 0); await ui.mouse(0, 6, 0); await ui.mouse(0, 6, 0, true);
    await ui.settle(300);
    const after = ui.output.lines[0] ?? '';
    assert.match(after, /^❯ You/, 'the message header is the top row after the click: ' + after);
    assert.doesNotMatch(after, /↑ Jump/, 'the pin itself is gone once its message is on screen');
    assert.match(ui.output.lines[1] ?? '', /question|Second|First/, 'the message text follows');
  } finally {await ui.close();}
});

function stringWidthOf(text: string): number {return [...text].length;}

test('the floating chip and sticky row never defeat hardware scrolling, and are repainted after it', () => {
  const rows = rowsOf(conversation()), height = 20, width = 80;
  const first = rows.findIndex(row => row.turnStart);
  const writes: string[] = [];
  const plane = new TerminalPlane(text => writes.push(text));
  plane.afterInkWrite('\x1b[?1049h');
  const frame = (line: number) => {const view = overlayView({rows, height, width, anchor: {messageId: '__top__', line}}); return {rows: view.rows, start: view.start, width, height, selection: null};};
  plane.present(frame(first + 4)); plane.flush();
  writes.length = 0;
  plane.present(frame(first + 6)); plane.flush();
  const out = writes.join('');
  assert.ok(out.includes(`[1;${height}r[2S[r`), 'a region scroll, not a repaint of every row');
  assert.match(strip(out), /End/, 'the chip row is painted again after the scroll');
  plane.dispose();
});

test('over a tinted row the chip takes the covered background: caps blend into it, the fill tints it and nothing sticks out', () => {
  const height = 20, width = 80, tint = '#203040';
  const plain = rowsOf(conversation());
  const tinted = plain.map(row => ({...row, bg: tint}) as SceneRow);
  const chip = (rows: readonly SceneRow[]) => {
    const view = overlayView({rows, height, width, anchor: at(rows, 0, height)});
    const box = view.overlay.pill!, segments = (view.rows[box.y] as SceneRow).segments!;
    return {box, segments, row: view.rows[box.y] as SceneRow};
  };
  const widthOfText = (list: readonly {text: string}[]) => list.reduce((sum, s) => sum + [...s.text].length, 0);
  const a = chip(tinted);
  const left = a.segments.find(s => s.text === '▐')!, right = a.segments.find(s => s.text === '▌')!;
  assert.equal(left.bg, tint, 'the left cap keeps the covered background behind its transparent half');
  assert.equal(right.bg, tint);
  const fill = a.segments.find(s => /Latest/.test(s.text))!.bg;
  assert.notEqual(fill, tint, 'the chip itself is still visibly a chip'); assert.notEqual(fill, undefined);
  const first = a.segments.findIndex(s => s.text === '▐'), last = a.segments.findIndex(s => s.text === '▌');
  assert.equal(widthOfText(a.segments.slice(0, first)) + a.row.gutterCols, a.box.x, 'nothing is painted left of the chip; the rail is drawn by the plane');
  assert.equal(widthOfText(a.segments.slice(first, last + 1)), a.box.width, 'the chip is exactly label plus caps');
  assert.ok(a.segments.slice(last + 1).every(s => s.bg === tint || s.bg === undefined), 'the row to the right keeps its own background');
  const b = chip(plain as SceneRow[]);
  assert.equal(b.segments.find(s => s.text === '▐')!.bg, undefined, 'over a plain row the cap has no background of its own');
  assert.notEqual(b.segments.find(s => /Latest/.test(s.text))!.bg, fill, 'the fill follows what is underneath');
  const hover = (a.row.glow!.paint(1)).find(s => s.text === '▐')!;
  assert.equal(hover.bg, tint, 'hovered caps blend too');
});
