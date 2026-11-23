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
import {commandCatalog, commandHelp} from '../src/commands.js';
import {commandSuggestions} from '../src/tui/commands/completion.js';
import {TEAM_NO_TERMINAL, TEAM_USAGE} from '../src/commands/tasks-page.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type App = Awaited<ReturnType<typeof createApplication>>;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-programme-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
  const apps: App[] = [];
  return {root, cwd,
    async open(): Promise<App> {
      const app = await createApplication({cwd, config, provider, sessionId: 'plan-cmd', resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}
const surface = (app: App) => app.surfaces.getSnapshot();
type Picker = Extract<CommandSurface, {kind: 'picker'}>;
type Page = Extract<CommandSurface, {kind: 'page'}>;
const picker = (app: App): Picker => {const current = surface(app); assert.equal(current?.kind, 'picker', 'a picker is open: ' + current?.kind); return current as Picker;};

/** A plan with a running companion task on 1.1, an accepted 1.2 and a pending 2 after 1. */
async function seed(app: App) {
  const base = {sessionId: app.sessionId, stage: '', detail: ''};
  app.store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Build the palette', status: 'running', stage: 'On stage', rootActivityId: 'root', inputKind: 'director', startedAt: Date.now() - 30_000});
  const created = await app.plans.apply([{op: 'create', title: 'Theme preview', nodes: [
    {title: 'Design', owner: 'logox', nodes: [{title: 'Palette', owner: 'techne', acceptance: ['all colours named']}, {title: 'Contrast', owner: 'kalon'}]}, {title: 'Ship', owner: 'techne', after: ['1']}]}], 'logox');
  assert.ok(created.ok);
  app.plans.link('1.1', {activityId: 'tech'});
  assert.ok((await app.plans.apply([{op: 'accept', id: '1.2', evidence: ['ratio 5.1']}], 'logox')).ok);
}

test('the catalog, /help and completion know /team and no longer /tasks; /tasks is an unknown command; /team arguments are a usage error; without a terminal the sidebar cannot open', async () => {
  const entry = commandCatalog.find(command => command.name === 'team')!;
  assert.equal(entry.usage, '/team [show|hide|toggle]');
  assert.ok(!commandCatalog.some(command => command.name === 'tasks' || command.name === 'plan'));
  assert.ok(commandHelp().includes('/team [show|hide|toggle]: Team stage sidebar'));
  assert.ok(!commandHelp().includes('/tasks'));
  const none = {providers: [], loginProviders: [], models: []};
  assert.ok(commandSuggestions({text: '/te', cursor: 3}, none).some(item => item.label === '/team'));
  assert.ok(!commandSuggestions({text: '/ta', cursor: 3}, none).some(item => item.label === '/tasks'));
  const f = await fixture();
  try {
    const app = await f.open();
    await assert.rejects(app.submit('/tasks'), (error: Error) => /^Unknown command/.test(error.message), 'no alias: /tasks is handled like any unknown command');
    await assert.rejects(app.submit('/tasks plans'), (error: Error) => /^Unknown command/.test(error.message));
    await assert.rejects(app.submit('/team now'), (error: Error) => error.message === TEAM_USAGE);
    await assert.rejects(app.submit('/team sidebar sideways'), (error: Error) => error.message === TEAM_USAGE);
    await assert.rejects(app.submit('/team'), (error: Error) => error.message === TEAM_NO_TERMINAL);
    assert.equal(surface(app), null);
  } finally {await f.close();}
});

test('/team toggles the sidebar and /team [sidebar] [show|hide|toggle] sets it; the board can be peeked without reading files', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    const modes: string[] = [];
    const stop = app.surfaces.subscribeSidebar(mode => modes.push(mode));
    await app.submit('/team'); await app.submit('/team sidebar'); await app.submit('/team show'); await app.submit('/team sidebar HIDE'); await app.submit('/team toggle');
    assert.deepEqual(modes, ['toggle', 'toggle', 'show', 'hide', 'toggle']);
    stop();
    assert.equal(app.surfaces.requestSidebar('show'), false, 'no terminal listening');
    assert.equal(app.plans.peek(), undefined);
    await seed(app);
    assert.equal(app.plans.peek()?.title, 'Theme preview');
  } finally {await f.close();}
});

test('the Programme lists the acts in order with their tasks; the current act is marked; ids stay hidden; an empty session says so', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    app.surfaces.openProgramme();
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the empty programme'});
    assert.equal(picker(app).title, 'Programme');
    assert.deepEqual(picker(app).items, []);
    assert.match(picker(app).emptyText ?? '', /Nothing has been planned or delegated/);
    app.surfaces.cancel();
    await seed(app);
    app.surfaces.openProgramme();
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme'});
    const items = picker(app).items;
    // The plan was made inside the one open act: its phases and steps are that act's tasks, titled by the plan.
    assert.deepEqual(items.map(item => item.id), ['act:0', 'task:1', 'task:1.1', 'task:1.2', 'task:2']);
    assert.deepEqual(items.map(item => item.label), ['▸ Act 1 of 1 · Theme preview', '    ● Design', '      ● Palette', '      ✓ Contrast', '    ○ Ship']);
    assert.deepEqual(items.map(item => item.description), ['1/3 · running', 'Logox · running', 'Techne · running', 'Kalon · accepted', 'Techne · pending · after Design']);
    assert.ok(items.every(item => !/\b\d+\.\d+\b/.test(item.label + (item.description ?? ''))), 'no node id is shown');
  } finally {await f.close();}
});

