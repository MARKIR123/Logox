import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {OUTAGE_DELAYS_MS, OutageBackoff} from '../src/actors/outage.js';
import {createProvider, formatFailureDetail, isProviderInterruption, isProviderOutage, providerFailure, ProviderError, publicSnippet} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {isOutageWake} from '../src/runtime/outage.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {DIRECTOR_RECOVERY_EXHAUSTED, DIRECTOR_RECOVERY_LIFTED} from '../src/prompts/runtime/director.js';
import {waitFor} from './wait-for.js';

const outage = (context = {provider: 'antigravity', model: 'gemini-3.8-flash-high', attempts: 4}) => {
  const error = providerFailure(503, {error: {message: 'upstream overloaded, key sk-abcdef1234567890abcdef'}}, undefined, {requestId: 'req_42'});
  error.context = context;
  return error;
};

test('provider failures keep a sanitized diagnostic: status, request id and a bounded body excerpt', async () => {
  const error = outage();
  assert.equal(error.message, 'Model service temporarily unavailable');
  assert.equal(error.diagnostic?.status, 503); assert.equal(error.diagnostic?.requestId, 'req_42');
  assert.match(error.diagnostic?.snippet ?? '', /upstream overloaded/);
  assert.ok(!error.diagnostic?.snippet?.includes('sk-abcdef'), 'keys are stripped from the excerpt');
  assert.equal(providerFailure(502, undefined, undefined, {body: '<html><body>Bad gateway ' + 'x '.repeat(600) + '</body></html>'}).diagnostic?.snippet?.length, 500);
  const redacted = publicSnippet('Authorization: Bearer abc.def.ghi-123456 token=hunter2hunter2 api_key: "k-12345678"') ?? '';
  assert.ok(!/abc\.def|hunter2|k-12345678/.test(redacted), redacted);
  assert.deepEqual(formatFailureDetail(error).split('\n'), ['Model service temporarily unavailable',
    'antigravity · gemini-3.8-flash-high · HTTP 503 · request req_42 · 4 attempts', 'upstream overloaded, key [redacted]']);
  assert.equal(formatFailureDetail(new Error('plain')), 'plain');
  // End to end through the HTTP transport: headers and a non-JSON body survive.
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://example.invalid', model: 'm', key: '', temperature: 0, maxTokens: 10, timeoutMs: 1000},
    async () => new Response('Service Unavailable from gateway', {status: 503, headers: {'x-request-id': 'req_header'}}));
  await assert.rejects(provider.respond({system: 'test', messages: [{role: 'user', text: 'hi'}], tools: []}, () => {}, new AbortController().signal), (caught: unknown) =>
    caught instanceof ProviderError && caught.diagnostic?.status === 503 && caught.diagnostic.requestId === 'req_header' && caught.diagnostic.snippet === 'Service Unavailable from gateway');
});

test('temporary provider errors are outages; authentication, quota and missing models are not', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) assert.equal(isProviderOutage(providerFailure(status)), true, String(status));
  for (const status of [401, 402, 403]) assert.equal(isProviderOutage(providerFailure(status)), false, String(status));
  assert.equal(isProviderOutage(providerFailure(404, {error: {code: 'model_not_found'}})), false);
  assert.equal(isProviderOutage(new Error('x')), false);
  assert.equal(isProviderInterruption(providerFailure(503)), false, 'HTTP status failures keep their own in-loop retry path');
});

test('failure cards show the diagnostic lines when expanded and never repeat the title; outage wakes get no card', () => {
  const store = new RuntimeStore();
  const detail = 'Model service temporarily unavailable\nantigravity · gemini · HTTP 503 · 4 attempts\nupstream overloaded';
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'aletheia', kind: 'actor', title: 'Check', status: 'failed', stage: 'Failed', detail});
  store.activities.create({sessionId: 's', activityId: 'w', ownerId: 'logox', kind: 'director', title: 'Wake', status: 'failed', stage: 'Failed', detail,
    coordinationWake: true, recovery: {key: 'provider:temporary:request', attempt: 1}});
  store.message('s', 'aletheia', 'user', 'Check the build', {activityId: 'a', inputKind: 'director'});
  store.message('s', 'logox', 'user', 'Process pending events', {activityId: 'w', inputKind: 'actor'});
  const text = (open: boolean) => buildStageRows(store.getSnapshot(), 's', 'logox', 99, {a: open, w: open}, null).map(row => row.text).join('\n');
  const closed = text(false), expanded = text(true);
  assert.equal(closed.split('Model service temporarily unavailable').length - 1, 1, 'one card only; the wake is hidden');
  assert.ok(!closed.includes('HTTP 503'));
  assert.equal(expanded.split('Model service temporarily unavailable').length - 1, 1, 'the title is not repeated as body');
  assert.match(expanded, /antigravity · gemini · HTTP 503 · 4 attempts/); assert.match(expanded, /upstream overloaded/);
  assert.equal(isOutageWake(store.getSnapshot().activities.find(item => item.activityId === 'w')!), true);
});

