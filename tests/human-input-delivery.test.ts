import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestApplication, waitForSnapshot} from './runtime-fixture.js';
import {loadConfig} from '../src/config/config.js';
import {ProviderError} from '../src/providers/http.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';

function gate() {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};}
async function fixture(respond: Provider['respond'], retries = 0) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-test-human-input-'));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}, kernel: {max_retries: retries}, permissions: {mode: 'creative'}}, {}, cwd, cwd);
  const app = await createTestApplication({cwd, config, sessionId: 's', provider: {respond}, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json')});
  return {app, cwd, async close() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
function steer(app: Awaited<ReturnType<typeof createTestApplication>>, text: string, activityId: string, source = 'logox') {
  return Reflect.apply(app.submit, app, [text, source, {mode: 'steer', activityId}]) as Promise<void>;
}
const done = () => ({stop: 'complete' as const, message: {role: 'assistant' as const, text: 'Completed the requested work.'}});
const label = () => ({stop: 'tools' as const, message: {role: 'assistant' as const, text: '',
  toolCalls: [{id: 'label', name: 'UpdateTaskProgress', arguments: '{"label":"Checking the current work"}'}]}});
async function idle(app: Awaited<ReturnType<typeof createTestApplication>>) {
  const end = Date.now() + 5000;
  while (app.ensemble.isBusy()) {if (Date.now() > end) throw new Error('Input delivery did not settle'); await new Promise(resolve => setTimeout(resolve, 5));}
}

test('public Queue and Steer survive the managed-session wrapper and reach different model requests', {timeout: 10000}, async () => {
  const started = gate(), release = gate(); const requests: ModelRequest[] = [];
  const f = await fixture(async (request, _delta, signal) => {
    requests.push(request);
    if (requests.length === 1) {started.resolve(); await release.promise; assert.equal(signal.aborted, false); return label();}
    return done();
  });
  try {
    await f.app.submit('original human goal'); await started.promise;
    const target = f.app.store.activities.list().find(activity => activity.ownerId === 'logox' && activity.status === 'running')!;
    await f.app.submit('later independent goal');
    await steer(f.app, 'correct the current path', target.activityId);
    assert.equal(f.app.store.activities.list().length, 2, 'Steering must not create another task');
    release.resolve(); await idle(f.app);
    assert.ok(requests[1]?.messages.some(message => message.text === 'correct the current path'));
    assert.ok(!requests[1]?.messages.some(message => message.text === 'later independent goal'));
    assert.ok(requests[2]?.messages.some(message => message.text === 'later independent goal'));
    const steering = (await f.app.journal.load('s', 'logox')).find(entry => entry.text === 'correct the current path');
    assert.equal(steering?.activityId, target.activityId); assert.equal(steering?.inputKind, 'human');
  } finally {release.resolve(); await f.close();}
});

test('public steering rejects stale targets and routing commands without queue fallback', {timeout: 10000}, async () => {
  const started = gate(), release = gate();
  const f = await fixture(async () => {started.resolve(); await release.promise; return done();});
  try {
    await f.app.submit('original goal'); await started.promise;
    const target = f.app.store.activities.list()[0]!;
    await assert.rejects(steer(f.app, 'stale correction', 'closed-target'), /no longer|not active|unavailable/i);
    await assert.rejects(steer(f.app, '/status', target.activityId), /command|routing/i);
    await assert.rejects(steer(f.app, '@kalon misroute', target.activityId), /command|routing/i);
    await assert.rejects(steer(f.app, 'wrong window', target.activityId, 'kalon'), /target|window|owner/i);
    assert.equal(f.app.store.activities.list().length, 1);
    assert.equal(f.app.ensemble.getActiveTask('logox')?.activityId, target.activityId);
  } finally {release.resolve(); await f.close();}
});

test('steering admitted while context preparation waits is included in the next actual provider request', {timeout: 10000}, async () => {
  const preparing = gate(), releasePrepare = gate(); const requests: ModelRequest[] = [];
  const f = await fixture(async request => {requests.push(request); return done();});
  const original = f.app.contexts.prepare.bind(f.app.contexts);
  let first = true;
  f.app.contexts.prepare = async (...args) => {
    const result = await original(...args);
    if (first) {first = false; preparing.resolve(); await releasePrepare.promise;}
    return result;
  };
  try {
    await f.app.submit('prepare original goal'); await preparing.promise;
    const target = f.app.store.activities.list()[0]!;
    await steer(f.app, 'correction during preparation', target.activityId);
    releasePrepare.resolve(); await idle(f.app);
    assert.ok(requests[0]?.messages.some(message => message.text === 'correction during preparation'));
    assert.equal(requests.length, 1);
  } finally {releasePrepare.resolve(); await f.close();}
});

test('queuing a continuation does not reset recovery budgets in the still-running activity', {timeout: 10000}, async () => {
  const secondStarted = gate(), releaseSecond = gate(); let calls = 0;
  const f = await fixture(async () => {
    if (++calls === 1) return {stop: 'complete', message: {role: 'assistant', text: '', reasoning: 'Preparing the next step.'}};
    if (calls === 2) {secondStarted.resolve(); await releaseSecond.promise;}
    return done();
  });
  try {
    await f.app.submit('original recovery goal'); await secondStarted.promise;
    const root = f.app.store.activities.list()[0]!.activityId;
    const path = join(f.cwd, '.logox', 'state', 'actor-coordination', createHash('sha256').update('s').digest('hex') + '.json');
    const state = () => readFile(path, 'utf8').then(text => JSON.parse(text));
    assert.equal((await state()).execution[root].noDelivery.used, 1);
    // This is the existing natural-language continuation routing fixture.
    await f.app.submit('继续');
    assert.equal((await state()).execution[root].noDelivery.used, 1);
    releaseSecond.resolve(); await idle(f.app);
    assert.equal((await state()).execution[root].noDelivery.used, 0);
  } finally {releaseSecond.resolve(); await f.close();}
});

test('retry boundaries consume new steering instead of resampling a stale request', {timeout: 10000}, async () => {
  const requests: ModelRequest[] = [];
  const f = await fixture(async request => {
    requests.push(request);
    if (requests.length === 1) throw new ProviderError('Temporary service unavailable', true, 'temporary', {status: 503});
    return done();
  }, 1);
  try {
    await f.app.submit('retry original goal');
    await waitForSnapshot(f.app.store, snapshot => snapshot.messages.some(message => message.step?.waiting === 'Waiting for retry'));
    const target = f.app.store.activities.list()[0]!;
    await steer(f.app, 'correction before retry', target.activityId);
    await idle(f.app);
    assert.ok(requests[1]?.messages.some(message => message.text === 'correction before retry'));
  } finally {await f.close();}
});
