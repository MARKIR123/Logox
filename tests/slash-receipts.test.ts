import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {Message} from '../src/runtime/contracts.js';
import type {ModelRequest} from '../src/runtime/messages.js';
import {isTimelineMessage, type SystemEvent} from '../src/runtime/system-events.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {waitForSnapshot} from './runtime-fixture.js';

async function createFixture() {
  let root = await mkdtemp(join(tmpdir(), 'logox-test-slash-receipts-'));
  try {
    // Windows tmpdir may use an 8.3 alias; snapshots require canonical, non-linked paths.
    root = await realpath(root);
    const project = join(root, 'project'), home = join(root, 'home');
    await mkdir(join(project, '.logox'), {recursive: true});
    await mkdir(join(home, '.logox'), {recursive: true});
    const cwd = await realpath(project);
    await writeFile(join(cwd, '.logox', 'config.toml'), [
      '[provider]', 'name="receipt"', 'model="first"',
      '[providers.receipt]', 'base_url="https://receipt.invalid/v1"',
      ...['first', 'second'].flatMap(model => ['[models."receipt/' + model + '"]', 'context_window=131072', 'thinking_protocol="deepseek"']),
    ].join('\n'));
    await writeFile(join(home, '.logox', 'models-store.json'), JSON.stringify({version: 1, updatedAt: Date.now(),
      models: ['first', 'second'].map(id => ({provider: 'receipt', id, window: 131072,
        thinkingLevels: ['auto', 'off', 'low', 'high', 'max']}))}));
    const requests: ModelRequest[] = [], network = {urls: [] as string[], failModels: false};
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      network.urls.push(url);
      init?.signal?.throwIfAborted();
      if (url.endsWith('/models')) {
        if (network.failModels) throw new Error('Synthetic discovery failure');
        return Response.json({data: [{id: 'first'}, {id: 'second'}]});
      }
      if (url.endsWith('/chat/completions')) {
        return new Response('data: ' + JSON.stringify({choices: [{delta: {content: 'LOGOX_PROVIDER_READY'}, finish_reason: 'stop'}]}) + '\n\ndata: [DONE]\n\n',
          {headers: {'content-type': 'text/event-stream'}});
      }
      throw new Error('Unexpected mock network URL: ' + url);
    };
    const config = await loadConfig(cwd, {}, {}, home, cwd);
    const options = {cwd, config, env: {}, resourceOptions: {home, boundary: cwd},
      authPath: join(home, '.logox', 'auth.json'), statusbarPath: join(home, '.logox', 'statusbar.json'), fetcher,
      provider: {async respond(request: ModelRequest) {
        requests.push(request);
        assert.ok(request.tools.some(tool => tool.name === '_FinishRound'), 'Use the real production finalizer contract.');
        return {message: {role: 'assistant' as const, text: 'Task complete',
          toolCalls: [{id: 'receipt-finish-' + requests.length, name: '_FinishRound',
            arguments: JSON.stringify({title: 'Receipt fixture complete', verification: null, carry_forward: []})}]}, stop: 'tools' as const};
      }}};
    const app = await createApplication(options);
    return {root, cwd, home, app, options, requests, network};
  } catch (error) {await rm(root, {recursive: true, force: true}); throw error;}
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try {await run(fixture);}
  finally {try {await fixture.app.close();} finally {await rm(fixture.root, {recursive: true, force: true});}}
}
function waitUntil<T>(source: {getSnapshot(): T; subscribe(listener: () => void): () => void}, predicate: (state: T) => boolean): Promise<void> {
  if (predicate(source.getSnapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {stop(); reject(new Error('Public state did not reach the expected receipt test boundary.'));}, 5000);
    const stop = source.subscribe(() => {
      if (predicate(source.getSnapshot())) {clearTimeout(timeout); stop(); resolve();}
    });
  });
}
function systemMessages(f: Fixture): readonly Message[] {return f.app.store.getSnapshot().messages.filter(message => message.role === 'system');}
function lastReceipt(f: Fixture): Message {
  const message = systemMessages(f).filter(item => item.systemPresentation !== 'welcome').at(-1);
  assert.ok(message, 'Expected a business receipt.');
  return message;
}
function assertEmptyTimeline(f: Fixture): void {
  assert.deepEqual(f.app.store.getSnapshot().messages.filter(isTimelineMessage), []);
  assert.deepEqual(buildStageRows(f.app.store.getSnapshot(), f.app.sessionId, 'logox', 80, {}, null), []);
}
async function readyPicker(f: Fixture) {
  await waitUntil(f.app.surfaces, state => state?.kind === 'picker' && state.status === 'ready');
  const picker = f.app.surfaces.getSnapshot();
  assert.ok(picker?.kind === 'picker');
  assert.equal(picker.error, '');
  return picker;
}
async function answerWizard(f: Fixture, question: string, selected: readonly string[], custom?: string): Promise<void> {
  await waitUntil(f.app.authentication, state => state?.phase === 'wizard' && state.wizard?.questions[state.wizard.index]?.question === question);
  f.app.authentication.answerWizard({selected, ...(custom !== undefined ? {custom} : {})});
}

