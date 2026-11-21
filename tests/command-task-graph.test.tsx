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
import {TASKS_NO_TERMINAL, TASKS_USAGE} from '../src/commands/tasks-page.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import type {SidebarSource} from '../src/commands/surfaces.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type App = Awaited<ReturnType<typeof createApplication>>;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-plan-cmd-')));
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
  app.store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Build the palette', status: 'running', stage: 'On stage', rootActivityId: 'root'});
  const created = await app.plans.apply([{op: 'create', title: 'Theme preview', nodes: [
    {title: 'Design', owner: 'logox', nodes: [{title: 'Palette', owner: 'techne', acceptance: ['all colours named']}, {title: 'Contrast', owner: 'kalon'}]}, {title: 'Ship', owner: 'techne', after: ['1']}]}], 'logox');
  assert.ok(created.ok);
  app.plans.link('1.1', {activityId: 'tech'});
  assert.ok((await app.plans.apply([{op: 'accept', id: '1.2', evidence: ['ratio 5.1']}], 'logox')).ok);
}

test('the catalog, /help and completion know /tasks and no longer /plan; arguments are a usage error; without a terminal the sidebar cannot open', async () => {
  const entry = commandCatalog.find(command => command.name === 'tasks')!;
  assert.equal(entry.usage, '/tasks [plans|sidebar]');
  assert.ok(!commandCatalog.some(command => command.name === 'plan'));
  assert.ok(commandHelp().includes('/tasks [plans|sidebar]: Task flowchart sidebar'));
  assert.ok(commandSuggestions({text: '/ta', cursor: 3}, {providers: [], loginProviders: [], models: []}).some(item => item.label === '/tasks'));
  assert.ok(!commandSuggestions({text: '/pla', cursor: 4}, {providers: [], loginProviders: [], models: []}).some(item => item.label === '/plan'));
  const f = await fixture();
  try {
    const app = await f.open();
    await assert.rejects(app.submit('/tasks now'), (error: Error) => error.message === TASKS_USAGE);
    await assert.rejects(app.submit('/tasks sidebar sideways'), (error: Error) => error.message === TASKS_USAGE);
    await assert.rejects(app.submit('/tasks'), (error: Error) => error.message === TASKS_NO_TERMINAL);
    assert.equal(surface(app), null);
  } finally {await f.close();}
});

test('/tasks toggles the sidebar and /tasks sidebar [show|hide|toggle] sets it; the board can be peeked without reading files; a node opens by id', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    const modes: string[] = [];
    const stop = app.surfaces.subscribePlanSidebar(mode => modes.push(mode));
    await app.submit('/tasks'); await app.submit('/tasks sidebar'); await app.submit('/tasks sidebar show'); await app.submit('/tasks sidebar HIDE');
    assert.deepEqual(modes, ['toggle', 'toggle', 'show', 'hide']);
    stop();
    assert.equal(app.surfaces.requestPlanSidebar('show'), false, 'no terminal listening');
    assert.equal(app.plans.peek(), undefined);
    await seed(app);
    assert.equal(app.plans.peek()?.title, 'Theme preview');
    app.surfaces.openPlanNode('1.1');
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Palette', {label: 'the node detail'});
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'Esc closes it (the sidebar is the parent)'});
  } finally {await f.close();}
});

test('a plan node\'s detail shows its fields; a link opens the delegation detail and Esc comes back; an accepted node shows its evidence', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    app.surfaces.openPlanNode('1.1');
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
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    app.surfaces.openPlanNode('1.2');
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Contrast', {label: 'the accepted node'});
    assert.match((surface(app) as Page).tabs[0]!.lines.join('\n'), /Accepted by: Logox[^\n]*\n[^\n]*ratio 5\.1/s);
  } finally {await f.close();}
});

test('/tasks plans lists the plans of the project; choosing one tells the sidebar what to draw; an earlier session\'s plan is read-only until re-activated', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    await app.plans.apply([{op: 'abandon'}], 'logox');
    await app.plans.apply([{op: 'create', title: 'Second plan', nodes: [{title: 'Only', owner: 'logox'}]}], 'logox');
    const sources: SidebarSource[] = [], modes: string[] = [];
    app.surfaces.subscribeSidebarSource(source => sources.push(source));
    app.surfaces.subscribePlanSidebar(mode => modes.push(mode));
    await app.submit('/tasks plans');
    assert.deepEqual(picker(app).items.map(item => item.id), ['@auto', '@work', 'p2', 'p1'], 'the seeded task has no round on record: it stands as a phase, so there is work to show');
    assert.equal(picker(app).title, 'Plans');
    await app.surfaces.choose(picker(app).id, 'p1');
    assert.deepEqual(sources, [{kind: 'plan', id: 'p1'}]);
    assert.deepEqual(modes, ['show']);
    await waitFor(() => surface(app), current => current === null, {label: 'the picker closed'});
    await app.submit('/tasks plans');
    await app.surfaces.choose(picker(app).id, '@auto');
    assert.deepEqual(sources.at(-1), {kind: 'auto'});
  } finally {await f.close();}
});

test('the switcher offers the work done so far when there is any, and a re-activate row for a plan of an earlier session', async () => {
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
      const earlier = await app.plans.earlier();
      assert.equal(earlier?.title, 'Theme preview', 'the earlier session\'s plan is found, read-only');
      const base = {sessionId: app.sessionId, stage: '', detail: ''};
      app.store.activities.create({...base, activityId: 'solo', ownerId: 'logox', kind: 'director', title: 'A round', status: 'completed', rootActivityId: 'solo'});
      app.store.activities.create({...base, activityId: 'child', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Standalone', status: 'completed', rootActivityId: 'solo', parentActivityId: 'solo'});
      await app.submit('/tasks plans');
      assert.deepEqual(picker(app).items.map(item => item.id), ['@auto', '@work', 'p1', '@adopt:p1']);
      app.surfaces.cancel();
      app.surfaces.openPlanNode('1.1', 'p1');
      await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Palette', {label: 'the earlier plan\'s node'});
      app.surfaces.cancel();
      await app.submit('/tasks plans');
      await app.surfaces.choose(picker(app).id, '@adopt:p1');
      assert.equal(app.plans.peek()?.id, 'p1', 're-activated in this session');
    } finally {await app.close().catch(() => {});}
  } finally {await f.close();}
});

test('the mouse opens a plan node\'s detail from the sidebar and a click on a link action opens the work', {timeout: 30000}, async () => {
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
    await waitFor(() => screen(), text => /╭ Palette/.test(text) && /Ship/.test(text), {label: 'the sidebar'});
    await click('╭ Palette'); await click('╭ Palette');
    await waitFor(() => screen(), text => /Acceptance/.test(text) && /all colours named/.test(text), {label: 'the detail page'});
    await click('Open Techne');
    await waitFor(() => screen(), text => /Assignment/.test(text) && /Build the palette/.test(text), {label: 'the delegation detail'});
    await send('\x1b');
    await waitFor(() => screen(), text => /Acceptance/.test(text), {label: 'back on the node'});
    await send('\x1b');
    await waitFor(() => screen(), text => /Ship/.test(text) && !/Acceptance/.test(text), {label: 'back on the sidebar'});
  } finally {
    try {await act(async () => instance?.unmount());} catch {}
    input.destroy(); output.destroy();
    await f.close();
  }
});
