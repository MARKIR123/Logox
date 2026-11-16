import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type Picker = Extract<CommandSurface, {kind: 'picker'}>;
type Stored = {models: Record<string, {tier?: number; vision?: boolean}>};
/** `haiku` and `opus` map by family (T1, T3); the two `zz-` models are unknown to the model table (T2, can see images). */
const MODELS = ['claude-haiku-4-5', 'claude-opus-4-6', 'zz-fast', 'zz-big'];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-marks-ui-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  await writeFile(join(home, '.logox', 'models-store.json'), JSON.stringify({version: 1, updatedAt: Date.now(),
    models: MODELS.map(id => ({provider: 'openai', id, window: 131072}))}));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'zz-fast', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'ok'}, stop: 'complete'};}};
  const app = await createApplication({cwd, config, provider, sessionId: 'marks-ui', resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = 100; output.rows = 30;
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} surfaces={app.surfaces}
    onSubmit={app.submit} onCancel={() => {}} onClose={async () => {}}/>,
  {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
  const screen = () => output.lines.join('\n');
  /** The terminal repaints a moment after the state changes (more slowly under load), so a screen assertion waits for the paint instead of reading it at once. */
  const seeing = (pattern: RegExp) => waitFor(screen, text => pattern.test(text), {label: 'the screen shows ' + pattern});
  const notSeeing = (pattern: RegExp) => waitFor(screen, text => !pattern.test(text), {label: 'the screen no longer shows ' + pattern});
  const find = (needle: string) => {const y = output.lines.findIndex(line => line.includes(needle)); assert.ok(y >= 0, needle + ' on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(needle)};};
  const click = async (needle: string, dx = 0) => {const {x, y} = find(needle); await send(`\x1b[<0;${x + dx + 1};${y + 1}M`); await send(`\x1b[<0;${x + dx + 1};${y + 1}m`);};
  /** The list row of a model (not the banner or the title, which also name it). */
  const row = (name: string) => {const y = output.lines.findIndex(line => new RegExp('^\\s*(?:❯\\s)?' + name + '\\b').test(line)); assert.ok(y >= 0, name + ' row on screen:\n' + screen()); return {y, x: output.lines[y]!.indexOf(name)};};
  const clickAt = async (x: number, y: number) => {await send(`\x1b[<0;${x + 1};${y + 1}M`); await send(`\x1b[<0;${x + 1};${y + 1}m`);};
  const picker = (): Picker => {const current = app.surfaces.getSnapshot(); assert.equal(current?.kind, 'picker', 'a picker is open'); return current as Picker;};
  const stored = async () => JSON.parse(await readFile(join(home, '.logox', 'model-tiers.json'), 'utf8')) as Stored;
  const open = async (command: string, title: RegExp) => {
    await act(async () => {await app.submit(command);}); await instance.waitUntilRenderFlush();
    await waitFor(() => app.surfaces.getSnapshot()?.kind === 'picker' && picker().status === 'ready' && picker().title, found => title.test(String(found)), {label: command});
  };
  return {app, home, send, screen, seeing, notSeeing, find, click, row, clickAt, picker, stored, open, input, output,
    async close() {await act(async () => {await app.close(); instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy(); await rm(root, {recursive: true, force: true});}};
}

test('/model lists every model with its tier and vision marks, a filter row, and keys that set, toggle and reset them', async () => {
  const f = await fixture();
  try {
    await f.open('/model', /^Select Model for /);
    const rowOf = (name: string) => f.picker().items.find(item => item.label === name)!;
    assert.deepEqual([rowOf('claude-haiku-4-5').marks?.tier, rowOf('claude-opus-4-6').marks?.tier, rowOf('zz-fast').marks?.tier], [1, 3, 2]);
    assert.equal(rowOf('zz-fast').marks?.vision, true, 'a model the table does not know is treated as vision-capable');
    await f.seeing(/\[All\] +T1 +T2 +T3 +T4 +◉ Vision/);
    await f.seeing(/zz-fast.* T2 ◉/);
    await f.seeing(/1–4 tier · v vision · 0 reset · \[ \] filter/);
    assert.match(f.picker().description, /1–4 set tier · v vision · 0 reset · \[ \] filter/);

    // Filter with ] : T1 keeps only the haiku row.
    await f.send(']');
    await f.seeing(/\[T1\]/);
    await f.seeing(/^\s*(?:❯\s)?claude-haiku-4-5/m);
    await f.notSeeing(/^\s*(?:❯\s)?zz-fast/m);
    // 3 sets the highlighted row's tier at once and persists it; the row leaves the T1 filter.
    await f.send('3');
    await waitFor(() => f.stored().catch(() => ({models: {}} as Stored)), file => file.models['openai/claude-haiku-4-5']?.tier === 3, {label: 'tier persisted'});
    // The file is written before the picker re-renders its items; wait for the row, not just the file.
    await waitFor(() => rowOf('claude-haiku-4-5').marks?.tier, tier => tier === 3, {label: 'row shows the new tier'});
    assert.deepEqual(rowOf('claude-haiku-4-5').marks?.derived, {tier: false, vision: true});
    await f.notSeeing(/^\s*(?:❯\s)?claude-haiku-4-5/m);
    // The T3 filter now lists the haiku row beside the opus one; v toggles the highlighted row's vision mark and 0 resets the model.
    await f.send(']'); await f.send(']');
    await f.seeing(/\[T3\]/);
    await f.seeing(/^\s*❯ claude-haiku-4-5/m);
    await f.send('v');
    await waitFor(() => f.stored(), file => file.models['openai/claude-haiku-4-5']?.vision === false, {label: 'vision toggled off'});
    await f.send('0');
    await waitFor(() => f.stored(), file => file.models['openai/claude-haiku-4-5'] === undefined, {label: 'override cleared'});
    await waitFor(() => JSON.stringify(rowOf('claude-haiku-4-5').marks), marks => marks === JSON.stringify({tier: 1, vision: true, derived: {tier: true, vision: true}}), {label: 'row reset'});
  } finally {await f.close();}
});

test('typing a search keeps the plain keys for the text; Alt+key still edits, and the mouse edits through the marks and the filter row', async () => {
  const f = await fixture();
  try {
    await f.open('/model', /^Select Model for /);
    await f.send('zz-b');
    assert.match(f.screen(), /Search: zz-b/, 'a digit or v typed into the search is text');
    await f.send('\x1b4');
    await waitFor(() => f.stored().catch(() => ({models: {}} as Stored)), file => file.models['openai/zz-big']?.tier === 4, {label: 'Alt+4'});
    await f.send('\x1bv');
    await waitFor(() => f.stored(), file => file.models['openai/zz-big']?.vision === false, {label: 'Alt+v'});
    assert.match(f.screen(), /zz-big.* T4 ○/, 'a vision mark the user turned off is shown, in the normal colour');
    // Clear the search (Ctrl+U), then use the mouse: the tier mark cycles, the vision slot toggles, a filter cell filters.
    await f.send('\x15');
    const {x, y} = f.row('zz-fast'), markAt = f.output.lines[y]!.lastIndexOf('T2');
    assert.ok(markAt > x, 'the tier mark is on the row');
    await f.clickAt(markAt, y);
    await waitFor(() => f.stored(), file => file.models['openai/zz-fast']?.tier === 3, {label: 'click cycles the tier'});
    await f.clickAt(markAt + 3, f.row('zz-fast').y);
    await waitFor(() => f.stored(), file => file.models['openai/zz-fast']?.vision === false, {label: 'click toggles vision'});
    await f.click('◉ Vision');
    assert.match(f.screen(), /\[◉ Vision\]/);
    assert.doesNotMatch(f.screen(), /^\s*(?:❯\s)?zz-fast/m, 'models that cannot see images leave the Vision filter');
    assert.match(f.screen(), /^\s*(?:❯\s)?claude-haiku-4-5/m);
    await f.click('All');
    assert.match(f.screen(), /\[All\]/);
  } finally {await f.close();}
});

test('/model automa is a page of three rows; unbound rows show the automatic model and bind nothing; the code and read pickers set and clear their own key; the vision fallback lists vision models', async () => {
  const f = await fixture();
  try {
    await f.open('/model automa', /^Automa$/);
    const page = f.picker();
    assert.deepEqual(page.items.map(item => item.label), ['Read model', 'Code model', 'Vision fallback']);
    assert.match(page.items[0]!.description!, /^auto → openai \/ claude-haiku-4-5 · T1/, 'the cheapest T1 of the session provider');
    assert.match(page.items[1]!.description!, /^auto → openai \/ zz-big · T2 ◉$/, 'the cheapest T2 (unpriced models sort by name)');
    assert.equal(page.items[2]!.description, 'None');
    assert.equal(f.app.tools.modelStorage.get('automa'), undefined);
    assert.equal(f.app.tools.modelStorage.get('automa-read'), undefined);

    await f.app.surfaces.choose(page.id, 'read');
    const readers = f.picker();
    assert.equal(readers.title, 'Select Read Model for Automa');
    assert.equal(readers.items[0]!.id, 'inherit');
    assert.equal(readers.items[0]!.label, 'Auto (cheapest T1)');
    assert.ok(!readers.items.some(item => item.label.includes('recommended')), 'auto replaces the old recommendation');
    await f.app.surfaces.choose(readers.id, readers.items.find(item => item.label === 'zz-big')!.id);
    assert.deepEqual(f.app.tools.modelStorage.get('automa-read'), {provider: 'openai', model: 'zz-big'});
    assert.equal(f.app.tools.modelStorage.get('automa'), undefined, 'the read row never touches the code key');
    await waitFor(() => f.app.surfaces.getSnapshot()?.kind === 'picker' && f.picker().title, title => title === 'Automa', {label: 'back on the page'});
    assert.match(f.picker().items[0]!.description!, /^openai \/ zz-big · T2 ◉$/);
    await f.app.surfaces.choose(f.picker().id, 'read');
    await f.app.surfaces.choose(f.picker().id, 'inherit');
    assert.equal(f.app.tools.modelStorage.get('automa-read'), undefined, 'Auto clears the read model');
    await waitFor(() => f.app.surfaces.getSnapshot()?.kind === 'picker' && f.picker().title, title => title === 'Automa', {label: 'back on the page'});

    await f.app.surfaces.choose(f.picker().id, 'worker');
    const workers = f.picker();
    assert.equal(workers.title, 'Select Code Model for Automa');
    assert.equal(workers.items[0]!.id, 'inherit');
    assert.equal(workers.items[0]!.label, 'Auto (cheapest T2)');
    assert.equal(f.app.tools.modelStorage.get('automa'), undefined, 'opening the picker binds nothing');
    await f.app.surfaces.choose(workers.id, workers.items.find(item => item.label === 'claude-opus-4-6')!.id);
    assert.deepEqual(f.app.tools.modelStorage.get('automa'), {provider: 'openai', model: 'claude-opus-4-6'});
    await waitFor(() => f.app.surfaces.getSnapshot()?.kind === 'picker' && f.picker().title, title => title === 'Automa', {label: 'back on the page'});
    assert.match(f.picker().items[1]!.description!, /^openai \/ claude-opus-4-6 · T3 ◉$/);

    // The code model cannot see images (the user says so) and there is no fallback: the row warns.
    await f.app.tools.marks.setVision('openai', 'claude-opus-4-6', false);
    await f.app.surfaces.choose(f.picker().id, 'worker');
    await f.app.surfaces.choose(f.picker().id, f.picker().items.find(item => item.label === 'claude-opus-4-6')!.id);
    await waitFor(() => f.app.surfaces.getSnapshot()?.kind === 'picker' && f.picker().title, title => title === 'Automa', {label: 'back on the page'});
    assert.match(f.picker().items[1]!.description!, /^openai \/ claude-opus-4-6 · T3$/);
    const blind = f.picker().items[2]!;
    assert.equal(blind.description, 'None · vision jobs will fail');
    assert.equal(blind.valueTone, 'warning');
    await f.app.surfaces.choose(f.picker().id, 'vision');
    const choices = f.picker();
    assert.equal(choices.title, 'Select Vision Fallback for Automa');
    assert.equal(choices.items[0]!.label, 'None');
    assert.ok(choices.items.slice(1).every(item => item.marks?.vision), 'only models that can see images');
    assert.ok(!choices.items.some(item => item.label === 'claude-opus-4-6'));
    await f.app.surfaces.choose(choices.id, choices.items.find(item => item.label === 'zz-big')!.id);
    assert.deepEqual(f.app.tools.modelStorage.get('automa-vision'), {provider: 'openai', model: 'zz-big'});
    await waitFor(() => f.app.surfaces.getSnapshot()?.kind === 'picker' && f.picker().title, title => title === 'Automa', {label: 'back on the page'});
    assert.match(f.picker().items[2]!.description!, /^openai \/ zz-big · T2 ◉$/);
    assert.equal(f.picker().items[2]!.valueTone, undefined);
    await f.app.surfaces.choose(f.picker().id, 'vision');
    await f.app.surfaces.choose(f.picker().id, 'inherit');
    assert.equal(f.app.tools.modelStorage.get('automa-vision'), undefined, 'None clears the fallback');
  } finally {await f.close();}
});

type Resolver = (preferred: string | undefined, vision?: boolean, writes?: boolean) => {model: string; vision?: boolean; route?: string};
const resolverOf = (f: Awaited<ReturnType<typeof fixture>>) => (f.app.tools as unknown as {automa: {resolveModel: Resolver}}).automa.resolveModel;

test('the Automa resolver sends a vision job to the fallback only when the job\'s own model cannot see images', async () => {
  const f = await fixture();
  try {
    await f.app.tools.modelStorage.save('automa', {provider: 'openai', model: 'claude-opus-4-6'});
    await f.app.tools.marks.setVision('openai', 'claude-opus-4-6', false);
    await f.app.tools.modelStorage.save('automa-vision', {provider: 'openai', model: 'zz-big'});
    const resolve = resolverOf(f);
    assert.equal(resolve(undefined, undefined, true).model, 'openai/claude-opus-4-6');
    assert.equal(resolve(undefined, undefined, true).vision, false);
    assert.equal(resolve(undefined, undefined, true).route, 'code');
    assert.equal(resolve(undefined, true, true).model, 'openai/zz-big');
    assert.equal(resolve(undefined, true, true).vision, true);
    assert.equal(resolve(undefined, true, true).route, 'vision');
    await f.app.tools.marks.setVision('openai', 'zz-big', false);
    assert.equal(resolve(undefined, true, true).vision, false, 'a fallback that cannot see either leaves the job to be refused');
    await f.app.tools.modelStorage.save('automa-vision', undefined);
    assert.equal(resolve(undefined, true, true).model, 'openai/claude-opus-4-6');
    await f.app.tools.marks.setVision('openai', 'claude-opus-4-6', true);
    await f.app.tools.modelStorage.save('automa-vision', {provider: 'openai', model: 'zz-big'});
    assert.equal(resolve(undefined, true, true).model, 'openai/claude-opus-4-6', 'a code model that can see images keeps its job');
    assert.equal(resolve(undefined, true, true).route, 'code');
  } finally {await f.close();}
});

test('the Automa resolver routes a job without writes to the read model and a job with writes to the code model, each bound or automatic', async () => {
  const f = await fixture();
  try {
    const resolve = resolverOf(f);
    // Nothing bound: the session model is zz-fast (T2); read takes the cheapest T1, code the cheapest T2 (unpriced models sort by name).
    assert.deepEqual([resolve(undefined).model, resolve(undefined).route], ['openai/claude-haiku-4-5', 'read']);
    assert.deepEqual([resolve(undefined, false, true).model, resolve(undefined, false, true).route], ['openai/zz-big', 'code']);
    // The old `automa` key is the code model and never routes a read job.
    await f.app.tools.modelStorage.save('automa', {provider: 'openai', model: 'claude-opus-4-6'});
    assert.equal(resolve(undefined, false, true).model, 'openai/claude-opus-4-6');
    assert.equal(resolve(undefined).model, 'openai/claude-haiku-4-5');
    await f.app.tools.modelStorage.save('automa-read', {provider: 'openai', model: 'zz-fast'});
    assert.equal(resolve(undefined).model, 'openai/zz-fast');
    assert.equal(resolve(undefined, false, true).model, 'openai/claude-opus-4-6');
    await f.app.tools.modelStorage.save('automa', undefined); await f.app.tools.modelStorage.save('automa-read', undefined);
    // Unbound again: automatic. The nearest-tier fallback is covered by the autoAutomaModel test (automa-tool.test.ts).
    assert.equal(resolve(undefined, false, true).model, 'openai/zz-big');
  } finally {await f.close();}
});

test('/model automa read <model|auto> and /model automa <model|inherit> set and clear their own binding', async () => {
  const f = await fixture();
  try {
    await f.app.submit('/model automa read zz-big');
    assert.deepEqual(f.app.tools.modelStorage.get('automa-read'), {provider: 'openai', model: 'zz-big'});
    assert.equal(f.app.tools.modelStorage.get('automa'), undefined);
    await f.app.submit('/model automa zz-fast');
    assert.deepEqual(f.app.tools.modelStorage.get('automa'), {provider: 'openai', model: 'zz-fast'});
    await f.app.submit('/model automa read auto');
    assert.equal(f.app.tools.modelStorage.get('automa-read'), undefined);
    assert.deepEqual(f.app.tools.modelStorage.get('automa'), {provider: 'openai', model: 'zz-fast'}, 'clearing read leaves the code model');
    await f.app.submit('/model automa inherit');
    assert.equal(f.app.tools.modelStorage.get('automa'), undefined);
  } finally {await f.close();}
});