test('direct and picker model/effort changes update real status and actor/tool bindings with silent durable receipts', async () => withFixture(async f => {
  assert.equal(f.app.status('logox').model?.model, 'first');
  await f.app.submit('/model receipt/second');
  assert.deepEqual(f.app.status('logox').model, {provider: 'receipt', model: 'second'});
  await f.app.submit('/effort high');
  assert.equal(f.app.status('logox').effort, 'high');
  await f.app.submit('/model');
  let picker = await readyPicker(f);
  const first = picker.items.find(item => item.label === 'first' && item.group === 'receipt');
  assert.ok(first);
  await f.app.surfaces.choose(picker.id, first.id, 'low');
  assert.equal(f.app.surfaces.getSnapshot(), null);
  assert.equal(f.app.status('logox').model?.model, 'first');
  assert.equal(f.app.status('logox').effort, 'low');
  await f.app.submit('/effort');
  picker = await readyPicker(f);
  assert.ok(picker.items.some(item => item.id === 'max'));
  await f.app.surfaces.choose(picker.id, 'max');
  assert.equal(f.app.status('logox').effort, 'max');
  await f.app.submit('/model techne receipt/second');
  assert.deepEqual(f.app.actors.modelStorage.get('techne'), {provider: 'receipt', model: 'second'});
  assert.equal(f.app.status('techne').model?.model, 'second');
  await f.app.submit('/model techne');
  picker = await readyPicker(f);
  const actorChoice = picker.items.find(item => item.label === 'first' && item.group === 'receipt');
  assert.ok(actorChoice);
  await f.app.surfaces.choose(picker.id, actorChoice.id);
  assert.equal(f.app.status('techne').model?.model, 'first');
  await f.app.submit('/model automa receipt/second');
  assert.deepEqual(f.app.tools.modelStorage.get('automa'), {provider: 'receipt', model: 'second'});
  await f.app.submit('/model automa');
  picker = await readyPicker(f);
  const automaChoice = picker.items.find(item => item.label === 'first' && item.group === 'receipt');
  assert.ok(automaChoice);
  await f.app.surfaces.choose(picker.id, automaChoice.id);
  assert.deepEqual(f.app.tools.modelStorage.get('automa'), {provider: 'receipt', model: 'first'});
  await f.app.submit('/model automa');
  picker = await readyPicker(f);
  await f.app.surfaces.choose(picker.id, 'inherit');
  assert.equal(f.app.tools.modelStorage.get('automa'), undefined);
  const receipts = systemMessages(f).filter(message => message.systemPresentation !== 'welcome');
  assert.equal(receipts.length, 9);
  assert.ok(receipts.every(message => message.systemPresentation === 'silent' && message.systemReplay === false));
  assertEmptyTimeline(f);
  assert.equal(f.requests.length, 0);
  assert.equal(f.app.isSessionPersistent(), false);
  await f.app.persistSession();
  await f.app.close();
  const events = await f.app.journal.systemEvents(f.app.sessionId);
  assert.deepEqual(events.map(event => event.id), receipts.map(message => message.id));
  assert.ok(events.every(event => event.presentation === 'silent'));
  assert.deepEqual(await f.app.journal.loadRaw(f.app.sessionId, 'logox'), []);
}));

