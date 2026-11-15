import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {commandCatalog, commandHelp} from '../src/commands.js';
import {commandSuggestions} from '../src/tui/commands/completion.js';
import {emptyDraft} from '../src/tui/input/editor.js';
import {MemoryStore} from '../src/anamnesis/memory.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import {createTestApplication as createApplication, waitForSnapshot} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type App = Awaited<ReturnType<typeof createApplication>>;
const isAnamnesis = (request: ModelRequest) => request.tools.length === 0 && request.system.startsWith('You are Anamnesis');

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-anamnesis-cmd-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  await writeFile(join(home, '.logox', 'models-store.json'), JSON.stringify({version: 1, updatedAt: Date.now(),
    models: [{provider: 'openai', id: 'model-a', window: 131072, thinkingLevels: ['low', 'high']}, {provider: 'openai', id: 'model-b', window: 131072}]}));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const seen: ModelRequest[] = [];
  const control = {hold: false};
  const provider: Provider = {async respond(request, _delta, signal) {
    seen.push(request);
    if (isAnamnesis(request)) {
      if (control.hold) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      return {message: {role: 'assistant', text: request.system.includes('memory keeper of the LOGOX ensemble. While') ? '{"operations": []}' : 'Where it stands\n\nDone: x'}, stop: 'complete'};
    }
    return {message: {role: 'assistant', text: 'Understood, noted.'}, stop: 'complete'};
  }};
  const apps: App[] = [];
  const open = async (extra: Record<string, unknown> = {}, sessionId = 'anamnesis-cmd'): Promise<App> => {
    const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json'), ...extra});
    apps.push(app); return app;
  };
  return {root, cwd, home, seen, control, open, memory: new MemoryStore(cwd, home),
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true});}};
}
async function speak(app: App, text: string) {
  const before = app.store.getSnapshot().activities.filter(activity => activity.status === 'completed').length;
  await app.submit(text);
  await waitForSnapshot(app.store, snapshot => snapshot.activities.filter(activity => activity.status === 'completed').length > before && !app.ensemble.isBusy());
}
const surface = (app: App) => app.surfaces.getSnapshot();
type Picker = Extract<CommandSurface, {kind: 'picker'}>;
const picker = (app: App): Picker => {const current = surface(app); assert.equal(current?.kind, 'picker', 'a picker is open: ' + current?.kind); return current as Picker;};
const rows = (app: App) => Object.fromEntries(picker(app).items.map(item => [item.label, item.description ?? '']));
/** Esc: the level closes and its parent opens (a moment later, the parent reads its values again). */
async function back(app: App, title: string) {
  app.surfaces.cancel();
  await waitFor(() => surface(app)?.kind === 'picker' && picker(app).title, found => found === title, {label: 'back on ' + title});
}
const statusTexts =(app: App) => app.store.getSnapshot().messages.filter(message => message.role === 'system').map(message => message.text);

test('the catalog, /help and completion know /anamnesis and its two arguments', async () => {
  const entry = commandCatalog.find(command => command.name === 'anamnesis')!;
  assert.deepEqual({usage: entry.usage, description: entry.description}, {usage: '/anamnesis [recap|dream]', description: 'Recap and memory: run one now, browse or delete memory records, choose the model'});
  assert.ok(commandHelp().includes('/anamnesis [recap|dream]: Recap and memory'));
  const suggest = (text: string) => commandSuggestions({text, cursor: text.length}, {providers: [], loginProviders: [], models: []});
  assert.ok(suggest('/anam').some(item => item.label === '/anamnesis'));
  assert.deepEqual(suggest('/anamnesis ').map(item => item.label), ['recap', 'dream']);
  assert.deepEqual(suggest('/anamnesis d').map(item => item.label), ['dream']);
  assert.deepEqual(suggest('/anamnesis dream x'), []);
  void emptyDraft;
});

