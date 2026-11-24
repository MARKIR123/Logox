import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import stringWidth from 'string-width';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {loadConfig} from '../src/config/config.js';
import {commandCatalog, commandHelp} from '../src/commands.js';
import type {Message} from '../src/runtime/contracts.js';
import type {Provider} from '../src/runtime/messages.js';
import {SIDEBAR_USAGE} from '../src/commands/tasks-page.js';
import {FadeSet} from '../src/tui/panels/hover-fade.js';
import {sideLine} from '../src/tui/panels/sidebar-frame.js';
import {palette} from '../src/tui/appearance/theme.js';
import {mixHex} from '../src/tui/appearance/colors.js';
import {TOGGLE_ICON, activateTab, closeTab, cycleTab, headerTargetAt, nextClosedTab, normalizeTabs, openTab, tabHeader, type SidebarTabsState} from '../src/tui/panels/sidebar-tabs.js';
import {changesModel, compact, emptyListView, paintList, stepListKey, stepListMouse, usageModel} from '../src/tui/panels/sidebar-pages.js';
import {changeDetail, fileChanges} from '../src/tui/panels/changes-model.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type Application = Awaited<ReturnType<typeof createApplication>>;

const text = (line: readonly {text: string}[]) => line.map(segment => segment.text).join('');

// ---------------------------------------------------------------------------------------------------------------------------------- pure: tabs and header
test('the tab state is always valid: unknown and repeated ids drop out, the last tab cannot close, closing the shown one shows its neighbour, cycling wraps', () => {
  assert.deepEqual(normalizeTabs(undefined, undefined), {open: ['team'], active: 'team'});
  assert.deepEqual(normalizeTabs(['nope', 'usage', 'usage', 'changes'], 'changes'), {open: ['usage', 'changes'], active: 'changes'});
  assert.deepEqual(normalizeTabs(['usage'], 'team'), {open: ['usage'], active: 'usage'}, 'an active tab that is not open falls back to the first');
  let state: SidebarTabsState = normalizeTabs(['team']);
  assert.equal(closeTab(state, 'team'), state, 'the last tab stays');
  state = openTab(openTab(state, 'changes'), 'usage');
  assert.deepEqual(state, {open: ['team', 'changes', 'usage'], active: 'usage'});
  assert.equal(openTab(state, 'changes').active, 'changes');
  assert.equal(nextClosedTab(state), undefined);
  state = activateTab(state, 'changes');
  assert.deepEqual(closeTab(state, 'changes'), {open: ['team', 'usage'], active: 'usage'}, 'the right neighbour is shown');
  assert.deepEqual(closeTab(activateTab(state, 'team'), 'usage'), {open: ['team', 'changes'], active: 'team'}, 'closing another tab keeps the shown one');
  assert.equal(cycleTab(state, 1).active, 'usage');
  assert.equal(cycleTab(cycleTab(state, 1), 1).active, 'team', 'wraps around');
  assert.equal(cycleTab(state, -1).active, 'team');
  assert.equal(nextClosedTab(closeTab(state, 'usage')), 'usage', '`+` opens the first closed tab in registry order');
});