test('repeated picker and login cancellation preserves status, performs no model request, and never adds timeline receipts', async () => withFixture(async f => {
  const before = f.app.status('logox');
  for (const command of ['/model', '/effort', '/model', '/effort']) {
    await f.app.submit(command);
    await readyPicker(f);
    f.app.surfaces.cancel();
    f.app.surfaces.cancel();
    assert.equal(f.app.surfaces.getSnapshot(), null);
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    const login = f.app.submit('/login');
    await waitUntil(f.app.authentication, state => state?.phase === 'wizard');
    f.app.authentication.cancel();
    f.app.authentication.cancel();
    await login;
    assert.equal(f.app.authentication.getSnapshot(), null);
    assert.equal(lastReceipt(f).systemPresentation, 'silent');
  }
  await f.app.submit('/login receipt');
  assert.equal(f.app.authentication.getSnapshot()?.phase, 'key');
  f.app.authentication.cancel();
  f.app.authentication.cancel();
  assert.deepEqual(f.app.status('logox').model, before.model);
  assert.equal(f.app.status('logox').effort, before.effort);
  assertEmptyTimeline(f);
  assert.equal(f.requests.length, 0);
  await f.app.persistSession();
  await f.app.close();
  const events = await f.app.journal.systemEvents(f.app.sessionId);
  assert.equal(events.length, 2, 'Wizard cancellations may be durable, without replaying a visible acknowledgment.');
  assert.ok(events.every(event => event.presentation === 'silent'));
}));

test('settings saves and clear use short status receipts while welcome is never persisted', async () => withFixture(async f => {
  const welcome = systemMessages(f);
  assert.equal(welcome.length, 1);
  assert.equal(welcome[0]!.systemPresentation, 'welcome');
  assert.equal(welcome[0]!.systemReplay, false);
  assert.deepEqual(await f.app.journal.systemEvents(f.app.sessionId), []);
  await f.app.submit('/settings');
  const page = f.app.surfaces.getSnapshot();
  assert.ok(page?.kind === 'page');
  const tab = page.tabs.find(item => item.id === 'settings');
  assert.ok(tab?.toggles);
  await f.app.surfaces.saveToggles(page.id, 'settings', tab.toggles.map(item => item.id === 'motion' ? {...item, enabled: false} : item));
  assert.equal(f.app.surfaces.getSnapshot()?.id, page.id, 'Applying a settings tab keeps other drafts open');
  f.app.surfaces.cancel();
  const saved = lastReceipt(f);
  assert.equal(saved.systemPresentation, 'status');
  assert.equal(saved.text, 'Settings saved.');
  assert.equal(f.app.statusbar.getSnapshot().motion, false);
  assertEmptyTimeline(f);
  await f.app.persistSession();
  await f.app.submit('/clear');
  const cleared = lastReceipt(f);
  assert.equal(cleared.systemPresentation, 'status');
  assert.equal(f.app.store.getSnapshot().messages.length, 1);
  assertEmptyTimeline(f);
  await f.app.close();
  const events = await f.app.journal.systemEvents(f.app.sessionId);
  assert.ok(events.some(event => event.id === saved.id && event.presentation === 'status'), 'Clear never deletes durable settings receipts.');
  assert.ok(events.some(event => event.id === cleared.id && event.presentation === 'status'));
  assert.ok(events.every(event => event.presentation !== 'welcome'));
  assert.deepEqual(await f.app.journal.loadRaw(f.app.sessionId, 'logox'), []);
  assert.equal(f.requests.length, 0);
}));

test('long command queries open matching read-only result surfaces and cancellation never runs the task provider', async () => withFixture(async f => {
  const panelIds: string[] = [];
  for (const [command, title, expected] of [
    ['/skills', 'Skills', /skill|No skills/i],
    ['/models', 'Available models', /first\nsecond/],
    ['/help', 'Help & Commands', /\/help/],
    ['/commands', 'Help & Commands', /\/model/],
    ['/check-provider', 'Provider check', /LOGOX_PROVIDER_READY/],
    ['/providers check', 'Provider check', /LOGOX_PROVIDER_READY/],
    ['/reload', 'Resource reload', /reload|resource/i],
  ] as const) {
    await f.app.submit(command);
    const result = f.app.surfaces.getSnapshot();
    assert.ok(result?.kind === 'result', command + ' must open a read-only result surface.');
    assert.equal(result.title, title);
    assert.match(result.text, expected);
    const receipt = lastReceipt(f);
    assert.equal(receipt.systemPresentation, 'panel');
    assert.equal(receipt.systemTitle, result.title);
    assert.equal(receipt.text, result.text, 'The public result body is the complete persisted, copyable source text.');
    assert.ok(!result.text.includes('\x1b]52;'), 'A result is data, never an executable clipboard sequence.');
    panelIds.push(receipt.id);
    f.app.surfaces.cancel();
    f.app.surfaces.cancel();
    assert.equal(f.app.surfaces.getSnapshot(), null);
    assertEmptyTimeline(f);
    assert.equal(f.requests.length, 0, 'Closing a query result never executes a model task.');
  }
  assert.equal(f.network.urls.filter(url => url.endsWith('/chat/completions')).length, 2, 'Only explicit provider checks use the mocked HTTP endpoint.');
  await f.app.persistSession();
  await f.app.close();
  const events = await f.app.journal.systemEvents(f.app.sessionId);
  assert.deepEqual(events.filter(event => event.presentation === 'panel').map(event => event.id), panelIds);
  assert.deepEqual(await f.app.journal.loadRaw(f.app.sessionId, 'logox'), []);
}));

