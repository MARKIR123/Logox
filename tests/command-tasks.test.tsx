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
import {formatDuration, statusText, workerTranscript} from '../src/commands/tasks-page.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import {projectDelegations, type Delegation} from '../src/runtime/delegations.js';
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

/** One Director round that dispatched Techne (waiting for approval, with a job under it) and Kalon after it. */
async function seed(app: App) {
  const base = {sessionId: app.sessionId, stage: '', detail: ''};
  app.store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Fix the parser', status: 'running', rootActivityId: 'root'});
  app.store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne · Builder', taskTitle: 'Build the parser', status: 'running', stage: 'On stage',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'batch-1', ownedFiles: ['src/parser/**'], acceptance: ['all tests pass']});
  app.store.activities.create({...base, activityId: 'kal', ownerId: 'kalon', kind: 'actor', title: 'Kalon · Aesthete', taskTitle: 'Polish the output', status: 'queued', stage: 'Waiting on Techne',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'batch-1', after: ['tech']});
  const swarm: AutomaSwarm = {name: 'work crew', jobs: [{id: 'T1', name: 'scout', title: 'Find the callers', state: 'done', elapsedMs: 4200, calls: [], route: 'read', model: 'mock/reader', stopReason: 'completed',
    summary: 'three callers', evidence: ['a.ts:1'], notVerified: ['b.ts']}]};
  app.store.message(app.sessionId, 'techne', 'assistant', '', {activityId: 'tech', kind: 'tool', step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm}});
  await app.journal.append({version: 1, sessionId: app.sessionId, activityId: 'tech', ownerId: 'techne', role: 'assistant', text: 'x', message: {role: 'assistant', text: 'x'},
    usage: {input: 10, output: 5, cacheRead: 0, cacheWrite: 0, provider: 'p', model: 'm', cost: 0.0123, currency: 'USD'}});
}

test('the work of a round reads as a graph: phases, steps, tasks, after edges and statuses come from the delegation record (the pure merge is in task-graph.test.ts)', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    app.store.interactions.open({kind: 'permission', sessionId: app.sessionId, activityId: 'tech', ownerId: 'techne', title: 'Write', tool: 'Write', arguments: {}, reason: 'ask'});
    app.store.activities.update(app.sessionId, 'tech', {status: 'waiting_input', stage: 'Awaiting permission'});
    const rows = projectDelegations({snapshot: app.store.getSnapshot(), sessionId: app.sessionId});
    assert.deepEqual(rows.find(row => row.id === 'kal')?.after, ['tech'], 'the full after list is exposed, not only the unfinished part');
    const text = (id: string) => statusText(rows.find(row => row.id === id)!, undefined);
    assert.match(text('tech'), /^waiting_input · awaiting approval \(Write\) · \d+s$/);
    assert.match(text('kal'), /^queued · blocked by techne$/);
    assert.match(text('tech/T1'), /^done · 4s$/);
  } finally {await f.close();}
});

test('a delegation opens its detail: assignment, status, result; Esc closes it', async () => {
  const f = await fixture();
  try {
    const app = await f.open();
    await seed(app);
    app.store.activities.update(app.sessionId, 'tech', {status: 'completed', stage: 'Completed', stopReason: 'completed', title: 'Parser built', summary: {title: 'Parser built', report: 'Built the parser; tests pass.', source: 'model'}});
    app.surfaces.openWorkNode('tech');
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'the detail'});
    let page = surface(app);
    const lines = (page as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!.lines.join('\n');
    assert.match(lines, /Owner: Techne/); assert.match(lines, /Title: Build the parser/); assert.match(lines, /Owns: src\/parser\/\*\*/); assert.match(lines, /all tests pass/);
    assert.match(lines, /Status: completed/); assert.match(lines, /Stop reason: completed/); assert.match(lines, /Cost: \$0\.0123/);
    assert.match(lines, /Summary: Parser built/); assert.match(lines, /Full report: tech/);
    assert.deepEqual((page as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!.actions?.map(action => action.label), ['Open conversation']);
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    // A worker: its own detail, with the result fields and a transcript action.
    app.surfaces.openWorkNode('tech/T1');
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'the worker detail'});
    page = surface(app);
    const job = (page as Extract<CommandSurface, {kind: 'page'}>).tabs[0]!;
    assert.match(job.lines.join('\n'), /Worker: T1 · scout · read route · mock\/reader/);
    assert.match(job.lines.join('\n'), /Summary: three callers/); assert.match(job.lines.join('\n'), /a\.ts:1/); assert.match(job.lines.join('\n'), /b\.ts/);
    assert.deepEqual(job.actions?.map(action => action.label), ['Worker transcript']);
  } finally {await f.close();}
});

test('with no plan the task graph is reachable through /tasks; a double click opens a work node, a click on Open conversation switches to the actor, Esc comes back', {timeout: 30000}, async () => {
  const f = await fixture();
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = 120; output.rows = 32;
  let instance!: ReturnType<typeof render>;
  try {
    const app = await f.open();
    await seed(app);
    await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} plans={app.plans} surfaces={app.surfaces}
      onSubmit={app.submit} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
    const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
    const screen = () => output.lines.join('\n');
    const sidebar = () => output.lines.map(line => line.slice(79)).join('\n');
    const find = (needle: string, x0 = 0) => {const y = output.lines.findLastIndex(line => line.indexOf(needle, x0) >= 0); assert.ok(y >= 0, needle + ' on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(needle, x0)};};
    const click = async (needle: string, x0 = 79) => {const {x, y} = find(needle, x0); await send(`\x1b[<0;${x + 1};${y + 1}M`); await send(`\x1b[<0;${x + 1};${y + 1}m`);};
    /** A click on the title row of a card (the tooltip row repeats the title of the hovered node, so a plain text search would find that). */
    const clickCard = async (title: string) => {
      const pattern = new RegExp('│ \\S ' + title), y = output.lines.findIndex(line => pattern.test(line.slice(79)));
      assert.ok(y >= 0, title + ' card on screen:\n' + screen());
      const x = 79 + output.lines[y]!.slice(79).search(pattern) + 3;
      await send(`\x1b[<0;${x + 1};${y + 1}M`); await send(`\x1b[<0;${x + 1};${y + 1}m`);
    };
    await delay(100);
    assert.ok(!/no plan/.test(screen()), 'a session without a plan does not open the sidebar by itself');
    assert.match(screen(), /▸ Tasks \d+\/\d+/, 'the footer chip offers it');
    await act(async () => {await app.submit('/tasks');}); await instance.waitUntilRenderFlush();
    await waitFor(() => sidebar(), text => /Tasks · no plan/.test(text) && /│ \S Build/.test(text) && /│ \S Polish/.test(text), {label: 'the task graph of the work'});
    assert.match(sidebar(), /│ \S scout · Find/, 'a named worker leads with its name on the task graph');
    assert.doesNotMatch(sidebar(), /\b\d+(\.\d+)+\b/, 'no node id on the sidebar');
    await clickCard('Build'); await clickCard('Build');
    await waitFor(() => screen(), text => /Assignment/.test(text) && /src\/parser/.test(text), {label: 'the delegation detail'});
    assert.match(screen(), /o Open conversation/);
    await send('\x1b');
    await waitFor(() => screen(), text => !/Assignment/.test(text) && /│ \S Polish/.test(sidebar()), {label: 'back on the sidebar'});
    await clickCard('Build'); await clickCard('Build');
    await waitFor(() => screen(), text => /o Open conversation/.test(text), {label: 'the detail page again'});
    await click('o Open conversation', 0);
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