test('/anamnesis recap and dream start at once with a receipt, an unknown argument is a usage error, a busy foreground is a command error', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await speak(app, 'something worth a note');
    await app.submit('/anamnesis recap');
    assert.equal(surface(app), null, 'no page opens');
    assert.ok(statusTexts(app).includes('Anamnesis is writing a recap.'));
    await waitFor(() => app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis'), card => card?.status === 'completed', {label: 'recap card'});
    assert.equal(app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!.stage, 'Where it stands');
    await app.submit('/anamnesis dream');
    assert.ok(statusTexts(app).includes('Anamnesis is reviewing the session.'));
    await waitFor(() => app.store.getSnapshot().activities.filter(activity => activity.kind === 'anamnesis' && activity.status === 'completed').length, count => count === 2, {label: 'dream card'});
    await assert.rejects(app.submit('/anamnesis nonsense'), /^Error: Usage: \/anamnesis \[recap\|dream\]$/);
    await assert.rejects(app.submit('/anamnesis recap now'), /Usage: \/anamnesis \[recap\|dream\]/);
    assert.equal(surface(app), null);
    await app.close();

    let release!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const slow: Provider = {async respond() {await blocked; return {message: {role: 'assistant', text: 'late'}, stop: 'complete'};}};
    const working = await f.open({provider: slow}, 'busy-cmd');
    await working.submit('slow work');
    await waitForSnapshot(working.store, snapshot => snapshot.activities.some(activity => activity.status === 'running'));
    await assert.rejects(working.submit('/anamnesis recap'), /cannot run while tasks are running/);
    release();
    await waitForSnapshot(working.store, snapshot => snapshot.activities.every(activity => activity.status !== 'running'));
  } finally {await f.close();}
});

test('the page lists six rows whose values follow the state: inherited, bound, unavailable provider, running, switches off', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await speak(app, 'hello');
    await app.submit('/anamnesis');
    const page = picker(app);
    assert.equal(page.title, 'Anamnesis');
    assert.deepEqual(page.items.map(item => item.label), ['Recap now', 'Dream now', 'Memory records', 'Model', 'Recap when idle', 'Dream when idle']);
    assert.deepEqual(rows(app), {'Recap now': 'Write a note on where the work stands', 'Dream now': 'Review the session and update memory', 'Memory records': 'None yet',
      Model: 'Follows Logox (openai / fixture)', 'Recap when idle': 'On · after 5 min', 'Dream when idle': 'On · after 30 min'});
    app.surfaces.cancel();

    await f.memory.save({name: 'prefers-tabs', description: 'The user wants tabs', type: 'feedback', content: 'Tabs.'}, 'project');
    await f.memory.save({name: 'role', description: 'Staff engineer', type: 'user', content: 'Staff.'}, 'user');
    await f.memory.save({name: 'dashboard', description: 'Where the dashboard lives', type: 'reference', content: 'https://example.test'}, 'project');
    await app.anamnesis.setAnamnesisModel({provider: 'openai', model: 'model-a', effort: 'high'});
    await app.anamnesis.setAuto('recap', false);
    await app.submit('/anamnesis');
    assert.equal(rows(app)['Memory records'], '2 in this project · 1 for this user');
    assert.equal(rows(app).Model, 'openai / model-a · high');
    assert.equal(rows(app)['Recap when idle'], 'Off');
    assert.equal(picker(app).items.find(item => item.id === 'model')!.valueTone, undefined);
    app.surfaces.cancel();

    await app.anamnesis.setAnamnesisModel({provider: 'vanished', model: 'gone-1'});
    await app.submit('/anamnesis');
    const unavailable = picker(app).items.find(item => item.id === 'model')!;
    assert.equal(unavailable.description, 'vanished / gone-1 · unavailable');
    assert.equal(unavailable.valueTone, 'warning');
    app.surfaces.cancel();
    await app.anamnesis.setAnamnesisModel(undefined);

    f.control.hold = true;
    // Opening the page is a submit and stops a run, so a run starts while the page is open and the next toggle reads it.
    await app.submit('/anamnesis');
    const run = app.anamnesis.runNow('recap');
    await app.surfaces.choose(picker(app).id, 'auto-dream');
    assert.equal(rows(app)['Recap now'], 'Running…');
    assert.equal(rows(app)['Dream now'], 'Running…');
    // Activating a row while a run is in flight reports the runNow error as a status message and starts nothing.
    await app.surfaces.choose(picker(app).id, 'dream');
    assert.equal(surface(app), null);
    assert.ok(statusTexts(app).some(text => /already running/.test(text)), statusTexts(app).join('|'));
    await waitFor(() => f.seen.filter(isAnamnesis).length, count => count === 1, {label: 'only the one held request'});
    await app.submit('stop');
    assert.equal((await run.done).status, 'aborted');
  } finally {await f.close();}
});