test('undo with real snapshot changes opens a result panel without changing model history; empty undo stays silent', async () => withFixture(async f => {
  await f.app.submit('Create an isolated task boundary');
  await waitForSnapshot(f.app.store, snapshot => snapshot.activities.at(-1)?.status === 'completed');
  const activity = f.app.store.getSnapshot().activities.at(-1)!;
  const path = join(f.cwd, 'receipt-file.txt');
  await writeFile(path, 'before');
  await f.app.tools.snapshots.apply(path, Buffer.from('before'), Buffer.from('after'), activity.activityId, new AbortController().signal);
  const rawBefore = await f.app.journal.loadRaw(f.app.sessionId, 'logox');
  await f.app.submit('/undo');
  assert.equal(await readFile(path, 'utf8'), 'before');
  const result = f.app.surfaces.getSnapshot();
  assert.ok(result?.kind === 'result');
  assert.equal(result.title, 'File undo');
  assert.ok(result.text.includes(path));
  assert.equal(lastReceipt(f).systemPresentation, 'panel');
  assert.equal(lastReceipt(f).text, result.text);
  f.app.surfaces.cancel();
  await f.app.submit('/undo');
  assert.equal(f.app.surfaces.getSnapshot(), null);
  assert.equal(lastReceipt(f).systemPresentation, 'silent');
  assert.deepEqual(await f.app.journal.loadRaw(f.app.sessionId, 'logox'), rawBefore);
  assert.equal(f.requests.length, 1);
}));

test('local save and login errors remain in their owning form and retain only silent system metadata', async () => withFixture(async f => {
  await f.app.submit('/statusbar');
  const page = f.app.surfaces.getSnapshot();
  assert.ok(page?.kind === 'page');
  const tab = page.tabs.find(item => item.id === 'statusbar');
  assert.ok(tab?.toggles);
  await mkdir(f.options.statusbarPath);
  await f.app.surfaces.saveToggles(page.id, 'statusbar', tab.toggles);
  const failed = f.app.surfaces.getSnapshot();
  assert.ok(failed?.kind === 'page' && failed.error);
  assert.equal(failed.id, page.id);
  assert.equal(lastReceipt(f).text, failed.error);
  assert.equal(lastReceipt(f).systemEventKind, 'command_error');
  assert.equal(lastReceipt(f).systemPresentation, 'silent');
  f.app.surfaces.cancel();
  await rm(f.options.statusbarPath, {recursive: true});
  await f.app.submit('/login receipt');
  await f.app.authentication.submit('');
  const login = f.app.authentication.getSnapshot();
  assert.ok(login?.phase === 'key' && login.error);
  assert.equal(lastReceipt(f).text, login.error);
  assert.equal(lastReceipt(f).systemEventKind, 'command_error');
  assert.equal(lastReceipt(f).systemPresentation, 'silent');
  f.app.authentication.cancel();
  assertEmptyTimeline(f);
  assert.equal(f.requests.length, 0);
  await f.app.persistSession();
  await f.app.close();
  const errors = (await f.app.journal.systemEvents(f.app.sessionId)).filter(event => event.kind === 'command_error');
  assert.equal(errors.length, 2);
  assert.ok(errors.every(event => event.presentation === 'silent'));
}));