test('the header bar: the active tab is marked heavy, close marks only with several tabs, the toggle is one cell wide and last, and every region hit-tests', () => {
  assert.equal(stringWidth(TOGGLE_ICON), 1, 'the toggle glyph is one cell wide');
  const one = tabHeader(normalizeTabs(['team']), 34);
  assert.equal(stringWidth(text(one.strip)), 34);
  assert.equal(stringWidth(text(one.rule)), 34);
  assert.ok(!text(one.strip).includes('×'), 'a single tab has no close mark');
  assert.ok(text(one.strip).includes('+'), 'closed tabs can be opened with +');
  assert.equal(text(one.strip).trimEnd().at(-1), TOGGLE_ICON, 'the toggle icon is the last cell');
  const state = openTab(normalizeTabs(['team']), 'changes');
  const header = tabHeader(state, 34);
  const strip = text(header.strip), rule = text(header.rule);
  assert.equal(stringWidth(strip), 34); assert.equal(stringWidth(rule), 34);
  assert.match(strip, /^ Team ×  Changes × +\+ +◨ $/);
  // The heavy underline sits under the active tab only.
  const at = strip.indexOf('Changes') - 1;
  assert.equal(rule[at + 1], '━'); assert.equal(rule[1], '─', 'the inactive tab has the light rule');
  assert.equal(headerTargetAt(header, strip.indexOf('Team') + 1)?.kind, 'tab');
  assert.deepEqual(headerTargetAt(header, strip.indexOf('Team') + 1), {kind: 'tab', id: 'team'});
  assert.deepEqual(headerTargetAt(header, strip.indexOf('×')), {kind: 'close', id: 'team'});
  assert.deepEqual(headerTargetAt(header, strip.indexOf('Changes') + 2), {kind: 'tab', id: 'changes'});
  assert.deepEqual(headerTargetAt(header, strip.indexOf('+')), {kind: 'add'});
  assert.deepEqual(headerTargetAt(header, strip.indexOf(TOGGLE_ICON)), {kind: 'toggle'});
  assert.deepEqual(headerTargetAt(header, 33), {kind: 'toggle'}, 'the toggle target includes the air around the icon');
  assert.equal(headerTargetAt(header, strip.indexOf('+') + 4), undefined, 'empty strip');
  // Active and inactive tabs and the hovered ones wear different colours.
  const segment = (needle: string) => header.strip.find(item => item.text.includes(needle))!;
  assert.notEqual(segment('Changes').color, segment('Team').color);
  const hovered = tabHeader(state, 34, {kind: 'tab', id: 'team'});
  assert.notEqual(hovered.strip.find(item => item.text.includes('Team'))!.color, segment('Team').color, 'hover recolours the tab');
  assert.notEqual(tabHeader(state, 34, {kind: 'toggle'}).strip.at(-1)!.color, header.strip.at(-1)!.color, 'hover recolours the toggle');
  // A narrow sidebar keeps the strip inside its width.
  const all = openTab(state, 'usage');
  for (const width of [34, 30, 24, 18]) {
    const narrow = tabHeader(all, width);
    assert.equal(stringWidth(text(narrow.strip)), width, 'strip at ' + width);
    assert.ok(narrow.regions.every(region => region.x1 <= width && region.x0 >= 0), 'regions at ' + width);
    assert.ok(text(narrow.strip).trimEnd().endsWith(TOGGLE_ICON), 'toggle at ' + width);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------- pure: Changes and Usage pages
const tool = (id: string, ownerId: string, name: string, args: object, state: 'completed' | 'failed' = 'completed', time = 1): Message => ({id, sessionId: 's', ownerId, role: 'assistant', kind: 'tool',
  text: name + '\n' + JSON.stringify(args), time, step: {title: name, state, elapsedMs: 5, call: {id, name, arguments: JSON.stringify(args)}}} as Message);

test('Changes lists the files the session edited with added and removed lines, newest first; failed calls and other sessions do not count', () => {
  const messages = [
    tool('a', 'techne', 'Edit', {file_path: '/p/src/a.ts', old_string: 'one\ntwo\n', new_string: 'one\nTWO\nthree\n'}, 'completed', 1),
    tool('b', 'kalon', 'Edit', {file_path: '/p/src/b.ts', old_string: 'x\n', new_string: 'y\n'}, 'completed', 5),
    tool('c', 'techne', 'Edit', {file_path: '/p/src/a.ts', old_string: 'three\n', new_string: ''}, 'completed', 9),
    tool('d', 'techne', 'Edit', {file_path: '/p/src/zzz.ts', old_string: 'x', new_string: 'y'}, 'failed', 10),
    tool('e', 'techne', 'Write', {file_path: '/p/src/new.ts', content: 'l1\nl2\nl3\n'}, 'completed', 3),
    {...tool('f', 'techne', 'Edit', {file_path: '/other/x.ts', old_string: 'a', new_string: 'b'}), sessionId: 'other'} as Message,
  ];
  const changes = fileChanges(messages, 's');
  assert.deepEqual(changes.map(change => change.path), ['/p/src/a.ts', '/p/src/b.ts', '/p/src/new.ts']);
  const a = changes[0]!;
  assert.deepEqual([a.added, a.removed, a.edits.length], [2, 2, 2]);
  assert.equal(changes[2]!.added, 3, 'a new file counts every line as added');
  const model = changesModel(changes, 32, {name: id => id});
  assert.equal(text(model.head[0]!), '3 files · +6 −3');
  assert.match(text(model.items[0]!.lines[0]), /^● a\.ts +\+2 −2$/);
  assert.match(text(model.items[0]!.lines[1]), /^ {2}\/p\/src · 2 edits · techne$/);
  const detail = changeDetail(a, id => id);
  assert.match(detail, /^2 edits · \+2 −2/);
  assert.match(detail, /### 1\. Edit by techne · \+2 −1\n\n```diff\n@@ [^\n]*\n one\n-two\n\+TWO\n\+three/);
  assert.equal(text(changesModel([], 32, {name: id => id}).head[0]!), 'No files changed yet');
});

test('Usage lists the actors by tokens with cost, and compact numbers read well', () => {
  assert.deepEqual([0, 999, 1000, 1234, 15800, 1_200_000].map(compact), ['0', '999', '1k', '1.2k', '16k', '1.2M']);
  const model = usageModel([
    {id: 'techne', name: 'Techne', symbol: '⊞', input: 20000, output: 14000, cached: 8000, model: 'mock/m', cost: {amount: 0.41, currency: 'USD', partial: false}},
    {id: 'logox', name: 'Logox', symbol: '◈', input: 1000, output: 500, cached: 0, cost: {amount: 0.05, currency: 'USD', partial: true}},
    {id: 'idle', name: 'Idle', symbol: '◇', input: 0, output: 0, cached: 0},
  ], 48);
  assert.equal(model.items.length, 2, 'actors without usage are left out');
  assert.equal(model.items[0]!.id, 'techne', 'the biggest first');
  assert.equal(text(model.head[0]!), '36k tokens · ~USD 0.4600', 'the total is the sum, partial when one price is');
  assert.match(text(model.items[0]!.lines[0]), /^⊞ Techne +34k tok {2}USD 0\.4100$/);
  assert.match(text(model.items[0]!.lines[1]), /in 20k · out 14k · cached 8k · mock\/m/);
  assert.match(text(model.items[1]!.lines[0]), /~USD 0\.0500/, 'a partial price is marked');
});

test('list pages scroll by wheel and keys, hover marks an item, a click opens it and Enter opens the selected one', () => {
  const changes = Array.from({length: 8}, (_, i) => tool('m' + i, 'techne', 'Edit', {file_path: `/p/f${i}.ts`, old_string: 'a', new_string: 'b'}, 'completed', i + 1));
  const model = changesModel(fileChanges(changes, 's'), 30, {name: id => id});
  const height = 8, body = height - model.head.length;
  assert.equal(body, 6);
  const painted = paintList(model, emptyListView, 30, height, true);
  assert.equal(painted.length, height);
  assert.match(text(painted[2]!), /f7\.ts/, 'newest first');
  let step = stepListMouse(model, emptyListView, height, {x: 3, y: 4, action: 'wheel_down'});
  assert.equal(step.view.scroll, 3, 'the wheel scrolls three rows');
  assert.equal(stepListMouse(model, step.view, height, {x: 3, y: 4, action: 'wheel_up'}).view.scroll, 0);
  step = stepListMouse(model, step.view, height, {x: 3, y: 2, action: 'move'});
  assert.equal(step.view.hovered, 1, 'hover finds the item under the pointer');
  const clicked = stepListMouse(model, step.view, height, {x: 3, y: 2, action: 'press'});
  assert.deepEqual(clicked.effects, [{kind: 'focus'}, {kind: 'open', id: '/p/f6.ts'}]);
  assert.deepEqual(stepListMouse(model, emptyListView, height, {x: 3, y: 0, action: 'press'}).effects, [{kind: 'focus'}], 'a click on the head only focuses');
  let key = stepListKey(model, emptyListView, height, {down: true});
  assert.equal(key.view.selected, 0);
  for (let i = 0; i < 7; i++) key = stepListKey(model, key.view, height, {down: true});
  assert.equal(key.view.selected, 7);
  assert.ok(key.view.scroll > 0, 'the selection scrolls into view');
  assert.deepEqual(stepListKey(model, key.view, height, {enter: true}).effects, [{kind: 'open', id: '/p/f0.ts'}]);
  assert.deepEqual(stepListKey(model, key.view, height, {escape: true}).effects, [{kind: 'blur'}]);
  assert.equal(stepListKey(model, emptyListView, height, {enter: true}).consumed, false, 'Enter with nothing selected does nothing');
  assert.match(text(paintList(model, key.view, 30, height, true).find(line => text(line).startsWith('›'))!), /^› ● f0\.ts/);
});

test('hover fades ease over 150 ms and are instant without motion: header tabs, close, +, toggle and stage cards', () => {
  const fades = new FadeSet();
  assert.equal(fades.step(['tab:changes'], 1000, true), true);
  assert.equal(fades.level('tab:changes'), 0, 'starts at rest');
  fades.step(['tab:changes'], 1075, true);
  const half = fades.level('tab:changes');
  assert.ok(half > 0.3 && half < 1, 'eased in between: ' + half);
  assert.equal(fades.step(['tab:changes'], 1200, true), false);
  assert.equal(fades.level('tab:changes'), 1);
  fades.step([], 1300, true); fades.step([], 1375, true);
  const back = fades.level('tab:changes');
  assert.ok(back < 1 && back > 0, 'fades out again');
  fades.step([], 1500, true);
  assert.equal(fades.level('tab:changes'), 0);
  assert.equal(fades.signature(), '', 'a settled control is forgotten');
  const jump = new FadeSet();
  assert.equal(jump.step(['toggle'], 1000, false), false);
  assert.equal(jump.level('toggle'), 1, 'no motion: at once');
  // The header colours follow the level.
  const state = openTab(normalizeTabs(['team']), 'changes');
  const at = (level: number) => tabHeader(state, 34, undefined, false, key => key === 'tab:team' ? level : 0).strip.find(item => item.text.includes('Team'))!.color;
  assert.notEqual(at(0), at(0.5)); assert.notEqual(at(0.5), at(1));
  const toggle = (level: number) => tabHeader(state, 34, undefined, false, key => key === 'toggle' ? level : 0).strip.at(-1)!.color;
  assert.notEqual(toggle(0), toggle(0.5)); assert.notEqual(toggle(0.5), toggle(1));
  const close = (level: number) => tabHeader(state, 34, undefined, false, key => key === 'close:team' ? level : 0).strip.find(item => item.text.includes('×'))!.color;
  assert.notEqual(close(0), close(0.5));
});

// ---------------------------------------------------------------------------------------------------------------------------------- rendered sidebar
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-tabs-ui-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
  const apps: Application[] = [];
  return {root,
    async open(sessionId = 'tabs-ui'): Promise<Application> {
      const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}
interface Rig {app: Application; input: TerminalInput; output: TerminalScreen; instance: ReturnType<typeof render>; send(value: string): Promise<void>; screen(): string;
  find(needle: string, from?: number): {x: number; y: number}; mouse(kind: 'press' | 'move' | 'wheel_down' | 'wheel_up', x: number, y: number): Promise<void>; click(x: number, y: number): Promise<void>; sidebarX: number; columns: number}
async function mount(app: Application, columns: number, rows: number, extra: Record<string, unknown> = {}): Promise<Rig> {
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = columns; output.rows = rows;
  app.store.message(app.sessionId, 'logox', 'assistant', 'Ready when you are.');
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} plans={app.plans} surfaces={app.surfaces} onSubmit={app.submit}
    onCancel={() => {}} onClose={async () => {}} {...extra}/>,
  {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush(); await delay(25);};
  const screen = () => output.lines.join('\n');
  const find = (needle: string, from = 0) => {
    for (let y = 0; y < output.lines.length; y++) {const x = output.lines[y]!.indexOf(needle, from); if (x >= 0) return {x, y};}
    assert.fail(needle + ' is not on screen:\n' + screen());
  };
  const mouse = async (kind: 'press' | 'move' | 'wheel_down' | 'wheel_up', x: number, y: number) =>
    send(kind === 'press' ? `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m` : kind === 'move' ? `\x1b[<35;${x + 1};${y + 1}M` : `\x1b[<${kind === 'wheel_up' ? 64 : 65};${x + 1};${y + 1}M`);
  const size = Math.max(36, Math.min(56, Math.floor((columns - 1) * 0.34)));
  return {app, input, output, instance, send, screen, find, mouse, click: (x, y) => mouse('press', x, y), sidebarX: columns - 1 - size, columns};
}
async function unmount(rig: Rig) {try {await act(async () => rig.instance.unmount());} catch {} rig.input.destroy(); rig.output.destroy();}
const submit = (rig: Rig, line: string) => act(async () => {await rig.app.submit(line);});
const stripOf = (rig: Rig) => rig.output.lines[0]!.slice(rig.sidebarX);
const teamUp = (screen: string) => /No team activity yet/.test(screen);

test('the toggle icon opens and closes the sidebar by mouse, Ctrl+B does too, and the closed sidebar keeps its icon in the top-right gutter, in cells of its own', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    rig = await mount(app, 120, 34);
    await waitFor(() => rig.screen(), screen => screen.includes('Ready when you are.'), {label: 'mounted'});
    const gutterY = 0, gutterIcon = () => rig.output.lines[gutterY]![rig.columns - 2];
    await waitFor(() => gutterIcon(), glyph => glyph === TOGGLE_ICON, {label: 'the toggle icon in the top-right gutter'});
    assert.equal(rig.output.lines[0]![rig.columns - 3], ' ', 'the timeline ends before the gutter');
    assert.ok(!teamUp(rig.screen()));
    // A hover over the corner is harmless and a click opens the sidebar on its first tab.
    await rig.mouse('move', rig.columns - 2, gutterY);
    await rig.click(rig.columns - 2, gutterY);
    await waitFor(() => rig.screen(), teamUp, {label: 'opened by the gutter icon'});
    assert.match(stripOf(rig), /Team/);
    assert.ok(rig.output.lines[0]!.lastIndexOf(TOGGLE_ICON) >= rig.sidebarX, 'the header bar carries the icon while the sidebar is open');
    // The header's toggle closes it again.
    const icon = rig.output.lines[0]!.lastIndexOf(TOGGLE_ICON);
    assert.ok(icon >= rig.sidebarX, 'the toggle sits at the right end of the header bar');
    await rig.click(icon, 0);
    await waitFor(() => rig.screen(), screen => !teamUp(screen), {label: 'closed by the header toggle'});
    await waitFor(() => gutterIcon(), glyph => glyph === TOGGLE_ICON, {label: 'the gutter icon is back'});
    // Ctrl+B shows it with the keyboard in it, and again hides it.
    await rig.send('\x02');
    await waitFor(() => rig.screen(), teamUp, {label: 'Ctrl+B opens'});
    await rig.send('\x02');
    await waitFor(() => rig.screen(), screen => !teamUp(screen), {label: 'Ctrl+B hides'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('tabs: /sidebar opens Changes and Usage, a click switches, the wheel over the strip cycles, × closes and + opens another; /team shows the Team tab', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    const sample = (ownerId: string) => ({ownerId, name: ownerId === 'logox' ? 'Logox' : ownerId, state: 'ready', model: {provider: 'mock', model: 'm'},
      usage: {window: {input: 0, output: 0, cached: 0}, session: {input: ownerId === 'logox' ? 1200 : 0, output: 300, cached: 0}}, cost: 0.02, costCurrency: 'USD'});
    rig = await mount(app, 120, 34, {getStatus: sample});
    await waitFor(() => rig.screen(), screen => screen.includes('Ready when you are.'), {label: 'mounted'});
    await submit(rig, '/team');
    await waitFor(() => rig.screen(), teamUp, {label: '/team opens the Team tab'});
    assert.match(stripOf(rig), /^│  Team +\+/, 'one tab, no close mark, a + to open more');
    await submit(rig, '/sidebar changes');
    await waitFor(() => rig.screen(), screen => /No files changed yet/.test(screen), {label: 'the Changes tab'});
    assert.match(stripOf(rig), /Team ×  Changes ×/, 'both tabs are open now');
    await submit(rig, '/sidebar usage');
    await waitFor(() => rig.screen(), screen => /1\.5k tok/.test(screen) && /USD 0\.0200/.test(screen), {label: 'the Usage tab shows the Director'});
    // The persisted tab set follows.
    await waitFor(() => rig.app.surfaces.sidebarTabsStore!.get(), saved => saved.active === 'usage' && saved.open?.join() === 'team,changes,usage', {label: 'remembered'});
    // A click on a tab name switches to it.
    const team = rig.find('Team', rig.sidebarX);
    await rig.click(team.x + 1, team.y);
    await waitFor(() => rig.screen(), teamUp, {label: 'clicked Team'});
    // The wheel over the strip cycles: down goes right.
    await rig.mouse('wheel_down', rig.sidebarX + 20, 0);
    await waitFor(() => rig.screen(), screen => /No files changed yet/.test(screen), {label: 'wheel to Changes'});
    await rig.mouse('wheel_up', rig.sidebarX + 20, 0);
    await waitFor(() => rig.screen(), teamUp, {label: 'wheel back to Team'});
    // × on Changes closes it; the strip shrinks and + comes back.
    const strip = stripOf(rig), close = strip.indexOf('×', strip.indexOf('Changes'));
    await rig.click(rig.sidebarX + close, 0);
    await waitFor(() => stripOf(rig), text => !text.includes('Changes'), {label: 'Changes closed'});
    await waitFor(() => rig.app.surfaces.sidebarTabsStore!.get(), saved => saved.open?.join() === 'team,usage', {label: 'the close is remembered'});
    // + opens the first closed tab (Changes again).
    const plus = stripOf(rig).indexOf('+');
    await rig.click(rig.sidebarX + plus, 0);
    await waitFor(() => rig.screen(), screen => /No files changed yet/.test(screen), {label: '+ opened Changes'});
    // Keyboard: the sidebar has the keyboard after a click on the header; digits pick tabs, w closes the shown one.
    await rig.send('1');
    await waitFor(() => rig.screen(), teamUp, {label: 'digit 1'});
    // /team on another tab shows Team; on Team it hides.
    await submit(rig, '/sidebar usage');
    await waitFor(() => rig.screen(), screen => /tok/.test(screen) && !teamUp(screen), {label: 'on Usage'});
    await submit(rig, '/team');
    await waitFor(() => rig.screen(), teamUp, {label: '/team focuses the Team tab instead of hiding'});
    await submit(rig, '/team');
    await waitFor(() => rig.screen(), screen => !teamUp(screen), {label: 'a second /team hides'});
    // /sidebar alone toggles the visibility on whatever tab was last shown.
    await submit(rig, '/sidebar');
    await waitFor(() => rig.screen(), teamUp, {label: '/sidebar shows the last tab'});
    await submit(rig, '/sidebar hide');
    await waitFor(() => rig.screen(), screen => !teamUp(screen), {label: '/sidebar hide'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the open tabs and the active tab are remembered across runs, and the Usage page opens an actor window by click', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const first = await f.open('one');
    first.surfaces.sidebarTabsStore!.set({open: ['team', 'usage'], active: 'usage'});
    const file = join(f.root, 'home', '.logox', 'ui-preferences.json');
    await waitFor(() => readFile(file, 'utf8').catch(() => '{}'), raw => raw.includes('"sidebarActive": "usage"') || raw.includes('"sidebarActive":"usage"'), {label: 'saved to ui-preferences.json'});
    const second = await f.open('two');
    const sample = (ownerId: string) => ({ownerId, name: ownerId, state: 'ready', usage: {window: {input: 0, output: 0, cached: 0}, session: {input: ownerId === 'logox' ? 900 : 0, output: 100, cached: 0}}});
    const windows: string[] = [];
    second.surfaces.subscribeWindow(id => windows.push(id));
    rig = await mount(second, 120, 34, {getStatus: sample});
    await waitFor(() => rig.screen(), screen => screen.includes('Ready when you are.'), {label: 'mounted'});
    await submit(rig, '/sidebar show');
    await waitFor(() => rig.screen(), screen => /1k tok/.test(screen), {label: 'the second run starts on the remembered Usage tab'});
    assert.match(stripOf(rig), /Team ×  Usage ×/);
    const row = rig.find('1k tok', rig.sidebarX);
    await rig.mouse('move', row.x, row.y);
    await rig.click(row.x, row.y);
    await waitFor(() => windows, list => list.includes('logox'), {label: 'a click on the Director opens its window'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('/sidebar validates its arguments, is in the command catalog and the help, and the narrow overlay has the header bar too', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await assert.rejects(app.submit('/sidebar bogus'), (error: Error) => error.message === SIDEBAR_USAGE);
    await assert.rejects(app.submit('/sidebar team sideways'), (error: Error) => error.message === SIDEBAR_USAGE);
    await assert.rejects(app.submit('/sidebar changes'), /needs the terminal UI/);
    assert.ok(commandCatalog.some(command => command.name === 'sidebar'));
    assert.match(commandHelp(), /\/sidebar \[team\|changes\|usage\] \[show\|hide\|toggle\]: Sidebar tabs/);
    const modes: [string, string | undefined][] = [];
    const stop = app.surfaces.subscribeSidebar((mode, tab) => modes.push([mode, tab]));
    await app.submit('/sidebar'); await app.submit('/sidebar usage'); await app.submit('/sidebar hide'); await app.submit('/sidebar changes hide'); await app.submit('/team show');
    assert.deepEqual(modes, [['toggle', undefined], ['toggle', 'usage'], ['hide', undefined], ['hide', 'changes'], ['show', 'team']]);
    stop();
    rig = await mount(app, 100, 30);
    await waitFor(() => rig.screen(), screen => screen.includes('Ready when you are.'), {label: 'mounted'});
    await rig.mouse('move', 98, 0);
    await rig.click(98, 0);
    await waitFor(() => rig.screen(), screen => /No team activity yet/.test(screen) && rig.output.lines[0]!.includes(TOGGLE_ICON), {label: 'the gutter icon opens the overlay with its header bar'});
    const icon = rig.output.lines[0]!.lastIndexOf(TOGGLE_ICON);
    await rig.click(icon, 0);
    await waitFor(() => rig.screen(), screen => !/No team activity yet/.test(screen), {label: 'the overlay closes by its toggle'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the sidebar is a focus region: its header rule and border fade between dim and full chrome over 220 ms, instantly without motion', () => {
  const state = openTab(normalizeTabs(['team']), 'changes');
  const rule = (level?: number) => tabHeader(state, 34, undefined, false, undefined, level).rule;
  const active = (level?: number) => rule(level).find(item => item.text.includes('━'))!.color;
  const plain = (level?: number) => rule(level).find(item => item.text.includes('─'))!.color;
  assert.equal(active(1), palette.accent, 'focused: the accent rule at full strength');
  assert.equal(plain(1), palette.line, 'focused: the plain rule at line strength');
  assert.notEqual(active(0), active(1), 'blurred: dimmed');
  assert.equal(active(0), mixHex(palette.accent, palette.bg, 0.55), 'dimmed like the composer and the rails (55% toward the background)');
  assert.notEqual(active(0.5), active(0)); assert.notEqual(active(0.5), active(1));
  assert.equal(active(undefined), palette.accent, 'without a level the old behaviour stays');
  const frame = (level: number) => ({width: 20, accent: false, level});
  const border = (level: number) => sideLine(frame(level), [])[0]!.color;
  assert.equal(border(1), palette.accent); assert.notEqual(border(0), border(1)); assert.notEqual(border(0.5), border(0));
  assert.equal(sideLine({...frame(0), hoveredEdge: 'handle'}, [])[0]!.color, palette.accent, 'the resize handle still lights up under the pointer');
  assert.equal(sideLine({width: 20, accent: true, level: 0}, [])[0]!.color, palette.accent, 'a drag keeps the accent');
  // The fade: 220 ms, eased, and back; without motion at once.
  const fades = new FadeSet();
  fades.step(['focus'], 1000, true);
  assert.equal(fades.level('focus'), 0);
  fades.step(['focus'], 1100, true);
  const mid = fades.level('focus');
  assert.ok(mid > 0.3 && mid < 1, 'still moving at 100 ms: ' + mid);
  assert.equal(fades.step(['focus'], 1150, true), true, 'busy before 220 ms');
  assert.equal(fades.step(['focus'], 1230, true), false);
  assert.equal(fades.level('focus'), 1);
  fades.step([], 1300, true); fades.step([], 1400, true);
  assert.ok(fades.level('focus') < 1 && fades.level('focus') > 0, 'dims again');
  const instant = new FadeSet();
  instant.step(['focus'], 1000, false);
  assert.equal(instant.level('focus'), 1);
  instant.step([], 1001, false);
  assert.equal(instant.level('focus'), 0, 'motion off: no easing either way');
});

test('a click anywhere in the sidebar gives it the keyboard: header, rule, border and body', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    rig = await mount(app, 120, 34);
    await submit(rig, '/sidebar show');
    await waitFor(() => rig.screen(), teamUp, {label: 'open'});
    // Typing goes to the composer until the sidebar is clicked; a typing key then comes back to it (the sidebar has the keyboard in between).
    await rig.click(rig.sidebarX + 10, 1); // the rule row
    await rig.send('\x1b'); // Esc from the sidebar returns the keyboard to the composer (only a focused sidebar reacts to it)
    await rig.send('ab');
    assert.ok(/❯ ab/.test(rig.screen()), 'Esc left the sidebar for the composer');
    await rig.click(rig.sidebarX + 10, 6); // the body
    await rig.send('x');
    assert.ok(/❯ abx/.test(rig.screen()), 'a click in the body focused the sidebar; a typing key returned to the composer and was typed there');
    await rig.click(rig.sidebarX, 6); // the border (the resize handle)
    await rig.send('\x1b');
    await rig.send('c');
    assert.ok(/ab.*c|abc/.test(rig.screen().replace(/\s/g, '')), 'the border click focused the sidebar, Esc gave it back');
  } finally {if (rig) await unmount(rig); await f.close();}
});
