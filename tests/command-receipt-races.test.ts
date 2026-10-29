import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {CommandSurfaces, type CommandCompletion} from '../src/commands/surfaces.js';
import type {CommandOrigin, CommandResult} from '../src/runtime/command-surface.js';
import {isTimelineMessage} from '../src/runtime/system-events.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Receipt race did not reach its public boundary.')), 5000);
    })]);
  } finally {if (timer) clearTimeout(timer);}
}
function modelsResponse(): Response {return Response.json({data: [{id: 'first'}, {id: 'late-model'}]});}
function checkResponse(): Response {
  return new Response('data: ' + JSON.stringify({choices: [{delta: {content: 'LOGOX_PROVIDER_READY'}, finish_reason: 'stop'}]}) + '\n\ndata: [DONE]\n\n',
    {headers: {'content-type': 'text/event-stream'}});
}

async function createFixture() {
  let root = await mkdtemp(join(tmpdir(), 'logox-test-command-receipt-races-'));
  try {
    // Canonical paths avoid Windows temporary-directory aliases in production path guards.
    root = await realpath(root);
    await mkdir(join(root, 'project', '.logox'), {recursive: true});
    await mkdir(join(root, 'home', '.logox'), {recursive: true});
    const cwd = await realpath(join(root, 'project')), home = await realpath(join(root, 'home'));
    await writeFile(join(cwd, '.logox', 'config.toml'), [
      '[provider]', 'name="receipt-race"', 'model="first"',
      '[providers.receipt-race]', 'base_url="https://receipt-race.invalid/v1"',
    ].join('\n'));
    await writeFile(join(home, '.logox', 'models-store.json'), JSON.stringify({version: 1, updatedAt: Date.now(),
      models: [{provider: 'receipt-race', id: 'first', window: 131072}]}));
    type Gate = {suffix: string; entered: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>>};
    let gate: Gate | undefined;
    let taskRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      init?.signal?.throwIfAborted();
      assert.ok(url.startsWith('https://receipt-race.invalid/v1/'), 'Every HTTP request stays inside the mock provider.');
      const pending = gate;
      if (pending && url.endsWith(pending.suffix)) {
        gate = undefined;
        pending.entered.resolve();
        return pending.response.promise;
      }
      if (url.endsWith('/models')) return modelsResponse();
      if (url.endsWith('/chat/completions')) return checkResponse();
      throw new Error('Unexpected mocked HTTP endpoint: ' + url);
    };
    const config = await loadConfig(cwd, {}, {}, home, cwd);
    const app = await createApplication({cwd, config, env: {}, resourceOptions: {home, boundary: cwd},
      authPath: join(home, '.logox', 'auth.json'), statusbarPath: join(home, '.logox', 'statusbar.json'), fetcher,
      provider: {async respond() {taskRequests++; throw new Error('Command receipts must not execute a model task.');}}});
    return {root, app, taskRequests: () => taskRequests,
      block(suffix: string) {
        assert.equal(gate, undefined);
        const pending: Gate = {suffix, entered: deferred<void>(), response: deferred<Response>()};
        gate = pending;
        return pending;
      }};
  } catch (error) {await rm(root, {recursive: true, force: true}); throw error;}
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await createFixture();
  try {await run(fixture);}
  finally {try {await fixture.app.close();} finally {await rm(fixture.root, {recursive: true, force: true});}}
}
async function assertDurableOwner(f: Fixture, text: string, presentation: 'panel' | 'silent' | 'timeline') {
  await f.app.persistSession();
  await f.app.close();
  const events = await f.app.journal.systemEvents(f.app.sessionId);
  const receipts = events.filter(event => event.ownerId === 'techne');
  assert.equal(receipts.length, 1, 'Only the final outcome is audited, never Loading or a duplicate late receipt.');
  assert.equal(receipts[0]!.text, text);
  assert.equal(receipts[0]!.presentation, presentation);
  assert.equal(receipts[0]!.sessionId, f.app.sessionId);
  assert.ok(events.every(event => event.text !== 'Loading...'));
  for (const owner of ['logox', 'techne', 'kalon']) assert.deepEqual(await f.app.journal.loadRaw(f.app.sessionId, owner), [],
    'Local commands never append model-ledger entries.');
  assert.equal(f.taskRequests(), 0);
}