test('OutageBackoff waits 30 s, 2 min, then 5 min repeatedly, and reset or close drop the timer', () => {
  mock.timers.enable({apis: ['setTimeout']});
  try {
    const fired: number[] = [], lines: string[] = [];
    let now = 0;
    const backoff = new OutageBackoff(() => fired.push(now), (text, first) => lines.push((first ? '1:' : '') + text));
    assert.deepEqual(OUTAGE_DELAYS_MS, [30_000, 120_000, 300_000]);
    for (const wait of [30_000, 120_000, 300_000, 300_000]) {
      backoff.arm('antigravity'); assert.equal(backoff.waiting, true);
      backoff.arm('antigravity'); // a second failure during the wait never stacks or escalates
      mock.timers.tick(wait - 1); assert.equal(backoff.waiting, true);
      now += wait; mock.timers.tick(1); assert.equal(backoff.waiting, false);
    }
    assert.deepEqual(fired, [30_000, 150_000, 450_000, 750_000]);
    assert.deepEqual(lines, ['1:[Network] Waiting for antigravity · retry in 30s', '[Network] Waiting for antigravity · retry in 2m',
      '[Network] Waiting for antigravity · retry in 5m', '[Network] Waiting for antigravity · retry in 5m']);
    backoff.reset(); backoff.arm('p'); mock.timers.tick(30_000); assert.equal(fired.length, 5, 'reset restarts the schedule at 30 s');
    backoff.arm('p'); backoff.close(); mock.timers.tick(600_000); assert.equal(fired.length, 5, 'close drops the timer');
  } finally {mock.timers.reset();}
});

function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
async function fixture(execute: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>, delays: readonly number[] = [40]) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-outage-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore(), deliveries = new DeliveryQueue('s', journal);
  const notices: Array<{text: string; first: boolean}> = [];
  let services!: ActorServices;
  const ensemble = new DynamicEnsemble('s', store, journal, async (prompt, context) => {
    services.definition(context);
    const incoming = await context.drainInbox?.() ?? [];
    await execute(context.coordinationWake && incoming.length ? incoming.map(message => message.text).join('\n') : prompt, context, services);
  }, {concurrency: 'actor', deliveries, member: owner => catalog.find(owner), handoff: result => services.handoff(result),
    settled: (activity, status) => services.settled(activity, status)});
  services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), getSnapshot: () => store.getSnapshot(),
    getActiveTask: owner => ensemble.getActiveTask(owner), canReceiveMessage: owner => ensemble.canReceiveMessage(owner),
    requireIdle() {}, approve: async () => false, enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: id => ensemble.pauseBatch(id), resumeBatch: id => ensemble.resumeBatch(id), coordinationPath: join(directory, 'coordination.json'),
    outageDelaysMs: delays, outageNotice: (text, first) => notices.push({text, first})});
  await services.recover();
  return {ensemble, services, deliveries, journal, store, notices, async close() {services.close(); await ensemble.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}};
}
const directorRuns = (f: Awaited<ReturnType<typeof fixture>>) => f.store.activities.list().filter(item => item.ownerId === 'logox');

test('an outage failure carries resume advice and diagnostics, and the Director is woken only after the backoff', {timeout: 8000}, async () => {
  const prompts: string[] = [];
  const f = await fixture(async (prompt, context) => {
    if (context.ownerId === 'aletheia') throw outage();
    prompts.push(prompt); context.say('Director review.');
  }, [150]);
  try {
    const task = f.ensemble.dispatch('aletheia', 'Verify the build', 'logox', {inputKind: 'director'});
    await task.done;
    await waitFor(() => f.services.deliveries.snapshot().length, count => count === 1);
    const delivery = f.services.deliveries.snapshot()[0]!;
    assert.match(delivery.text, /Prefer resuming the original Actor activity with resumeTask: /);
    assert.match(delivery.text, /antigravity · gemini-3.8-flash-high · HTTP 503 · request req_42 · 4 attempts/);
    assert.equal(f.services.outageWaiting, true);
    assert.equal(directorRuns(f).length, 0, 'no immediate wake on the dead provider');
    assert.equal(f.notices.length, 1); assert.equal(f.notices[0]!.first, true);
    assert.match(f.notices[0]!.text, /^\[Network\] Waiting for antigravity · retry in \d+s$/);
    await waitFor(() => prompts.length, count => count === 1);
    assert.match(prompts[0]!, /Prefer resuming/);
    assert.equal(directorRuns(f).length, 1);
  } finally {await f.close();}
});