test('wizard notification severity is explicit: recoverable discovery failure is status but fatal duplicate route is timeline', async () => withFixture(async f => {
  f.network.failModels = true;
  const discovery = f.app.submit('/login');
  await answerWizard(f, 'Manage providers', ['add']);
  await answerWizard(f, 'Choose a provider source', ['url']);
  await answerWizard(f, 'Enter a route name', [], 'new-receipt');
  await answerWizard(f, 'Enter the API key', [], '');
  await answerWizard(f, 'Enter the base URL or port', [], 'https://new-receipt.invalid/v1');
  await answerWizard(f, 'Choose the wire protocol', ['completions']);
  await waitUntil(f.app.authentication, state => state?.wizard?.questions[state.wizard.index]?.question === 'Select the models to enable');
  assert.equal(lastReceipt(f).systemPresentation, 'status');
  assert.equal(lastReceipt(f).systemEventKind, 'command_result');
  assert.match(lastReceipt(f).text, /discovery failed/i, 'Failure wording does not override an informational notification level.');
  f.app.authentication.cancel();
  await discovery;
  f.network.failModels = false;
  const duplicate = f.app.submit('/login');
  await answerWizard(f, 'Manage providers', ['add']);
  await answerWizard(f, 'Choose a provider source', ['url']);
  await answerWizard(f, 'Enter a route name', [], 'receipt');
  await duplicate;
  const fatal = lastReceipt(f);
  assert.equal(fatal.systemEventKind, 'command_error');
  assert.equal(fatal.systemPresentation, 'timeline');
  assert.ok(isTimelineMessage(fatal));
  assert.equal(f.app.authentication.getSnapshot(), null);
  assert.equal(f.app.surfaces.getSnapshot(), null);
  assert.equal(f.requests.length, 0);
}));

test('unknown commands throw with explicit timeline errors, old events survive, and replay never reopens results or enters model history', async () => withFixture(async f => {
  const legacy: SystemEvent = {version: 1, id: randomUUID(), sessionId: f.app.sessionId, ownerId: 'logox', time: 1,
    kind: 'command_result', text: 'Legacy model-switch receipt without presentation'};
  await f.app.persistSession();
  await f.app.journal.appendSystem(legacy);
  const id = f.app.sessionId;
  await f.app.close();
  f.app = await createApplication({...f.options, sessionId: id});
  const oldMessage = f.app.store.getSnapshot().messages.find(message => message.id === legacy.id)!;
  assert.equal(oldMessage.systemReplay, true);
  assert.equal(Object.hasOwn(oldMessage, 'systemPresentation'), false);
  assert.equal(isTimelineMessage(oldMessage), true);
  await assert.rejects(f.app.submit('/unknown-receipt-command'), /Unknown command/);
  const error = lastReceipt(f);
  assert.equal(error.systemEventKind, 'command_error');
  assert.equal(error.systemPresentation, 'timeline');
  assert.equal(error.systemReplay, false);
  assert.equal(isTimelineMessage(error), true);
  await f.app.submit('/help');
  assert.equal(lastReceipt(f).systemPresentation, 'panel');
  f.app.surfaces.cancel();
  await f.app.submit('/model receipt/second');
  assert.equal(lastReceipt(f).systemPresentation, 'silent');
  await f.app.submit('Use only this real user task as model input');
  await waitForSnapshot(f.app.store, snapshot => snapshot.activities.at(-1)?.status === 'completed');
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0]!.messages.every(message => !message.text.includes(legacy.text) && !message.text.includes(error.text)));
  const raw = await f.app.journal.loadRaw(id, 'logox');
  assert.ok(raw.length > 0);
  assert.ok(raw.every(entry => !entry.text.includes(legacy.text) && !entry.text.includes(error.text)));
  await f.app.close();
  const before = await f.app.journal.systemEvents(id);
  assert.deepEqual(before.find(event => event.id === legacy.id), legacy, 'New receipts do not fill or rewrite old metadata.');
  f.app = await createApplication({...f.options, sessionId: id});
  assert.equal(f.app.surfaces.getSnapshot(), null, 'Restoring a panel event never reopens its result surface.');
  assert.deepEqual(await f.app.journal.systemEvents(id), before);
  const replayed = f.app.store.getSnapshot().messages.filter(message => before.some(event => event.id === message.id));
  assert.equal(replayed.length, before.length);
  assert.ok(replayed.every(message => message.systemReplay === true));
  assert.equal(replayed.filter(message => message.id === error.id).length, 1);
  assert.equal(f.requests.length, 1, 'Restore never re-executes tasks.');
}));
