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
import {PLAN_EMPTY_TEXT} from '../src/commands/plan-page.js';
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

test('the catalog, /help and completion know /plan; arguments are a usage error; an empty session says there is no plan', async () => {
  const entry = commandCatalog.find(command => command.name === 'plan')!;
  assert.equal(entry.usage, '/plan');
  assert.equal(entry.description, 'The plan for the current request: phases, owners, status and acceptance');
  assert.ok(commandHelp().includes('/plan: The plan for the current request'));
  assert.ok(commandSuggestions({text: '/pla', cursor: 4}, {providers: [], loginProviders: [], models: []}).some(item => item.label === '/plan'));
  const f = await fixture();
  try {
    const app = await f.open();
    await assert.rejects(app.submit('/plan now'), /^Error: Usage: \/plan$/);
    await app.submit('/plan');
    assert.deepEqual(picker(app).items, []);
    assert.equal(picker(app).emptyText, PLAN_EMPTY_TEXT);
  } finally {await f.close();}
});

test('rows show glyph, id, title, owner, status and progress; Enter opens the detail; a link opens the /tasks detail and Esc comes back', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    await app.submit('/plan');
    const rows = picker(app).items.map(item => [item.id, item.label, item.description]);
    assert.deepEqual(rows, [
      ['1', '● 1 Design', 'logox · 1/2 · running'],
      ['1.1', '  ● 1.1 Palette', 'techne · running'],
      ['1.2', '  ✓ 1.2 Contrast', 'kalon · accepted'],
      ['2', '○ 2 Ship', 'techne · pending · after 1']]);
    assert.match(picker(app).description, /^p1 · active · 0\/2 accepted/);
    await app.surfaces.choose(picker(app).id, '1.1');
    const page = surface(app) as Page;
    assert.equal(page.kind, 'page');
    const lines = page.tabs[0]!.lines.join('\n');
    assert.match(lines, /Title: Palette/); assert.match(lines, /Owner: Techne/); assert.match(lines, /Status: ● running/); assert.match(lines, /Parent: 1 Design/);
    assert.match(lines, /all colours named/); assert.match(lines, /Not accepted yet\./); assert.match(lines, /1  Techne · Build the palette · running/);
    assert.deepEqual(page.tabs[0]!.actions?.map(action => [action.id, action.key]), [['link:tech', '1']]);
    // The accepted node shows its evidence.
    app.surfaces.cancel();
    await waitFor(() => surface(app)?.kind === 'picker' && picker(app).focus, focus => focus === '1.1', {label: 'back on the list'});
    await app.surfaces.choose(picker(app).id, '1.2');
    assert.match((surface(app) as Page).tabs[0]!.lines.join('\n'), /Accepted by: Logox[^\n]*\n[^\n]*ratio 5\.1/s);
    app.surfaces.cancel();
    await waitFor(() => surface(app)?.kind === 'picker', kind => kind, {label: 'list'});
    await app.surfaces.choose(picker(app).id, '1.1');
    await app.surfaces.triggerTabAction((surface(app) as Page).id, 'detail', 'link:tech');
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Delegation · Build the palette', {label: 'the /tasks detail'});
    app.surfaces.cancel();
    await waitFor(() => (surface(app) as Page | null)?.title, title => title === 'Plan node · Palette', {label: 'back on the node'});
  } finally {await f.close();}
});

test('the switcher row appears with several plans; an earlier session\'s plan is read-only until re-activated', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    await app.plans.apply([{op: 'abandon'}], 'logox');
    await app.plans.apply([{op: 'create', title: 'Second plan', nodes: [{title: 'Only', owner: 'logox'}]}], 'logox');
    await app.submit('/plan');
    assert.deepEqual(picker(app).items.map(item => item.id), ['@plans', '1']);
    assert.match(picker(app).title, /Plan · Second plan/);
    await app.surfaces.choose(picker(app).id, '@plans');
    assert.deepEqual(picker(app).items.map(item => item.id), ['p2', 'p1']);
    await app.surfaces.choose(picker(app).id, 'p1');
    await waitFor(() => surface(app)?.kind === 'picker' && picker(app).title, title => title === 'Plan · Theme preview', {label: 'the first plan'});
    assert.match(picker(app).description, /abandoned/);
  } finally {await f.close();}
});

test('the mouse selects and opens rows and a click on a link action opens the work', {timeout: 30000}, async () => {
  const f = await fixture();
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = 110; output.rows = 32;
  let instance!: ReturnType<typeof render>;
  try {
    const app = await f.open();
    await seed(app);
    await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} surfaces={app.surfaces}
      onSubmit={app.submit} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
    const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
    const screen = () => output.lines.join('\n');
    const find = (needle: string) => {const y = output.lines.findLastIndex(line => line.includes(needle)); assert.ok(y >= 0, needle + ' on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(needle)};};
    const click = async (needle: string) => {const {x, y} = find(needle); await send(`\x1b[<0;${x + 1};${y + 1}M`); await send(`\x1b[<0;${x + 1};${y + 1}m`);};
    await act(async () => {await app.submit('/plan');}); await instance.waitUntilRenderFlush();
    await waitFor(() => screen(), text => /1\.1 Palette/.test(text) && /2 Ship/.test(text), {label: 'the list'});
    await click('1.1 Palette');
    assert.match(screen(), /❯\s+●? ?1\.1 Palette/);
    await click('1.1 Palette');
    await waitFor(() => screen(), text => /Acceptance/.test(text) && /all colours named/.test(text), {label: 'the detail page'});
    await click('Open Techne');
    await waitFor(() => screen(), text => /Assignment/.test(text) && /Build the palette/.test(text), {label: 'the /tasks detail'});
    await send('\x1b');
    await waitFor(() => screen(), text => /Acceptance/.test(text), {label: 'back on the node'});
    await send('\x1b');
    await waitFor(() => screen(), text => /2 Ship/.test(text) && !/Acceptance/.test(text), {label: 'back on the list'});
  } finally {
    try {await act(async () => instance?.unmount());} catch {}
    input.destroy(); output.destroy();
    await f.close();
  }
});