test('two natural rounds are two acts; choosing an act heading moves the stage to that act and shows the sidebar', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    const now = Date.now(), base = {sessionId: app.sessionId, stage: '', detail: ''};
    const round = (id: string, from: number, to: number) => app.store.activities.create({...base, activityId: id, ownerId: 'logox', kind: 'director', title: id, status: 'completed', stopReason: 'completed', rootActivityId: id, inputKind: 'human', startedAt: now - from, finishedAt: now - to});
    const work = (id: string, root: string, ownerId: string, title: string, from: number, to: number) => app.store.activities.create({...base, activityId: id, ownerId, kind: 'actor', title: ownerId, taskTitle: title,
      status: 'completed', stopReason: 'completed', rootActivityId: root, parentActivityId: root, inputKind: 'director', startedAt: now - from, finishedAt: now - to});
    round('r1', 320_000, 250_000); work('k1', 'r1', 'kalon', 'Sketch', 300_000, 270_000);
    round('r2', 220_000, 100_000); work('t2', 'r2', 'techne', 'Pedal', 200_000, 150_000);
    const modes: string[] = [], acts: number[] = [];
    app.surfaces.subscribeSidebar(mode => modes.push(mode)); app.surfaces.subscribeStageAct(index => acts.push(index));
    app.surfaces.openProgramme();
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme'});
    assert.deepEqual(picker(app).items.map(item => item.id), ['act:0', 'task:1.1', 'act:1', 'task:2.1'], 'no plan: the tasks are the delegations, the round\'s own phase is no task');
    assert.deepEqual(picker(app).items.filter(item => item.id.startsWith('act:')).map(item => item.label), ['  Act 1 of 2 · Sketch', '▸ Act 2 of 2 · Pedal']);
    await app.surfaces.choose(picker(app).id, 'act:0');
    assert.deepEqual([acts, modes], [[0], ['show']]);
    await waitFor(() => surface(app), current => current === null, {label: 'the programme closed'});
    app.surfaces.openProgramme(0);
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme on act 1'});
    assert.deepEqual(picker(app).items.filter(item => item.label.startsWith('▸')).map(item => item.id), ['act:0'], 'the act the stage shows is marked');
  } finally {await f.close();}
});

test('a task opens its detail from the Programme: a plan node shows its fields, a link opens the delegation and Esc comes back each time; an accepted node shows its evidence', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    app.surfaces.openProgramme();
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme'});
    await app.surfaces.choose(picker(app).id, 'task:1.1');
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Palette', {label: 'the node detail'});
    const page = surface(app) as Page;
    const lines = page.tabs[0]!.lines.join('\n');
    assert.match(lines, /Title: Palette/); assert.match(lines, /Owner: Techne/); assert.match(lines, /Status: ● running/); assert.match(lines, /Parent: Design$/m); assert.doesNotMatch(lines, /^Id:/m); assert.doesNotMatch(lines, /\b\d+(\.\d+)+\b/);
    assert.match(lines, /all colours named/); assert.match(lines, /Not accepted yet\./); assert.match(lines, /1  Techne · Build the palette · running/);
    assert.deepEqual(page.tabs[0]!.actions?.map(action => [action.id, action.key]), [['link:tech', '1']]);
    await app.surfaces.triggerTabAction(page.id, 'detail', 'link:tech');
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Delegation · Build the palette', {label: 'the delegation detail'});
    app.surfaces.cancel();
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Palette', {label: 'back on the node'});
    app.surfaces.cancel();
    await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'back on the programme'});
    assert.equal(picker(app).title, 'Programme');
    await app.surfaces.choose(picker(app).id, 'task:1.2');
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Contrast', {label: 'the accepted node'});
    assert.match((surface(app) as Page).tabs[0]!.lines.join('\n'), /Accepted by: Logox[^\n]*\n[^\n]*ratio 5\.1/s);
  } finally {await f.close();}
});

