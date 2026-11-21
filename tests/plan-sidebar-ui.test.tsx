import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {palette} from '../src/tui/appearance/theme.js';
import {flowStats} from '../src/tui/panels/plan-flow.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type Application = Awaited<ReturnType<typeof createApplication>>;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-plan-ui-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
  const apps: Application[] = [];
  return {root,
    async open(sessionId = 'plan-ui'): Promise<Application> {
      const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}

const NODES = [
  {title: 'Design', owner: 'logox', nodes: [{title: 'Palette', owner: 'techne', acceptance: ['all colours named']}, {title: 'Contrast', owner: 'kalon', after: ['1.1']}]},
  {title: 'Ship', owner: 'techne', after: ['1']}];
/** The card of the first node (`│ ◌ Palette │`, between its owner border `╭─ techne ─╮` and its bottom border) is on the screen text: the side, the status glyph and the title. */
const hasCard = (text: string, title = 'Palette') => new RegExp('│ \\S ' + title).test(text);
const create = (app: Application, nodes: object[] = NODES) => app.plans.apply([{op: 'create', title: 'Theme preview', nodes: nodes as never}], 'logox');
const runningTechne = (app: Application, activityId = 'tech') => app.store.activities.create({sessionId: app.sessionId, activityId, ownerId: 'techne', kind: 'actor', title: 'Techne · Builder',
  taskTitle: 'Build the palette', status: 'running', stage: 'On stage', detail: '', rootActivityId: 'root', startedAt: Date.now() - 130_000});

interface Rig {app: Application; input: TerminalInput; output: TerminalScreen; instance: ReturnType<typeof render>;
  send(value: string): Promise<void>; screen(): string; find(needle: string, from?: number): {x: number; y: number}; mouse(kind: 'press' | 'move' | 'wheel_down' | 'wheel_up', x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>; clickText(needle: string, from?: number): Promise<void>; sidebarX: number}
async function mount(app: Application, columns: number, rows: number, extra: Record<string, unknown> = {}): Promise<Rig> {
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = columns; output.rows = rows;
  // An empty session shows the welcome splash, which owns the whole timeline; a session with a plan always has messages.
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
  return {app, input, output, instance, send, screen, find, mouse, click: (x, y) => mouse('press', x, y), clickText: async (needle, from = 0) => {const {x, y} = find(needle, from); await mouse('press', x + 1, y);},
    sidebarX: Math.max(36, Math.min(56, Math.floor((columns - 1) * 0.34))) && columns - 1 - Math.max(36, Math.min(56, Math.floor((columns - 1) * 0.34)))};
}
async function unmount(rig: Rig) {try {await act(async () => rig.instance.unmount());} catch {} rig.input.destroy(); rig.output.destroy();}
const surface = (app: Application): CommandSurface | null => app.surfaces.getSnapshot();
const sidebarLines = (rig: Rig) => rig.output.lines.map(line => line.slice(rig.sidebarX));

test('the sidebar appears beside the timeline when a plan is created, with the timeline narrowed and still working', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINELEFT hello');
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('TIMELINELEFT'), {label: 'the timeline'});
    assert.ok(!rig.screen().includes('Theme preview'), 'no plan, no sidebar');
    await act(async () => {await create(app);});
    await waitFor(() => rig.screen(), text => hasCard(text) && text.includes('Theme preview'), {label: 'the sidebar'});
    // The sidebar is the right-hand column; the timeline text stays on the left and the composer and footer keep their place.
    assert.ok(rig.find('Palette', rig.sidebarX).x >= rig.sidebarX, 'the flow is in the right-hand column');
    assert.ok(rig.find('TIMELINELEFT').x < rig.sidebarX);
    assert.ok(sidebarLines(rig).some(line => line.startsWith('│')), 'the border column');
    assert.match(sidebarLines(rig)[1]!, /active · 0\/3/);
    assert.ok(!rig.output.lines.at(-1)!.includes('▸ Tasks'), 'no chip while the sidebar is shown');
    await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINESECOND');});
    await waitFor(() => rig.screen(), text => text.includes('TIMELINESECOND'), {label: 'the timeline keeps working'});
    assert.ok(hasCard(rig.screen()));
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('linked work moves a node through running to done; the clock ticks beside it; finishing the plan hides the sidebar with a notice and a chip', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar from the start (a resumed plan)'});
    assert.match(rig.screen(), /│ ◌ Palette/, 'a card: the ready glyph and the title inside');
    assert.match(rig.screen(), /╭─+ techne ─╮[^\n]*\n[^\n]*│ ◌ Palette[^\n]*\n[^\n]*╰─+╯/, 'the top border carries the owner tag, the bottom border is plain');
    await act(async () => {runningTechne(app); app.plans.link('1.1', {activityId: 'tech'});});
    await waitFor(() => rig.screen(), text => /╭─+ techne ─╮[^\n]*\n[^\n]*│ ● Palette[^\n]*\n[^\n]*╰─+ +2:1\d +─╯/.test(text), {label: 'running with its clock at the right of the bottom border'});
    await act(async () => {app.store.activities.update(app.sessionId, 'tech', {status: 'completed', stage: 'Completed', stopReason: 'completed', finishedAt: Date.now()});});
    await waitFor(() => rig.screen(), text => /│ ◉ Palette/.test(text), {label: 'done'});
    assert.ok(!/│ ● Palette/.test(rig.screen()));
    // Accepting every top-level node finishes the plan.
    await act(async () => {
      for (const id of ['1.1', '1.2', '2']) assert.ok((await app.plans.apply([{op: 'accept', id, evidence: ['checked']}], 'logox')).ok);
    });
    await waitFor(() => rig.screen(), text => !hasCard(text) && text.includes('Tasks 3/3'), {label: 'hidden, with the chip'});
    assert.match(rig.screen(), /Plan "Theme preview" is done · \/tasks or Ctrl\+B shows the task graph again|▸ Tasks 3\/3/);
    assert.ok(rig.output.lines.at(-1)!.includes('▸ Tasks 3/3'), 'the chip is on the footer row');
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('hover highlights a node border, click folds a parent, double click opens the detail, wheel scrolls the sidebar only', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app, [...NODES, ...Array.from({length: 7}, (_, index) => ({title: 'Extra phase ' + index, owner: 'techne', nodes: [{title: 'Step', owner: 'kalon'}]}))]);
    rig = await mount(app, 120, 30);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    const rgb = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
    const at = rig.find('Palette', rig.sidebarX);
    const before = rig.output.text.length;
    await rig.mouse('move', at.x + 3, at.y);
    // A hovered card has no fill: its title is repainted in the strong tone.
    await waitFor(() => rig.output.text.slice(before), text => text.includes(rgb(palette.strong)), {label: 'the hovered card title brightens'});
    // A click on the title only selects: the layout stays put. The fold glyph (two cells before the title) folds the children away and back.
    const design = rig.find('Design');
    await rig.click(design.x + 2, design.y);
    await delay(400); // a second click inside 350 ms would be a double click
    assert.ok(hasCard(rig.screen()), 'a click on the title does not fold');
    await rig.click(design.x - 2, design.y);
    await waitFor(() => rig.screen(), text => !hasCard(text) && /▸ Design/.test(text), {label: 'folded'});
    await delay(400);
    await rig.click(design.x - 2, design.y);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'unfolded'});
    // The wheel over the sidebar scrolls it (a marker appears in the header rule) and leaves the timeline alone.
    const top = rig.output.lines[2]!;
    assert.ok(!top.includes('▲'));
    await rig.mouse('wheel_down', rig.sidebarX + 5, 10);
    await waitFor(() => rig.output.lines[2]!, line => line.includes('▲'), {label: 'scrolled'});
    // Double click on a node opens the detail page.
    const node = rig.find('Extra phase 0');
    await rig.click(node.x + 2, node.y); await rig.click(node.x + 2, node.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'the detail page'});
    assert.match((surface(app) as Extract<CommandSurface, {kind: 'page'}>).title, /^Plan node · Extra phase 0$/);
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a click on the owner name jumps to that actor\'s latest card in the timeline', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    for (let i = 0; i < 40; i++) app.store.message(app.sessionId, 'logox', 'assistant', 'Preamble line ' + i);
    runningTechne(app, 'act-techne-1');
    app.store.message(app.sessionId, 'techne', 'assistant', 'TECHNECARDBODY', {activityId: 'act-techne-1'});
    for (let i = 0; i < 40; i++) app.store.message(app.sessionId, 'logox', 'assistant', 'Tail line ' + i);
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text) && text.includes('Tail line 39'), {label: 'ready'});
    assert.ok(!rig.screen().includes('TECHNECARDBODY'), 'the card is off screen');
    const row = rig.find('Palette', rig.sidebarX);
    // The owner tag sits in the top border, the row above the title.
    const ownerX = rig.output.lines[row.y - 1]!.indexOf('techne', rig.sidebarX);
    assert.ok(ownerX >= rig.sidebarX, 'the owner tag is in the top border');
    await rig.click(ownerX + 1, row.y - 1);
    await waitFor(() => rig.screen(), text => /TECHNECARDBODY|Techne/.test(text) && !text.includes('Tail line 39'), {label: 'the timeline scrolled to the card'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('keyboard: Ctrl+B shows and focuses, arrows move, Enter opens, Esc returns to the composer, typing goes to the composer, Ctrl+B again hides, the chip brings it back', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32, {getStatus: (ownerId: string) => ({ownerId, name: ownerId, state: 'ready'})});
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    await rig.send('hi');
    assert.ok(rig.screen().includes('hi'), 'typing reaches the composer while the sidebar is unfocused');
    await rig.send('\x02'); // Ctrl+B focuses
    assert.match(rig.screen(), /↑↓←→ · Enter open · p plans · Esc/);
    await rig.send('\x1b[B'); await rig.send('\x1b[B'); // the phase, then its first step
    await rig.send('\r');
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'Enter opens the detail of the selected node'});
    assert.match((surface(app) as Extract<CommandSurface, {kind: 'page'}>).title, /^Plan node · Palette$/);
    await rig.send('\x1b');
    await waitFor(() => surface(app), current => current === null, {label: 'Esc closes the detail'});
    await rig.send('\x1b'); // back to the composer
    assert.ok(!/↑↓←→ · Enter/.test(rig.screen()), 'the keyboard is back in the composer');
    await rig.send('\x02'); // focus again: a typing key returns it to the composer and is typed there
    await rig.send('x');
    assert.ok(/❯ hix/.test(rig.screen()), 'the key was typed into the composer:\n' + rig.screen());
    await rig.send('\x02'); await rig.send('\x02'); // focus, then hide
    await waitFor(() => rig.screen(), text => !hasCard(text) && text.includes('▸ Tasks 0/3'), {label: 'hidden by the shortcut; the chip shows'});
    // The chip is a button: hover shows its hint, a click shows the sidebar again.
    const chip = rig.find('▸ Tasks 0/3');
    await rig.mouse('move', chip.x + 2, chip.y);
    await waitFor(() => rig.screen(), text => text.includes('click or Ctrl+B shows it'), {label: 'the chip hint on the notification row'});
    await rig.click(chip.x + 2, chip.y);
    await waitFor(() => rig.screen(), text => hasCard(text) && !text.includes('▸ Tasks 0/3'), {label: 'shown again'});
    // /tasks sidebar hides it too.
    await act(async () => {await app.submit('/tasks sidebar hide');});
    await waitFor(() => rig.screen(), text => !hasCard(text), {label: '/tasks sidebar hide'});
    await act(async () => {await app.submit('/tasks');});
    await waitFor(() => rig.screen(), text => hasCard(text), {label: '/tasks toggles'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a hidden sidebar stays hidden when the next plan starts; below 110 columns nothing docks and the toggle opens an overlay', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINEWORD');
    rig = await mount(app, 90, 28);
    await act(async () => {await create(app);});
    await waitFor(() => rig.screen(), text => text.includes('▸ Tasks 0/3'), {label: 'only the chip at 90 columns'});
    assert.ok(!hasCard(rig.screen()), 'never squeezes the timeline');
    assert.ok(rig.find('TIMELINEWORD').x < 5);
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => hasCard(text) && text.includes('Esc or Ctrl+B closes'), {label: 'the overlay'});
    await rig.send('\x1b');
    await waitFor(() => rig.screen(), text => !hasCard(text) && text.includes('TIMELINEWORD'), {label: 'the overlay closed'});
    // The overlay closes on a click outside the panel, too.
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the overlay again'});
    await rig.click(2, 10);
    await waitFor(() => rig.screen(), text => !hasCard(text), {label: 'closed by a click'});
    // Widen: a plan created while narrow shows up docked.
    await act(async () => {rig.output.resize(120, 28);});
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'docked after widening'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('unrelated store changes neither rebuild the flow nor repaint the sidebar', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    await delay(60);
    const builds = flowStats.builds;
    for (let i = 0; i < 3; i++) await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'unrelated message ' + i); await delay(30);});
    await waitFor(() => rig.screen(), text => text.includes('unrelated message 2'), {label: 'the timeline updated'});
    assert.equal(flowStats.builds, builds, 'the layout is not rebuilt');
    // A scroll of the timeline repaints the side column (it moves with the rows), but never with a different picture: every paint of the card's title row is the same text.
    const paints = new Set(rig.output.text.match(/◌(?:\x1b\[[\d;]*m)* (?:\x1b\[[\d;]*m)*Palette[^\x1b]*/g));
    assert.equal(paints.size, 1, 'the sidebar row never changed: ' + [...paints].join(' | '));
    // A change of the plan does repaint it.
    await act(async () => {assert.ok((await app.plans.apply([{op: 'update', id: '1.1', title: 'Palette v2'}], 'logox')).ok);});
    await waitFor(() => rig.screen(), text => text.includes('Palette v2'), {label: 'the plan change'});
    assert.ok(flowStats.builds > builds);
  } finally {if (rig) await unmount(rig); await f.close();}
});