test('rows 1 and 2 start the run and close the page; the idle rows toggle, persist and keep the page open', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await speak(app, 'material');
    await app.submit('/anamnesis');
    await app.surfaces.choose(picker(app).id, 'recap');
    assert.equal(surface(app), null);
    assert.ok(statusTexts(app).includes('Anamnesis is writing a recap.'));
    await waitFor(() => app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis'), card => card?.status === 'completed', {label: 'recap'});
    await app.submit('/anamnesis');
    await app.surfaces.choose(picker(app).id, 'dream');
    assert.ok(statusTexts(app).includes('Anamnesis is reviewing the session.'));
    await waitFor(() => f.seen.filter(isAnamnesis).length, count => count === 2, {label: 'dream request'});

    await app.submit('/anamnesis');
    await app.surfaces.choose(picker(app).id, 'auto-dream');
    assert.equal(picker(app).title, 'Anamnesis', 'the page stays');
    assert.equal(rows(app)['Dream when idle'], 'Off');
    assert.equal(picker(app).focus, 'auto-dream', 'and keeps the row you changed');
    assert.deepEqual(JSON.parse(await readFile(join(f.home, '.logox', 'anamnesis.json'), 'utf8')), {version: 1, dream: false});
    await app.surfaces.choose(picker(app).id, 'auto-recap');
    assert.equal(rows(app)['Recap when idle'], 'Off');
    await app.surfaces.choose(picker(app).id, 'auto-recap');
    assert.equal(rows(app)['Recap when idle'], 'On · after 5 min');
    assert.equal(app.anamnesis.settings().dream, false);
    app.surfaces.cancel();
    assert.equal(surface(app), null);
  } finally {await f.close();}
});

test('the Model row opens the model picker with Follow Logox first; choosing saves or clears the binding and Esc goes back to the page', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await app.submit('/anamnesis');
    await app.surfaces.choose(picker(app).id, 'model');
    const models = picker(app);
    assert.equal(models.title, 'Select Model for Anamnesis');
    assert.equal(models.items[0]!.label, 'Follow Logox (default)');
    assert.equal(models.current, 'inherit');
    const a = models.items.find(item => item.label === 'model-a')!;
    assert.ok(a, models.items.map(item => item.label).join(','));
    await back(app, 'Anamnesis');
    assert.equal(rows(app).Model, 'Follows Logox (openai / fixture)');

    await app.surfaces.choose(picker(app).id, 'model');
    await app.surfaces.choose(picker(app).id, picker(app).items.find(item => item.label === 'model-a')!.id, 'high');
    assert.equal(picker(app).title, 'Anamnesis', 'saving returns to the page');
    assert.deepEqual(app.anamnesis.anamnesisModel(), {provider: 'openai', model: 'model-a', effort: 'high', inherited: false});
    assert.equal(rows(app).Model, 'openai / model-a · high');
    assert.deepEqual(JSON.parse(await readFile(join(f.home, '.logox', 'actor-models.json'), 'utf8')).anamnesis, {provider: 'openai', model: 'model-a', effort: 'high'});
    assert.ok(!app.actors.list().some(actor => actor.id === 'anamnesis'));

    await app.surfaces.choose(picker(app).id, 'model');
    assert.equal(picker(app).current, JSON.stringify({provider: 'openai', model: 'model-a'}), 'the bound model is marked');
    await app.surfaces.choose(picker(app).id, 'inherit');
    assert.equal(app.anamnesis.anamnesisModel().inherited, true);
    assert.equal(rows(app).Model, 'Follows Logox (openai / fixture)');
    app.surfaces.cancel();
    assert.equal(surface(app), null, 'Esc on the page closes');
  } finally {await f.close();}
});