test('earlier plans sit at the bottom of the Programme and can be re-activated (not while another plan is active); work nobody planned opens its delegation', async () => {
  const f = await fixture();
  try {
    const first = await f.open();
    await seed(first);
    await first.plans.flush();
    await first.close();
    // A new session of the same project: the first session's plan is earlier, read-only.
    const config = await loadConfig(f.cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, join(f.root, 'home'), f.root);
    const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
    const app = await createApplication({cwd: f.cwd, config, provider, sessionId: 'plan-cmd-two', resourceOptions: {home: join(f.root, 'home'), boundary: f.root}, env: {}, authPath: join(f.root, 'auth.json')});
    try {
      assert.equal(app.plans.peek(), undefined, 'this session has no plan');
      const base = {sessionId: app.sessionId, stage: '', detail: ''};
      app.store.activities.create({...base, activityId: 'solo', ownerId: 'logox', kind: 'director', title: 'A round', status: 'completed', rootActivityId: 'solo'});
      app.store.activities.create({...base, activityId: 'child', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Standalone', status: 'completed', rootActivityId: 'solo', parentActivityId: 'solo', inputKind: 'director', startedAt: Date.now() - 5000});
      app.surfaces.openProgramme();
      await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme'});
      assert.deepEqual(picker(app).items.map(item => item.id), ['act:0', 'task:1.1', '@earlier', 'adopt:p1']);
      const earlier = picker(app).items.filter(item => item.id === '@earlier' || item.id === 'adopt:p1');
      assert.deepEqual([earlier[0]!.label, earlier[0]!.disabled, earlier[1]!.label.trim()], ['Earlier plans · re-activate', true, 'Theme preview']);
      await app.surfaces.choose(picker(app).id, 'task:1.1');
      await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Delegation · Standalone', {label: 'work nobody planned opens its delegation'});
      app.surfaces.cancel();
      await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'back on the programme'});
      const modes: string[] = [];
      app.surfaces.subscribeSidebar(mode => modes.push(mode));
      await app.surfaces.choose(picker(app).id, 'adopt:p1');
      assert.equal(app.plans.peek()?.id, 'p1', 're-activated in this session');
      assert.deepEqual(modes, ['show']);
      app.surfaces.openProgramme();
      await waitFor(() => surface(app)?.kind, kind => kind === 'picker', {label: 'the programme after adopting'});
      assert.ok(!picker(app).items.some(item => item.id === 'adopt:p1'), 'the plan is this session\'s now');
    } finally {await app.close().catch(() => {});}
  } finally {await f.close();}
});

test('the mouse opens the Programme from the act header and a plan node\'s detail from it, and a click on a link action opens the work', {timeout: 40000}, async () => {
  const f = await fixture();
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = 120; output.rows = 32;
  let instance!: ReturnType<typeof render>;
  try {
    const app = await f.open();
    await seed(app);
    app.store.message(app.sessionId, 'logox', 'assistant', 'Ready when you are.');
    await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} plans={app.plans} surfaces={app.surfaces}
      onSubmit={app.submit} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
    const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
    const screen = () => output.lines.join('\n');
    const find = (needle: string) => {const y = output.lines.findLastIndex(line => line.includes(needle)); assert.ok(y >= 0, needle + ' on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(needle)};};
    const click = async (needle: string) => {const {x, y} = find(needle); await send(`\x1b[<0;${x + 1};${y + 1}M`); await send(`\x1b[<0;${x + 1};${y + 1}m`);};
    await waitFor(() => screen(), text => /‹ Act 1 of 1 · Theme/.test(text), {label: 'the act header'});
    await click('Act 1 of 1');
    await waitFor(() => screen(), text => /Programme/.test(text) && /Palette/.test(text) && /Earlier|Ship/.test(text), {label: 'the programme'});
    await click('Palette'); await click('Palette');
    await waitFor(() => screen(), text => /Acceptance/.test(text) && /all colours named/.test(text), {label: 'the detail page'});
    await click('Open Techne');
    await waitFor(() => screen(), text => /Assignment/.test(text) && /Build the palette/.test(text), {label: 'the delegation detail'});
    await send('\x1b');
    await waitFor(() => screen(), text => /Acceptance/.test(text), {label: 'back on the node'});
    await send('\x1b');
    await waitFor(() => screen(), text => /Programme/.test(text) && !/Acceptance/.test(text), {label: 'back on the programme'});
    await send('\x1b');
    await waitFor(() => screen(), text => /‹ Act 1 of 1 · Theme/.test(text) && !/Programme/.test(text), {label: 'back on the stage'});
  } finally {
    try {await act(async () => instance?.unmount());} catch {}
    input.destroy(); output.destroy();
    await f.close();
  }
});
