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
    async open(): Promise<Application> {
      const app = await createApplication({cwd, config, provider, sessionId: 'plan-ui', resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}

const NODES = [
  {title: 'Design', owner: 'logox', nodes: [{title: 'Palette', owner: 'techne', acceptance: ['all colours named']}, {title: 'Contrast', owner: 'kalon', after: ['1.1']}]},
  {title: 'Ship', owner: 'techne', after: ['1']}];
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
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette') && text.includes('Theme preview'), {label: 'the sidebar'});
    // The sidebar is the right-hand column; the timeline text stays on the left and the composer and footer keep their place.
    assert.ok(rig.find('1.1 Palette').x >= rig.sidebarX, 'the flow is in the right-hand column');
    assert.ok(rig.find('TIMELINELEFT').x < rig.sidebarX);
    assert.ok(sidebarLines(rig).some(line => line.startsWith('│')), 'the border column');
    assert.match(sidebarLines(rig)[1]!, /active · 0\/3/);
    assert.ok(!rig.output.lines.at(-1)!.includes('▸ Plan'), 'no chip while the sidebar is shown');
    await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINESECOND');});
    await waitFor(() => rig.screen(), text => text.includes('TIMELINESECOND'), {label: 'the timeline keeps working'});
    assert.ok(rig.screen().includes('1.1 Palette'));
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('linked work moves a node through running to done; the clock ticks beside it; finishing the plan hides the sidebar with a notice and a chip', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'the sidebar from the start (a resumed plan)'});
    assert.match(rig.screen(), /1\.1 Palette[^\n]*\n[^\n]*◌ ready/);
    await act(async () => {runningTechne(app); app.plans.link('1.1', {activityId: 'tech'});});
    await waitFor(() => rig.screen(), text => /● running\s+2:1\d/.test(text), {label: 'running with its clock'});
    await act(async () => {app.store.activities.update(app.sessionId, 'tech', {status: 'completed', stage: 'Completed', stopReason: 'completed', finishedAt: Date.now()});});
    await waitFor(() => rig.screen(), text => /◉ done/.test(text), {label: 'done'});
    assert.ok(!/● running\s+2:1\d/.test(rig.screen()));
    // Accepting every top-level node finishes the plan.
    await act(async () => {
      for (const id of ['1.1', '1.2', '2']) assert.ok((await app.plans.apply([{op: 'accept', id, evidence: ['checked']}], 'logox')).ok);
    });
    await waitFor(() => rig.screen(), text => !text.includes('1.1 Palette') && text.includes('Plan 3/3'), {label: 'hidden, with the chip'});
    assert.match(rig.screen(), /Plan p1 is done · \/plan sidebar or Ctrl\+B shows it again|▸ Plan 3\/3/);
    assert.ok(rig.output.lines.at(-1)!.includes('▸ Plan 3/3'), 'the chip is on the footer row');
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('hover highlights a node border, click folds a parent, double click opens the detail, wheel scrolls the sidebar only', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app, [...NODES, ...Array.from({length: 7}, (_, index) => ({title: 'Extra phase ' + index, owner: 'techne', nodes: [{title: 'Step', owner: 'kalon'}]}))]);
    rig = await mount(app, 120, 30);
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'the sidebar'});
    const rgb = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
    const at = rig.find('╭ 1.1 Palette');
    const before = rig.output.text.length;
    await rig.mouse('move', at.x + 3, at.y);
    await waitFor(() => rig.output.text.slice(before), text => text.includes(rgb(palette.accent) + '╭ '), {label: 'the hovered border in the accent colour'});
    // Click on the phase: its children fold away (and come back).
    const design = rig.find('1 Design');
    await rig.click(design.x + 2, design.y);
    await waitFor(() => rig.screen(), text => !text.includes('1.1 Palette') && text.includes('▸ 2 steps'), {label: 'folded'});
    await delay(400); // a second click inside 350 ms would be a double click
    await rig.click(design.x + 2, design.y);
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'unfolded'});
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
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette') && text.includes('Tail line 39'), {label: 'ready'});
    assert.ok(!rig.screen().includes('TECHNECARDBODY'), 'the card is off screen');
    const row = rig.find('1.1 Palette');
    const owner = rig.find('techne', rig.sidebarX);
    assert.ok(owner.y > row.y);
    await rig.click(owner.x + 1, owner.y);
    await waitFor(() => rig.screen(), text => /TECHNECARDBODY|Techne/.test(text) && !text.includes('Tail line 39'), {label: 'the timeline scrolled to the card'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('keyboard: Ctrl+B shows and focuses, arrows move, Enter opens, Esc returns to the composer, typing goes to the composer, Ctrl+B again hides, the chip brings it back', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32, {getStatus: (ownerId: string) => ({ownerId, name: ownerId, state: 'ready'})});
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'the sidebar'});
    await rig.send('hi');
    assert.ok(rig.screen().includes('hi'), 'typing reaches the composer while the sidebar is unfocused');
    await rig.send('\x02'); // Ctrl+B focuses
    assert.match(rig.screen(), /↑↓←→ move · Enter open · Esc back/);
    await rig.send('\x1b[B'); await rig.send('\x1b[B'); // the phase, then its first step
    await rig.send('\r');
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'Enter opens the detail of the selected node'});
    assert.match((surface(app) as Extract<CommandSurface, {kind: 'page'}>).title, /^Plan node · Palette$/);
    await rig.send('\x1b');
    await waitFor(() => surface(app), current => current === null, {label: 'Esc closes the detail'});
    await rig.send('\x1b'); // back to the composer
    assert.ok(!/↑↓←→ move/.test(rig.screen()), 'the keyboard is back in the composer');
    await rig.send('\x02'); // focus again: a typing key returns it to the composer and is typed there
    await rig.send('x');
    assert.ok(/❯ hix/.test(rig.screen()), 'the key was typed into the composer:\n' + rig.screen());
    await rig.send('\x02'); await rig.send('\x02'); // focus, then hide
    await waitFor(() => rig.screen(), text => !text.includes('1.1 Palette') && text.includes('▸ Plan 0/3'), {label: 'hidden by the shortcut; the chip shows'});
    // The chip is a button: hover shows its hint, a click shows the sidebar again.
    const chip = rig.find('▸ Plan 0/3');
    await rig.mouse('move', chip.x + 2, chip.y);
    await waitFor(() => rig.screen(), text => text.includes('click or Ctrl+B shows it'), {label: 'the chip hint on the notification row'});
    await rig.click(chip.x + 2, chip.y);
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette') && !text.includes('▸ Plan 0/3'), {label: 'shown again'});
    // /plan sidebar hides it too.
    await act(async () => {await app.submit('/plan sidebar hide');});
    await waitFor(() => rig.screen(), text => !text.includes('1.1 Palette'), {label: '/plan sidebar hide'});
    await act(async () => {await app.submit('/plan sidebar');});
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: '/plan sidebar toggles'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a hidden sidebar stays hidden when the next plan starts; below 110 columns nothing docks and the toggle opens an overlay', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINEWORD');
    rig = await mount(app, 90, 28);
    await act(async () => {await create(app);});
    await waitFor(() => rig.screen(), text => text.includes('▸ Plan 0/3'), {label: 'only the chip at 90 columns'});
    assert.ok(!rig.screen().includes('1.1 Palette'), 'never squeezes the timeline');
    assert.ok(rig.find('TIMELINEWORD').x < 5);
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette') && text.includes('Esc or Ctrl+B closes'), {label: 'the overlay'});
    await rig.send('\x1b');
    await waitFor(() => rig.screen(), text => !text.includes('1.1 Palette') && text.includes('TIMELINEWORD'), {label: 'the overlay closed'});
    // The overlay closes on a click outside the panel, too.
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'the overlay again'});
    await rig.click(2, 10);
    await waitFor(() => rig.screen(), text => !text.includes('1.1 Palette'), {label: 'closed by a click'});
    // Widen: a plan created while narrow shows up docked.
    await act(async () => {rig.output.resize(120, 28);});
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'docked after widening'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('unrelated store changes neither rebuild the flow nor repaint the sidebar', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('1.1 Palette'), {label: 'the sidebar'});
    await delay(60);
    const builds = flowStats.builds, mark = rig.output.text.length;
    for (let i = 0; i < 3; i++) await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'unrelated message ' + i); await delay(30);});
    await waitFor(() => rig.screen(), text => text.includes('unrelated message 2'), {label: 'the timeline updated'});
    assert.equal(flowStats.builds, builds, 'the layout is not rebuilt');
    assert.ok(!rig.output.text.slice(mark).includes('1.1 Palette'), 'no sidebar row was painted again');
    // A change of the plan does repaint it.
    await act(async () => {assert.ok((await app.plans.apply([{op: 'update', id: '1.1', title: 'Palette v2'}], 'logox')).ok);});
    await waitFor(() => rig.screen(), text => text.includes('Palette v2'), {label: 'the plan change'});
    assert.ok(flowStats.builds > builds);
  } finally {if (rig) await unmount(rig); await f.close();}
});