test('the record list shows two-line rows, a record page deletes after confirmation, and every Esc goes back one level', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await app.submit('/anamnesis');
    await app.surfaces.choose(picker(app).id, 'records');
    assert.equal(picker(app).title, 'Memory records');
    assert.deepEqual(picker(app).items, []);
    assert.equal(picker(app).emptyText, 'No records yet. Anamnesis saves them while the session is idle, and you can ask any actor to remember something.');
    await back(app, 'Anamnesis');
    app.surfaces.cancel();

    await f.memory.save({name: 'zeta-note', description: 'A project fact', type: 'project', content: 'Line one.\n\nLine three.'}, 'project');
    await f.memory.save({name: 'prefers-tabs', description: 'The user wants tabs', type: 'feedback', content: 'Tabs.'}, 'project');
    await f.memory.save({name: 'role', description: 'Staff engineer', type: 'user', content: 'Staff.'}, 'user');
    await app.submit('/anamnesis');
    await app.surfaces.choose(picker(app).id, 'records');
    assert.deepEqual(picker(app).items.map(item => [item.id, item.label, item.description, item.detail]), [
      ['project/prefers-tabs', 'prefers-tabs', 'feedback · project', 'The user wants tabs'],
      ['project/zeta-note', 'zeta-note', 'project · project', 'A project fact'],
      ['user/role', 'role', 'user · user', 'Staff engineer']], 'project records first');
    await app.surfaces.choose(picker(app).id, 'project/zeta-note');
    const detail = surface(app)!;
    assert.equal(detail.kind, 'page');
    const tab = (detail as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!;
    assert.deepEqual(tab.actions, [{id: 'delete', label: 'Delete record', key: 'd'}]);
    const text = tab.lines.join('\n');
    assert.match(text, /Description: A project fact/);
    assert.ok(text.includes(join(f.cwd, '.logox', 'memory', 'zeta-note.md')));
    assert.match(text, /Content\nLine one\.\n\nLine three\./);

    await back(app, 'Memory records');
    await app.surfaces.choose(picker(app).id, 'project/zeta-note');
    const id = surface(app)!.id;
    await app.surfaces.triggerTabAction(id, 'record', 'delete');
    assert.equal((surface(app) as Extract<CommandSurface, {kind: 'page'}>).confirm?.prompt, 'Delete project/zeta-note? This removes the file.');
    await app.surfaces.triggerTabAction(id, 'record', 'cancel_confirm');
    assert.equal((surface(app) as Extract<CommandSurface, {kind: 'page'}>).confirm, undefined);
    assert.ok(existsSync(join(f.cwd, '.logox', 'memory', 'zeta-note.md')), 'cancelling deletes nothing');
    await app.surfaces.triggerTabAction(id, 'record', 'delete');
    await app.surfaces.triggerTabAction(id, 'record', 'delete_confirmed');
    assert.ok(!existsSync(join(f.cwd, '.logox', 'memory', 'zeta-note.md')));
    assert.ok(statusTexts(app).includes('Deleted project/zeta-note.'));
    await waitFor(() => surface(app)?.kind === 'picker' && picker(app).title, title => title === 'Memory records', {label: 'back on the list'});
    assert.deepEqual(picker(app).items.map(item => item.id), ['project/prefers-tabs', 'user/role']);
    await back(app, 'Anamnesis');
    assert.equal(rows(app)['Memory records'], '1 in this project · 1 for this user');
    app.surfaces.cancel(); assert.equal(surface(app), null);
  } finally {await f.close();}
});

