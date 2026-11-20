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
import {TASKS_EMPTY_TEXT, formatDuration, statusText, workerTranscript} from '../src/commands/tasks-page.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {Delegation} from '../src/runtime/delegations.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type App = Awaited<ReturnType<typeof createApplication>>;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-tasks-cmd-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
  const apps: App[] = [];
  return {root, cwd,
    async open(): Promise<App> {
      const app = await createApplication({cwd, config, provider, sessionId: 'tasks-cmd', resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true});}};
}
const surface = (app: App) => app.surfaces.getSnapshot();
type Picker = Extract<CommandSurface, {kind: 'picker'}>;
const picker = (app: App): Picker => {const current = surface(app); assert.equal(current?.kind, 'picker', 'a picker is open: ' + current?.kind); return current as Picker;};

/** One Director round that dispatched Techne (waiting for approval, with a job under it) and Kalon after it. */
async function seed(app: App) {
  const base = {sessionId: app.sessionId, stage: '', detail: ''};
  app.store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Fix the parser', status: 'running', rootActivityId: 'root'});
  app.store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Build the parser', status: 'running', stage: 'On stage',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'batch-1', ownedFiles: ['src/parser/**'], acceptance: ['all tests pass']});
  app.store.activities.create({...base, activityId: 'kal', ownerId: 'kalon', kind: 'actor', title: 'Kalon · Aesthete', taskTitle: 'Polish the output', status: 'queued', stage: 'Waiting on Techne',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'batch-1', after: ['tech']});
  const swarm: AutomaSwarm = {name: 'work crew', jobs: [{id: 'T1', title: 'Find the callers', state: 'done', elapsedMs: 4200, calls: [], route: 'read', model: 'mock/reader', stopReason: 'completed',
    summary: 'three callers', evidence: ['a.ts:1'], notVerified: ['b.ts']}]};
  app.store.message(app.sessionId, 'techne', 'assistant', '', {activityId: 'tech', kind: 'tool', step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm}});
  await app.journal.append({version: 1, sessionId: app.sessionId, activityId: 'tech', ownerId: 'techne', role: 'assistant', text: 'x', message: {role: 'assistant', text: 'x'},
    usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, provider: 'p', model: 'm', cost: 0.0123, currency: 'USD'}});
}

test('the catalog, /help and completion know /tasks; arguments are a usage error', async () => {
  const entry = commandCatalog.find(command => command.name === 'tasks')!;
  assert.equal(entry.usage, '/tasks');
  assert.ok(commandHelp().includes('/tasks: Delegated work'));
  assert.ok(commandSuggestions({text: '/ta', cursor: 3}, {providers: [], loginProviders: [], models: []}).some(item => item.label === '/tasks'));
  const f = await fixture();
  try {
    const app = await f.open();
    await assert.rejects(app.submit('/tasks now'), /^Error: Usage: \/tasks$/);
    assert.equal(surface(app), null);
  } finally {await f.close();}
});

test('an empty session says nothing was delegated', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await app.submit('/tasks');
    assert.equal(picker(app).title, 'Tasks');
    assert.deepEqual(picker(app).items, []);
    assert.equal(picker(app).emptyText, TASKS_EMPTY_TEXT);
  } finally {await f.close();}
});

test('the list shows one row per delegation: owner, title, status with what it waits on, duration and cost, jobs below their dispatcher', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    app.store.interactions.open({kind: 'permission', sessionId: app.sessionId, activityId: 'tech', ownerId: 'techne', title: 'Write', tool: 'Write', arguments: {}, reason: 'ask'});
    app.store.activities.update(app.sessionId, 'tech', {status: 'waiting_input', stage: 'Awaiting permission'});
    await app.submit('/tasks');
    const rows = picker(app).items.map(item => [item.id, item.label, item.description]);
    assert.deepEqual(rows.map(row => [row[0], row[1]]), [['root', 'Logox · Fix the parser'], ['tech', '  Techne · Build the parser'], ['tech/T1', '    T1 · Find the callers'],
      ['kal', '  Kalon · Polish the output']]);
    const text = (id: string) => rows.find(row => row[0] === id)![2] as string;
    assert.match(text('tech'), /^waiting_input · awaiting approval \(Write\) · \d+s · \$0\.0123$/);
    assert.match(text('kal'), /^queued · blocked by techne$/);
    assert.match(text('tech/T1'), /^done · 4s$/);
    assert.match(text('root'), /^running/);
  } finally {await f.close();}
});

test('Enter opens a row: assignment, status, result; Esc returns to the list on the same row', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    app.store.activities.update(app.sessionId, 'tech', {status: 'completed', stage: 'Completed', stopReason: 'completed', title: 'Parser built', summary: {title: 'Parser built', report: 'Built the parser; tests pass.', source: 'model'}});
    await app.submit('/tasks');
    await app.surfaces.choose(picker(app).id, 'tech');
    let page = surface(app);
    assert.equal(page?.kind, 'page');
    const lines = (page as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!.lines.join('\n');
    assert.match(lines, /Owner: Techne/); assert.match(lines, /Title: Build the parser/); assert.match(lines, /Owns: src\/parser\/\*\*/); assert.match(lines, /all tests pass/);
    assert.match(lines, /Status: completed/); assert.match(lines, /Stop reason: completed/); assert.match(lines, /Cost: \$0\.0123/);
    assert.match(lines, /Summary: Built the parser; tests pass\./); assert.match(lines, /Full report: tech/);
    assert.deepEqual((page as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!.actions?.map(action => action.label), ['Open conversation']);
    app.surfaces.cancel();
    await waitFor(() => surface(app)?.kind === 'picker' && picker(app).focus, focus => focus === 'tech', {label: 'back on the list'});
    // A worker row: its own detail, with the result fields and a transcript action.
    await app.surfaces.choose(picker(app).id, 'tech/T1');
    page = surface(app);
    const job = (page as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!;
    assert.match(job.lines.join('\n'), /Worker: T1 · read route · mock\/reader/);
    assert.match(job.lines.join('\n'), /Summary: three callers/); assert.match(job.lines.join('\n'), /a\.ts:1/); assert.match(job.lines.join('\n'), /b\.ts/);
    assert.deepEqual(job.actions?.map(action => action.label), ['Worker transcript']);
  } finally {await f.close();}
});