test('a Director wake that meets the outage re-arms the backoff without a new failure or recovery budget', {timeout: 8000}, async () => {
  let wakes = 0; const attempts: Array<number | undefined> = [];
  const f = await fixture(async (_prompt, context) => {
    if (context.ownerId === 'aletheia') throw outage();
    attempts.push(context.recovery?.attempt);
    if (++wakes < 3) throw outage();
    context.say('Recovered.');
  });
  try {
    await f.ensemble.dispatch('aletheia', 'Verify', 'logox', {inputKind: 'director'}).done;
    await waitFor(() => wakes, count => count >= 3);
    await waitFor(() => directorRuns(f).at(-1)?.status, status => status === 'completed');
    assert.deepEqual(attempts, [1, 1, 1], 'failed wakes never advance the budget');
    assert.equal(f.services.deliveries.snapshot().filter(item => item.kind === 'failure').length, 1, 'no new failure delivery per failed wake');
    const wakeCards = directorRuns(f).filter(item => item.status === 'failed');
    assert.equal(wakeCards.length, 2); assert.ok(wakeCards.every(item => isOutageWake(item)));
    assert.equal(f.notices.length, 3); assert.ok(f.notices.slice(1).every(item => !item.first));
    assert.equal(f.services.outageWaiting, false, 'a successful wake ends the outage');
  } finally {await f.close();}
});

test('human input ends the outage wait immediately and takes the exhausted-recovery restriction with it', {timeout: 8000}, async () => {
  const f = await fixture(async (_prompt, context) => {if (context.ownerId === 'aletheia') throw outage(); context.say('ok');}, [600_000]);
  try {
    await f.ensemble.dispatch('aletheia', 'Verify', 'logox', {inputKind: 'director'}).done;
    await waitFor(() => f.services.outageWaiting, waiting => waiting);
    await f.deliveries.enqueue({id: 'exhausted', ownerId: 'logox', source: 'techne', sourceActivityId: 'dead', rootActivityId: 'old-root',
      kind: 'failure', inputKind: 'actor', deferredUntilHuman: true, text: DIRECTOR_RECOVERY_EXHAUSTED + '\nActor techne failed.',
      origin: {rootActivityId: 'old-root', recovery: {key: 'provider:temporary:request', attempt: 2, exhausted: true}}});
    f.services.resumeDirector('human-turn'); await f.services.flush();
    assert.equal(f.services.outageWaiting, false, 'the timer is cancelled');
    const lifted = f.services.deliveries.snapshot().find(item => item.id === 'exhausted')!;
    assert.equal(lifted.deferredUntilHuman, false);
    assert.equal(lifted.origin?.recovery?.exhausted, undefined);
    assert.ok(lifted.text.includes(DIRECTOR_RECOVERY_LIFTED) && !lifted.text.includes(DIRECTOR_RECOVERY_EXHAUSTED));
    assert.equal(lifted.origin?.recovery?.key, 'provider:temporary:request');
  } finally {await f.close();}
});

test('resumeTask works from a new root for a failure that was handed to the Director, but never after a user stop', {timeout: 8000}, async () => {
  const started = gate(), release = gate(); let director!: ActorContext;
  const f = await fixture(async (_prompt, context) => {
    if (context.ownerId === 'logox') {director = context; started.resolve(); await release.promise;} else context.say('Continued.');
  });
  try {
    const human = f.ensemble.dispatch('logox', 'Next human goal', 'logox', {inputKind: 'human'}); await started.promise;
    for (const [id, stopReason] of [['delivered', undefined], ['stopped', 'user'], ['unknown', undefined]] as const) {
      await f.journal.checkpoint('s', {activityId: id, ownerId: 'techne', rootActivityId: 'earlier-root', inputKind: 'director', source: 'logox',
        prompt: 'Original task', status: 'failed', time: 1, ...(stopReason ? {stopReason} : {})});
    }
    for (const id of ['delivered', 'stopped']) await f.deliveries.enqueue({id: 'failure-' + id, ownerId: 'logox', source: 'techne', sourceActivityId: id,
      rootActivityId: 'earlier-root', kind: 'failure', inputKind: 'actor', text: 'Actor techne failed.', origin: {rootActivityId: 'earlier-root', recovery: {key: 'x', attempt: 1}}});
    const resume = (id: string) => f.services.execute({id: 'r-' + id, name: 'Actor', arguments: JSON.stringify({tasks: [{ownerId: 'techne', resumeTask: id, prompt: 'Continue'}]})}, director);
    assert.equal((await resume('unknown')).isError, true, 'a failure nobody handed over is still another root goal');
    assert.equal((await resume('stopped')).isError, true);
    const resumed = await resume('delivered');
    assert.equal(resumed.isError, false, resumed.text);
    release.resolve(); await human.done;
  } finally {release.resolve(); await f.close();}
});