const swarmJob = (app: Application, activityId: string, id: string, title: string) => app.store.message(app.sessionId, 'techne', 'assistant', '', {activityId, kind: 'tool',
  step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm: {name: 'crew', jobs: [{id, title, state: 'done', elapsedMs: 100, calls: [], route: 'read', model: 'mock/reader', stopReason: 'completed', summary: 'found them'}]}}} as never);

test('with no plan the work of the session is a task graph one /tasks away: nothing opens by itself, the chip offers it, the header says no plan, a click on it opens the plan switcher', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    runningTechne(app);
    swarmJob(app, 'tech', 'T1', 'Find the callers');
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => /▸ Tasks \d\/\d/.test(text), {label: 'the chip offers the task graph'});
    assert.ok(!rig.screen().includes('Tasks · no plan'), 'a session without a plan never opens the sidebar by itself');
    await act(async () => {await app.submit('/tasks');});
    await waitFor(() => rig.screen(), text => text.includes('Tasks · no plan') && text.includes('Build the palette') && text.includes('Find the callers'), {label: 'the graph of the work'});
    assert.ok(!rig.output.lines.at(-1)!.includes('▸ Tasks'), 'no chip while it is shown');
    assert.match(sidebarLines(rig)[1]!, /working · \d\/\d done/);
    // Hover on the header names what a click does; the click opens the switcher over the screen.
    const head = rig.find('Tasks · no plan');
    await rig.mouse('move', head.x + 2, head.y);
    await waitFor(() => rig.screen(), text => text.includes('switch plan or work view'), {label: 'the header hint'});
    await rig.click(head.x + 2, head.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the plan switcher'});
    assert.equal((surface(app) as Extract<CommandSurface, {kind: 'picker'}>).title, 'Plans');
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    // p opens it from the keyboard when the sidebar has focus (the click on the header gave it the keyboard; Ctrl+B would hide it then).
    await rig.mouse('move', 5, 5);
    if (!/p plans/.test(rig.screen())) await rig.send('\x02');
    await waitFor(() => rig.screen(), text => /p plans/.test(text), {label: 'the sidebar has the keyboard'});
    await rig.send('p');
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'p opens the switcher'});
    app.surfaces.cancel();
    await act(async () => {await app.submit('/tasks sidebar hide');});
    await waitFor(() => rig.screen(), text => !text.includes('Tasks · no plan') && /▸ Tasks/.test(text), {label: 'hidden again'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('/tasks with nothing planned or delegated says so instead of opening an empty sidebar', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('Ready when you are.'), {label: 'mounted'});
    await act(async () => {await app.submit('/tasks');});
    await waitFor(() => rig.screen(), text => /Nothing has been planned or delegated/.test(text), {label: 'the empty notice'});
    assert.ok(!rig.screen().includes('Tasks · no plan'));
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => /Nothing has been planned or delegated/.test(text), {label: 'Ctrl+B says the same'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a plan and work nobody linked to it are one graph: a worker of a planned step becomes its child', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    runningTechne(app); app.plans.link('1.1', {activityId: 'tech'});
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    assert.ok(!rig.screen().includes('Find the callers'));
    await act(async () => {swarmJob(app, 'tech', 'T1', 'Find the callers');});
    await waitFor(() => rig.screen(), text => text.includes('Find the callers') && text.includes('Tasks Theme preview'), {label: 'the worker joins its step'});
    assert.equal(app.plans.peek()?.nodes.length, 4, 'the plan itself is unchanged');
    // Double click on the synthesized node opens the delegation detail, not a plan node.
    const node = rig.find('Find the callers', rig.sidebarX);
    assert.doesNotMatch(rig.screen().split('\n').map(line => line.slice(rig.sidebarX)).join('\n'), /\b\d+(\.\d+)+\b/, 'no node id on the sidebar');
    await rig.click(node.x + 2, node.y); await rig.click(node.x + 2, node.y);
    await waitFor(() => (surface(app) as Extract<CommandSurface, {kind: 'page'}> | null)?.title, title => title === 'Delegation · Find the callers', {label: 'the delegation detail'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a session with neither plan nor work shows the latest plan of an earlier session, read-only; its nodes open from the project file and nothing is adopted', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const first = await f.open('earlier-session');
    await create(first);
    await first.plans.flush();
    await first.close();
    const app = await f.open('this-session');
    assert.equal(app.plans.peek(), undefined);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('▸ Earlier tasks'), {label: 'the chip offers the earlier plan'});
    assert.ok(!hasCard(rig.screen()), 'it does not open by itself');
    await act(async () => {await app.submit('/tasks');});
    await waitFor(() => rig.screen(), text => text.includes('Earlier tasks Theme preview') && hasCard(text) && text.includes('re-activate: /tasks plans'), {label: 'the earlier plan, read-only'});
    const node = rig.find('Palette', rig.sidebarX);
    await rig.click(node.x + 2, node.y); await rig.click(node.x + 2, node.y);
    await waitFor(() => (surface(app) as Extract<CommandSurface, {kind: 'page'}> | null)?.title, title => title === 'Plan node · Palette', {label: 'the node of the earlier plan'});
    assert.equal(app.plans.peek(), undefined, 'nothing was adopted');
  } finally {if (rig) await unmount(rig); await f.close();}
});

// ---------------------------------------------------------------------------------------------------------------------------------- resize and collapse
const press = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`, dragTo = (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`, release = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`;
/** The column of the sidebar's border: the first `│` on a body row below the header. */
const borderX = (rig: Rig, y = 6) => rig.output.lines[y]!.indexOf('│');

test('dragging the border resizes the docked sidebar live within its range, release ends the drag, and the width is remembered', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    const width = 119; // usable width: one column less than the terminal
    assert.equal(borderX(rig), rig.sidebarX);
    assert.equal(rig.sidebarX, width - 40, 'the default is 34%');
    await rig.send(press(rig.sidebarX, 10));
    await rig.send(dragTo(rig.sidebarX - 8, 10));
    await waitFor(() => borderX(rig), x => x === rig.sidebarX - 8, {label: 'the sidebar grew by eight columns'});
    assert.ok(hasCard(rig.screen()), 'the flow was laid out again at the new width');
    // Far to the left: the timeline keeps its 60 columns (and the gap), so the sidebar stops at 58.
    await rig.send(dragTo(5, 10));
    await waitFor(() => borderX(rig), x => x === width - 58, {label: 'clamped at the wide end'});
    await rig.send(release(5, 10));
    await waitFor(() => app.surfaces.sidebarWidthStore!.get(), value => value === 58, {label: 'remembered'});
    // Released: more motion does not resize.
    await rig.send(dragTo(width - 45, 10));
    await delay(60);
    assert.equal(borderX(rig), width - 58, 'no drag without a press on the border');
    // Far to the right: never narrower than the minimum.
    await rig.send(press(width - 58, 10));
    await rig.send(dragTo(118, 10));
    await waitFor(() => borderX(rig), x => x === width - 36, {label: 'clamped at the narrow end'});
    await rig.send(release(118, 10));
    await waitFor(() => app.surfaces.sidebarWidthStore!.get(), value => value === 36, {label: 'remembered again'});
    // Hovering the border takes the accent colour and the tooltip names the gesture.
    const before = rig.output.text.length;
    await rig.mouse('move', width - 36, 12);
    await waitFor(() => rig.screen(), text => text.includes('Drag to resize · › to collapse'), {label: 'the tooltip'});
    const hex = (at: number) => parseInt(palette.accent.slice(at, at + 2), 16);
    assert.ok(rig.output.text.slice(before).includes(`\x1b[38;2;${hex(1)};${hex(3)};${hex(5)}m│`), 'the border is accent while hovered');
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a remembered sidebar width is used at start, re-clamped when the terminal resizes (and restored when it grows back), and a double click on the border resets it', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    app.surfaces.sidebarWidthStore!.set(56);
    await waitFor(() => app.surfaces.sidebarWidthStore!.get(), value => value === 56, {label: 'saved'});
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    assert.equal(borderX(rig), 119 - 56);
    await act(async () => {rig.output.resize(112, 32);});
    await waitFor(() => borderX(rig), x => x === 111 - 50, {label: 'clamped to 50 at 112 columns'});
    await act(async () => {rig.output.resize(120, 32);});
    await waitFor(() => borderX(rig), x => x === 119 - 56, {label: 'back to the remembered width'});
    assert.equal(app.surfaces.sidebarWidthStore!.get(), 56, 'clamping at another size never overwrites the choice');
    const x = borderX(rig);
    await rig.send(press(x, 10) + release(x, 10)); await rig.send(press(x, 10) + release(x, 10));
    await waitFor(() => borderX(rig), at => at === 119 - 40, {label: 'the default width'});
    await waitFor(() => app.surfaces.sidebarWidthStore!.get(), value => value === undefined, {label: 'the choice is forgotten'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the header row carries a collapse button in the border: hover says Collapse, a click hides the sidebar and the chip brings it back', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar'});
    const x = rig.sidebarX;
    assert.equal(rig.output.lines[0]![x], '›', 'the glyph is on the header row');
    assert.equal(rig.output.lines[6]![x], '│', 'the border continues below');
    await rig.mouse('move', x, 0);
    await waitFor(() => rig.screen(), text => /Collapse/.test(text), {label: 'the tooltip'});
    await rig.click(x, 0);
    await waitFor(() => rig.screen(), text => !hasCard(text) && text.includes('▸ Tasks 0/3'), {label: 'hidden, with the chip'});
    await rig.clickText('▸ Tasks');
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'shown again by the chip'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the overlay of a narrow terminal has the collapse button but no resize handle', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 100, 30);
    await act(async () => {await app.submit('/tasks');});
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the overlay'});
    const x = rig.output.lines[0]!.indexOf('›');
    assert.ok(x > 0, 'the glyph is drawn');
    const before = borderX(rig, 6);
    await rig.send(press(before, 10)); await rig.send(dragTo(before - 10, 10)); await rig.send(release(before - 10, 10));
    assert.equal(borderX(rig, 6), before, 'the overlay is not resizable');
    await rig.click(x, 0);
    await waitFor(() => rig.screen(), text => !hasCard(text), {label: 'closed'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('timeline text selection still works next to the docked sidebar, also when the drag ends over it', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINELEFT hello');
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => hasCard(text) && text.includes('TIMELINELEFT'), {label: 'both'});
    const at = rig.find('TIMELINELEFT');
    await rig.send(press(at.x, at.y) + dragTo(rig.sidebarX + 10, at.y) + release(rig.sidebarX + 10, at.y));
    const copied = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(rig.output.text);
    assert.ok(copied, 'the selection was copied');
    const text = Buffer.from(copied![1]!, 'base64').toString('utf8');
    assert.ok(text.includes('TIMELINELEFT hello'), text);
    assert.ok(!text.includes('Palette'), 'nothing of the sidebar is copied');
    assert.equal(borderX(rig), rig.sidebarX, 'the sidebar did not resize');
  } finally {if (rig) await unmount(rig); await f.close();}
});