test('the mouse selects and opens rows, a click on Open conversation switches to the actor, Esc comes back', {timeout: 30000}, async () => {
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
    // The pane is docked at the bottom, below any timeline card that carries the same words.
    const find = (needle: string) => {const y = output.lines.findLastIndex(line => line.includes(needle)); assert.ok(y >= 0, needle + ' on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(needle)};};
    const click = async (needle: string) => {const {x, y} = find(needle); await send(`\x1b[<0;${x + 1};${y + 1}M`); await send(`\x1b[<0;${x + 1};${y + 1}m`);};
    await act(async () => {await app.submit('/tasks');}); await instance.waitUntilRenderFlush();
    await waitFor(() => screen(), text => /Build the parser/.test(text) && /Polish the output/.test(text), {label: 'the list'});
    // The first click selects the row, the second opens it (as in every list); the wheel moves the highlight.
    await click('Build the parser');
    assert.match(screen(), /❯\s+Techne · Build the parser/);
    const rowAt = find('Polish the output');
    await send(`\x1b[<65;${rowAt.x + 1};${rowAt.y + 1}M`);
    assert.match(screen(), /❯\s+T1 · Find the callers/, 'the wheel moved the highlight');
    await click('Build the parser'); await click('Build the parser');
    await waitFor(() => screen(), text => /Assignment/.test(text) && /src\/parser/.test(text), {label: 'the detail page'});
    assert.match(screen(), /o Open conversation/);
    await send('\x1b');
    await waitFor(() => screen(), text => /Polish the output/.test(text) && !/Assignment/.test(text), {label: 'back on the list'});
    await click('Build the parser'); await click('Build the parser');
    await waitFor(() => screen(), text => /o Open conversation/.test(text), {label: 'the detail page again'});
    await click('o Open conversation');
    await waitFor(() => surface(app), current => current === null, {label: 'the page closed'});
    await waitFor(() => screen(), text => /Techne · Own thread/.test(text), {label: 'the Techne window is shown'});
  } finally {
    try {await act(async () => instance?.unmount());} catch {}
    input.destroy(); output.destroy();
    await f.close();
  }
});

test('helpers: durations, status words and the worker transcript', () => {
  assert.deepEqual([0, 4200, 59_400, 133_000, 3_900_000].map(formatDuration), ['0s', '4s', '59s', '2m 13s', '1h 05m']);
  const node = (extra: Partial<Delegation>): Delegation => ({id: 'x', kind: 'actor', ownerId: 'techne', title: 't', status: 'failed', rootId: 'x', children: [], blockedBy: [], assignment: {title: 't', owns: [], acceptance: []}, ...extra});
  assert.equal(statusText(node({stopReason: 'max_tokens', durationMs: 65_000}), 0.5), 'failed (stop: max_tokens) · 1m 05s · $0.5000');
  assert.equal(statusText(node({status: 'completed', stopReason: 'completed'}), undefined), 'completed');
  assert.equal(statusText(node({status: 'queued', waiting: {kind: 'blocked', text: 'blocked by kalon'}}), undefined), 'queued · blocked by kalon');
  const events = [{parentActivityId: 'a', jobIndex: 0, event: 'start', id: 'T1', brief: 'Look'}, {parentActivityId: 'a', jobIndex: 0, event: 'message', message: {text: 'Reading', toolCalls: [{name: 'Read', arguments: '{"file_path":"a"}'}]}},
    {parentActivityId: 'a', jobIndex: 0, event: 'tool', isError: false, text: 'contents'}, {parentActivityId: 'a', jobIndex: 0, event: 'end', status: 'done'},
    {parentActivityId: 'a', jobIndex: 0, event: 'start', id: 'T2', brief: 'Other'}, {parentActivityId: 'a', jobIndex: 0, event: 'message', message: {text: 'Other work'}}, {parentActivityId: 'b', jobIndex: 0, event: 'message', message: {text: 'Foreign'}}]
    .map(event => JSON.stringify(event)).join('\n');
  assert.deepEqual(workerTranscript(events, 'a', 'T1'), ['Brief: Look', 'Worker: Reading', 'Call: Read {"file_path":"a"}', 'Result: contents', 'Ended: done']);
  assert.deepEqual(workerTranscript(events, 'a', 'T2'), ['Brief: Other', 'Worker: Other work']);
  assert.deepEqual(workerTranscript(events, 'a', 'T9'), []);
});