for (const command of ['/models', '/check-provider'] as const) {
  for (const failed of [false, true]) {
    test(`${command}: cancelled Loading keeps late ${failed ? 'failure visible' : 'success audited'} under the original Actor without replacing a newer result`, async () => withFixture(async f => {
      const gate = f.block(command === '/models' ? '/models' : '/chat/completions');
      const operation = f.app.submit(command, 'techne').then(() => undefined, (error: unknown) => error);
      try {
        await deadline(gate.entered.promise);
        const loading = f.app.surfaces.getSnapshot();
        assert.ok(loading?.kind === 'result');
        assert.equal(loading.text, 'Loading...');
        assert.equal(loading.ownerId, 'techne');
        assert.equal(loading.sessionId, f.app.sessionId);
        assert.equal(f.app.store.getSnapshot().messages.some(message => message.text === 'Loading...'), false);
        f.app.surfaces.cancel();
        await f.app.submit('/help', 'kalon');
        const help = f.app.surfaces.getSnapshot();
        assert.ok(help?.kind === 'result');
        assert.notEqual(help.id, loading.id);
        assert.equal(help.ownerId, 'kalon');
        if (failed) gate.response.reject(new Error('Synthetic late query failure'));
        else gate.response.resolve(command === '/models' ? modelsResponse() : checkResponse());
        const error = await deadline(operation);
        if (failed) assert.ok(error instanceof Error);
        else assert.equal(error, undefined);
        assert.deepEqual(f.app.surfaces.getSnapshot(), help, 'Late completion never reopens, replaces or edits the newer result.');
        const receipts = f.app.store.getSnapshot().messages.filter(message => message.role === 'system' && message.ownerId === 'techne');
        assert.equal(receipts.length, 1);
        const receipt = receipts[0]!;
        assert.equal(receipt.systemPresentation, failed ? 'timeline' : 'panel');
        assert.equal(receipt.systemEventKind, failed ? 'command_error' : 'command_result');
        assert.equal(isTimelineMessage(receipt), failed);
        if (failed) {
          assert.ok(error instanceof Error);
          assert.equal(receipt.text, error.message, 'The receipt preserves the public formatted diagnostic, not the raw transport exception.');
        } else assert.match(receipt.text, command === '/models' ? /late-model/ : /LOGOX_PROVIDER_READY/);
        await assertDurableOwner(f, receipt.text, failed ? 'timeline' : 'panel');
      } finally {
        // Always release the mocked request before application shutdown, including assertion failures.
        gate.response.resolve(command === '/models' ? modelsResponse() : checkResponse());
        await operation;
      }
    }));
  }
}

for (const failed of [false, true]) {
  test(`dismissed provider action: late ${failed ? 'failure becomes a timeline error' : 'success remains silent'} for its original Actor`, async () => withFixture(async f => {
    await f.app.submit('/providers', 'techne');
    const page = f.app.surfaces.getSnapshot();
    assert.ok(page?.kind === 'page');
    assert.equal(page.ownerId, 'techne');
    const gate = f.block('/chat/completions');
    const operation = f.app.surfaces.triggerTabAction(page.id, 'providers', 'test');
    try {
      await deadline(gate.entered.promise);
      f.app.surfaces.cancel();
      await f.app.submit('/help', 'kalon');
      const help = f.app.surfaces.getSnapshot();
      assert.ok(help?.kind === 'result');
      assert.equal(help.ownerId, 'kalon');
      if (failed) gate.response.reject(new Error('Synthetic late provider action failure'));
      else gate.response.resolve(checkResponse());
      await deadline(operation);
      assert.deepEqual(f.app.surfaces.getSnapshot(), help, 'An old page action never rewrites the current Actor result.');
      const receipts = f.app.store.getSnapshot().messages.filter(message => message.role === 'system' && message.ownerId === 'techne');
      assert.equal(receipts.length, 1);
      const receipt = receipts[0]!;
      assert.equal(receipt.systemEventKind, failed ? 'command_error' : 'command_result');
      assert.equal(receipt.systemPresentation, failed ? 'timeline' : 'silent');
      assert.equal(isTimelineMessage(receipt), failed, 'A dismissed form must not silently swallow its late failure.');
      assert.match(receipt.text, failed ? /connection failed/ : /connected/);
      await assertDurableOwner(f, receipt.text, failed ? 'timeline' : 'silent');
    } finally {gate.response.resolve(checkResponse()); await operation;}
  }));
}

test('a dismissed throwing tab action reports the origin captured when its page opened, not the latest origin provider value', async () => {
  let origin: CommandOrigin = {sessionId: 'session-original', ownerId: 'techne'};
  const completions: {result: CommandResult; completion: CommandCompletion}[] = [];
  const action = deferred<CommandResult>();
  const surfaces = new CommandSurfaces((result, completion) => {completions.push({result, completion});}, () => origin);
  surfaces.openPage('Original page', [{id: 'providers', title: 'Providers', lines: []}], 'providers',
    {onSaveToggles: async () => ({}), onTabAction: () => action.promise});
  const page = surfaces.getSnapshot();
  assert.ok(page?.kind === 'page');
  const operation = surfaces.triggerTabAction(page.id, 'providers', 'test');
  surfaces.cancel();
  origin = {sessionId: 'session-new', ownerId: 'kalon'};
  const replacementId = surfaces.openResult('New Actor result', 'Do not replace this result.');
  action.reject(new Error('Synthetic dismissed form error'));
  await operation;
  assert.equal(surfaces.getSnapshot()?.id, replacementId);
  assert.deepEqual(completions, [{result: {message: 'Synthetic dismissed form error', kind: 'command_error', presentation: 'timeline'},
    completion: {surfaceId: page.id, active: false, ownerId: 'techne', sessionId: 'session-original'}}]);
  surfaces.close();
});
