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
import {teamStats} from '../src/tui/panels/team-sidebar.js';
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-stage-ui-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
  const apps: Application[] = [];
  return {root,
    async open(sessionId = 'stage-ui'): Promise<Application> {
      const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}

const create = (app: Application) => twoActs(app, true);
/** The stage is up: an act header (the session of `twoActs` has two acts). */
const stageUp = (text: string) => /Act \d of 2 · /.test(text);
/**
 * Two natural rounds of the Director, each with one companion: Kalon sketches (act 1), the Director's round closes, then Techne animates (act 2) and that round closes.
 * With `plan` a plan made inside them links its tasks to the work (its title is then the title of both acts), and is active, so the sidebar opens by itself.
 */
async function twoActs(app: Application, plan = false) {
  const now = Date.now(), base = {sessionId: app.sessionId, stage: '', detail: ''};
  const round = (id: string, title: string, from: number, to: number) => app.store.activities.create({...base, activityId: id, ownerId: 'logox', kind: 'director', title, status: 'completed', stopReason: 'completed',
    rootActivityId: id, inputKind: 'human', startedAt: now - from, finishedAt: now - to});
  const work = (id: string, root: string, ownerId: string, title: string, from: number, to: number) => app.store.activities.create({...base, activityId: id, ownerId, kind: 'actor', title: ownerId, taskTitle: title,
    status: 'completed', stopReason: 'completed', rootActivityId: root, parentActivityId: root, inputKind: 'director', startedAt: now - from, finishedAt: now - to});
  round('root', 'Draw it', 320_000, 250_000); work('k1', 'root', 'kalon', 'Sketch the pelican', 300_000, 270_000);
  round('root2', 'Animate it', 220_000, 100_000); work('t2', 'root2', 'techne', 'Pedal loop', 200_000, 150_000);
  if (!plan) return;
  assert.ok((await app.plans.apply([{op: 'create', title: 'Pelican', nodes: [{title: 'Draw', owner: 'logox', nodes: [{title: 'Sketch the pelican', owner: 'kalon'}]},
    {title: 'Animate', owner: 'logox', nodes: [{title: 'Pedal loop', owner: 'techne'}]}]}], 'logox')).ok);
  app.plans.link('1.1', {activityId: 'k1'}); app.plans.link('2.1', {activityId: 't2'});
}

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
const sidebarText = (rig: Rig) => sidebarLines(rig).join('\n');

test('the stage appears beside the timeline when a plan is created, with the timeline narrowed and still working; its header is the act header', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINELEFT hello');
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('TIMELINELEFT'), {label: 'the timeline'});
    assert.ok(!stageUp(rig.screen()), 'no plan, no sidebar');
    await act(async () => {await create(app);});
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar'});
    // The sidebar is the right-hand column; the timeline text stays on the left and the composer and footer keep their place.
    assert.ok(rig.find('Act 2 of 2', rig.sidebarX).x >= rig.sidebarX, 'the header is in the right-hand column');
    assert.ok(rig.find('TIMELINELEFT').x < rig.sidebarX);
    assert.ok(sidebarLines(rig).some(line => line.startsWith('│')), 'the border column');
    assert.match(sidebarLines(rig)[0]!, /^› +‹ Act 2 of 2 · Pelican +━+ 1\/1 ›/, 'the act header: step arrows, the plan\'s title, bar and what is settled');
    assert.doesNotMatch(sidebarText(rig), /Tasks|\b\d+\.\d+\b/, 'no Tasks tab, no node id');
    assert.ok(!rig.output.lines.at(-1)!.includes('▸ Act'), 'no chip while the sidebar is shown');
    await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINESECOND');});
    await waitFor(() => rig.screen(), text => text.includes('TIMELINESECOND'), {label: 'the timeline keeps working'});
    assert.ok(stageUp(rig.screen()));
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('finishing the plan hides the sidebar with a notice and the chip `▸ Act 2/2 · 1/1`; the chip brings it back', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar from the start (a resumed plan)'});
    // Accepting every top-level node finishes the plan.
    await act(async () => {
      for (const id of ['1.1', '1', '2.1', '2']) assert.ok((await app.plans.apply([{op: 'accept', id, evidence: ['checked']}], 'logox')).ok);
    });
    await waitFor(() => rig.screen(), text => !stageUp(text) && text.includes('▸ Act 2/2 · 1/1'), {label: 'hidden, with the chip'});
    assert.ok(rig.output.lines.at(-1)!.includes('▸ Act 2/2 · 1/1'), 'the chip is on the footer row');
    await rig.clickText('▸ Act');
    await waitFor(() => rig.screen(), text => /Act 2 of 2 · Pelican/.test(text) && !text.includes('▸ Act 2/2'), {label: 'shown again by the chip'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('each act is its own scene: the header follows the replay point, `[` `]` and the arrows step between acts, only that act\'s companions stand on stage and their cards name their task', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await twoActs(app);
    rig = await mount(app, 120, 44);
    await act(async () => {await app.submit('/team');});
    // Live: the act of the newest event, titled by the Director's assignment (no plan).
    await waitFor(() => rig.screen(), text => /Act 2 of 2 · Pedal/.test(text) && /Techne/.test(sidebarText(rig)) && /Peda/.test(sidebarText(rig)), {label: 'Live is in the second act'});
    assert.ok(!/Kalon/.test(sidebarText(rig)), 'Kalon belongs to the first act and has left the stage');
    await rig.send('\x02'); // Ctrl+B focuses
    await rig.send('[');
    await waitFor(() => rig.screen(), text => /Act 1 of 2 · Sketch/.test(text) && /Kalon/.test(sidebarText(rig)) && /Sket/.test(sidebarText(rig)), {label: '[ is the first act'});
    assert.ok(!/Techne/.test(sidebarText(rig)), 'Techne is not part of the first act');
    await rig.send('[');
    assert.match(rig.screen(), /Act 1 of 2 · Sketch/, 'no act before the first');
    await rig.send(']');
    await waitFor(() => rig.screen(), text => /Act 2 of 2 · Pedal/.test(text) && /Techne/.test(sidebarText(rig)), {label: '] is the second act'});
    // The arrows on the header do the same.
    const prev = rig.find('‹', rig.sidebarX);
    await rig.click(prev.x, prev.y);
    await waitFor(() => rig.screen(), text => /Act 1 of 2 · Sketch/.test(text), {label: 'the left arrow'});
    const next = rig.find('›', rig.sidebarX + 3);
    await rig.click(next.x, next.y);
    await waitFor(() => rig.screen(), text => /Act 2 of 2 · Pedal/.test(text), {label: 'the right arrow'});
    // `p` and a click on the title open the Programme with the current act marked.
    await rig.send('p');
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'p opens the programme'});
    assert.match(rig.screen(), /▸ Act 2 of 2 · Pedal loop/);
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    const title = rig.find('Pedal', rig.sidebarX);
    await rig.click(title.x, title.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'a click on the title opens the programme'});
    // Choosing an act heading there moves the stage to it.
    await app.surfaces.choose((surface(app) as Extract<CommandSurface, {kind: 'picker'}>).id, 'act:0');
    await waitFor(() => rig.screen(), text => /Act 1 of 2 · Sketch/.test(text) && /Kalon/.test(sidebarText(rig)), {label: 'the stage moved to the first act'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('keyboard: Ctrl+B shows and focuses, Esc returns to the composer, typing goes to the composer, Ctrl+B again hides, the chip brings it back; /team sets it', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32, {getStatus: (ownerId: string) => ({ownerId, name: ownerId, state: 'ready'})});
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar'});
    await rig.send('hi');
    assert.ok(rig.screen().includes('hi'), 'typing reaches the composer while the sidebar is unfocused');
    await rig.send('\x02'); // Ctrl+B focuses
    await rig.send('\x1b'); // back to the composer
    await rig.send('\x02'); // focus again: a typing key returns it to the composer and is typed there
    await rig.send('x');
    assert.ok(/❯ hix/.test(rig.screen()), 'the key was typed into the composer:\n' + rig.screen());
    await rig.send('\x02'); await rig.send('\x02'); // focus, then hide
    await waitFor(() => rig.screen(), text => !stageUp(text) && text.includes('▸ Act 2/2 · 1/1'), {label: 'hidden by the shortcut; the chip shows'});
    // The chip is a button: hover shows its hint, a click shows the sidebar again.
    const chip = rig.find('▸ Act 2/2 · 1/1');
    await rig.mouse('move', chip.x + 2, chip.y);
    await waitFor(() => rig.screen(), text => text.includes('click or Ctrl+B shows it'), {label: 'the chip hint on the notification row'});
    await rig.click(chip.x + 2, chip.y);
    await waitFor(() => rig.screen(), text => stageUp(text) && !text.includes('▸ Act 2/2'), {label: 'shown again'});
    // /team hides it and shows it again; /tasks is not a command.
    await act(async () => {await app.submit('/team sidebar hide');});
    await waitFor(() => rig.screen(), text => !stageUp(text), {label: '/team sidebar hide'});
    await act(async () => {await app.submit('/team');});
    await waitFor(() => rig.screen(), stageUp, {label: '/team toggles'});
    await assert.rejects(app.submit('/tasks'), /Unknown command/);
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a hidden sidebar stays hidden when the next plan starts; below 110 columns nothing docks and the toggle opens an overlay', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINEWORD');
    rig = await mount(app, 90, 28);
    await act(async () => {await create(app);});
    await waitFor(() => rig.screen(), text => text.includes('▸ Act 2/2 · 1/1'), {label: 'only the chip at 90 columns'});
    assert.ok(!stageUp(rig.screen()), 'never squeezes the timeline');
    assert.ok(rig.find('TIMELINEWORD').x < 5);
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => stageUp(text) && text.includes('Esc or Ctrl+B closes'), {label: 'the overlay'});
    await rig.send('\x1b');
    await waitFor(() => rig.screen(), text => !stageUp(text) && text.includes('TIMELINEWORD'), {label: 'the overlay closed'});
    // The overlay closes on a click outside the panel, too.
    await rig.send('\x02');
    await waitFor(() => rig.screen(), stageUp, {label: 'the overlay again'});
    await rig.click(2, 10);
    await waitFor(() => rig.screen(), text => !stageUp(text), {label: 'closed by a click'});
    // Widen: a plan created while narrow shows up docked.
    await act(async () => {rig.output.resize(120, 28);});
    await waitFor(() => rig.screen(), stageUp, {label: 'docked after widening'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('unrelated store changes neither rebuild the layout nor repaint the sidebar', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar'});
    await delay(60);
    const builds = teamStats.builds;
    for (let i = 0; i < 3; i++) await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'unrelated message ' + i); await delay(30);});
    await waitFor(() => rig.screen(), text => text.includes('unrelated message 2'), {label: 'the timeline updated'});
    assert.equal(teamStats.builds, builds, 'the layout is not rebuilt');
    // A change of the plan does.
    await act(async () => {assert.ok((await app.plans.apply([{op: 'update', id: '2.1', title: 'Pedal loop v2'}], 'logox')).ok);});
    await waitFor(() => teamStats.builds, count => count > builds, {label: 'the plan change rebuilds the layout'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

const swarmJob = (app: Application, activityId: string, id: string, title: string) => app.store.message(app.sessionId, 'techne', 'assistant', '', {activityId, kind: 'tool',
  step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm: {name: 'crew', jobs: [{id, title, state: 'done', elapsedMs: 100, calls: [], route: 'read', model: 'mock/reader', stopReason: 'completed', summary: 'found them'}]}}} as never);

test('with no plan the work of the session is one act per round: nothing opens by itself, the chip offers it, /team shows it, a click on the header opens the Programme', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    const base = {sessionId: app.sessionId, stage: '', detail: '', rootActivityId: 'root'};
    app.store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Fix the parser', status: 'completed'});
    app.store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Build the palette', status: 'running', stage: 'On stage', parentActivityId: 'root', inputKind: 'director', startedAt: Date.now() - 130_000});
    swarmJob(app, 'tech', 'T1', 'Find the callers');
    rig = await mount(app, 120, 44);
    await waitFor(() => rig.screen(), text => /▸ Act 1\/1 · \d\/\d/.test(text), {label: 'the chip offers the act'});
    assert.ok(!rig.screen().includes('Act 1 of 1'), 'a session without a plan never opens the sidebar by itself');
    await act(async () => {await app.submit('/team');});
    await waitFor(() => rig.screen(), text => /‹ Act 1 of 1 · Build/.test(text) && /│ Build/.test(sidebarText(rig)), {label: 'the act of the round titled by the first assignment, the card names its task'});
    assert.ok(!rig.output.lines.at(-1)!.includes('▸ Act'), 'no chip while it is shown');
    const head = rig.find('Build', rig.sidebarX);
    await rig.click(head.x + 2, head.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme'});
    assert.equal((surface(app) as Extract<CommandSurface, {kind: 'picker'}>).title, 'Programme');
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    await act(async () => {await app.submit('/team sidebar hide');});
    await waitFor(() => rig.screen(), text => !text.includes('Act 1 of 1') && /▸ Act 1\/1/.test(text), {label: 'hidden again'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('Ctrl+B with nothing planned or delegated says so instead of opening an empty sidebar', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('Ready when you are.'), {label: 'mounted'});
    await rig.send('\x02');
    await waitFor(() => rig.screen(), text => /Nothing has been planned or delegated/.test(text), {label: 'the empty notice'});
    assert.ok(!stageUp(rig.screen()));
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
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar'});
    const width = 119; // usable width: one column less than the terminal
    assert.equal(borderX(rig), rig.sidebarX);
    assert.equal(rig.sidebarX, width - 40, 'the default is 34%');
    await rig.send(press(rig.sidebarX, 10));
    await rig.send(dragTo(rig.sidebarX - 8, 10));
    await waitFor(() => borderX(rig), x => x === rig.sidebarX - 8, {label: 'the sidebar grew by eight columns'});
    assert.ok(stageUp(rig.screen()), 'the stage was laid out again at the new width');
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
    // Hovering the border takes the accent colour.
    const before = rig.output.text.length;
    await rig.mouse('move', width - 36, 12);
    const hex = (at: number) => parseInt(palette.accent.slice(at, at + 2), 16);
    await waitFor(() => rig.output.text.slice(before), text => text.includes(`\x1b[38;2;${hex(1)};${hex(3)};${hex(5)}m│`), {label: 'the border is accent while hovered'});
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
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar'});
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

test('the header row carries a collapse button in the border: a click hides the sidebar and the chip brings it back', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), stageUp, {label: 'the sidebar'});
    const x = rig.sidebarX;
    assert.equal(rig.output.lines[0]![x], '›', 'the glyph is on the header row');
    assert.equal(rig.output.lines[6]![x], '│', 'the border continues below');
    await rig.click(x, 0);
    await waitFor(() => rig.screen(), text => !stageUp(text) && text.includes('▸ Act 2/2 · 1/1'), {label: 'hidden, with the chip'});
    await rig.clickText('▸ Act');
    await waitFor(() => rig.screen(), stageUp, {label: 'shown again by the chip'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the overlay of a narrow terminal has the collapse button but no resize handle', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    await create(app);
    rig = await mount(app, 100, 30);
    await act(async () => {await app.submit('/team');});
    await waitFor(() => rig.screen(), stageUp, {label: 'the overlay'});
    const x = rig.output.lines[0]!.indexOf('›');
    assert.ok(x > 0, 'the glyph is drawn');
    const before = borderX(rig, 6);
    await rig.send(press(before, 10)); await rig.send(dragTo(before - 10, 10)); await rig.send(release(before - 10, 10));
    assert.equal(borderX(rig, 6), before, 'the overlay is not resizable');
    await rig.click(x, 0);
    await waitFor(() => rig.screen(), text => !stageUp(text), {label: 'closed'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('timeline text selection still works next to the docked sidebar, also when the drag ends over it', {timeout: 40000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINELEFT hello');
    await create(app);
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => stageUp(text) && text.includes('TIMELINELEFT'), {label: 'both'});
    const at = rig.find('TIMELINELEFT');
    await rig.send(press(at.x, at.y) + dragTo(rig.sidebarX + 10, at.y) + release(rig.sidebarX + 10, at.y));
    const copied = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(rig.output.text);
    assert.ok(copied, 'the selection was copied');
    const text = Buffer.from(copied![1]!, 'base64').toString('utf8');
    assert.ok(text.includes('TIMELINELEFT hello'), text);
    assert.ok(!text.includes('Act 1 of 2'), 'nothing of the sidebar is copied');
    assert.equal(borderX(rig), rig.sidebarX, 'the sidebar did not resize');
  } finally {if (rig) await unmount(rig); await f.close();}
});