test('with the real screen every level works with the mouse: click to activate rows, two-line records, footer actions, wheel', async () => {
  const f = await fixture();
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = 100; output.rows = 30;
  let instance!: ReturnType<typeof render>;
  try {
    await f.memory.save({name: 'prefers-tabs', description: 'The user wants tabs', type: 'feedback', content: 'Tabs.'}, 'project');
    await f.memory.save({name: 'role', description: 'Staff engineer', type: 'user', content: 'Staff.'}, 'user');
    const app = await f.open();
    await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} surfaces={app.surfaces}
      onSubmit={app.submit} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
    const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
    const screen = () => output.lines.join('\n');
    const find = (needle: string) => {const y = output.lines.findIndex(line => line.includes(needle)); assert.ok(y >= 0, needle + ' on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(needle)};};
    const click = async (needle: string, dy = 0) => {const {x, y} = find(needle); await send(`\x1b[<0;${x + 1};${y + dy + 1}M`); await send(`\x1b[<0;${x + 1};${y + dy + 1}m`);};
    await act(async () => {await app.submit('/anamnesis');}); await instance.waitUntilRenderFlush();
    assert.match(screen(), /Recap now\s+Write a note on where the work stands/);
    assert.match(screen(), /Memory records\s+1 in this project · 1 for this user/);

    // Level 1: the first click selects the row, the second activates it (as in every picker); the toggle keeps the page.
    await click('Recap when idle');
    assert.match(screen(), /❯ Recap when idle/);
    await click('Recap when idle');
    await waitFor(() => screen(), text => /Recap when idle\s+Off/.test(text), {label: 'toggle through the mouse'});
    assert.equal(app.anamnesis.settings().recap, false);
    // Hover moves nothing but colours; the wheel moves the highlight.
    const rowAt = find('Dream when idle');
    await send(`\x1b[<65;${rowAt.x + 1};${rowAt.y + 1}M`);
    assert.match(screen(), /❯ Dream when idle/, 'the wheel moved the highlight');

    // Level 2: the record list, two lines per record.
    await click('Memory records'); await click('Memory records');
    await waitFor(() => screen(), text => /Memory records/.test(text) && /prefers-tabs\s+feedback · project/.test(text), {label: 'record list'});
    const first = find('prefers-tabs'), second = find('role  ');
    assert.equal(output.lines[first.y + 1]!.trim().replace(/[│]/g, '').trim().startsWith('The user wants tabs'), true, 'description on the second line');
    assert.equal(second.y, first.y + 2, 'two rows per record');
    await send(`\x1b[<65;${first.x + 1};${first.y + 1}M`);
    assert.match(screen(), /❯ role/, 'the wheel moves the highlight over two-line rows');
    await click('The user wants tabs'); await click('The user wants tabs');

    // Level 3: the record page; the footer action asks, a click on Delete record needs the confirmation.
    await waitFor(() => screen(), text => /Delete record/.test(text) && /Staff|The user wants tabs/.test(text), {label: 'record page'});
    await click('d Delete record');
    await waitFor(() => screen(), text => /Delete project\/prefers-tabs\? This removes the file\./.test(text), {label: 'confirmation'});
    await send('n');
    assert.ok(existsSync(join(f.cwd, '.logox', 'memory', 'prefers-tabs.md')));
    await send('d'); await send('y');
    await waitFor(() => !existsSync(join(f.cwd, '.logox', 'memory', 'prefers-tabs.md')), done => done, {label: 'deleted'});
    await waitFor(() => screen(), text => /Memory records/.test(text) && !/prefers-tabs/.test(text), {label: 'back on the list'});
    await send('\x1b'); await waitFor(() => screen(), text => /Recap now/.test(text), {label: 'back on the page'});
    await send('\x1b'); await waitFor(() => screen(), text => !/Recap now/.test(text), {label: 'closed'});
  } finally {
    await act(async () => {instance?.unmount();});
    await instance?.waitUntilExit(); input.destroy(); output.destroy(); await f.close();
  }
});
