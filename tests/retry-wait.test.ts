import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {MAX_HINTED_WAIT_MS, retryDelay} from '../src/kernel/model-turn.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {ProviderError, parseRetryAfter, providerFailure, waitHintMs} from '../src/providers/http.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';
import {waitForSnapshot} from './runtime-fixture.js';

const temporary = (retryAfterMs?: number, status = 503) =>
  new ProviderError('Model service temporarily unavailable', true, 'temporary', {status, ...(retryAfterMs !== undefined ? {retryAfterMs} : {})});

test('a wait stated in the error text is read conservatively', () => {
  assert.equal(waitHintMs('All accounts rate-limited. Cooldown wait 27s.'), 27_000);
  assert.equal(waitHintMs('Please retry after 27 seconds'), 27_000);
  assert.equal(waitHintMs('Retry in 2 minutes'), 120_000);
  assert.equal(waitHintMs('try again after 1.5s'), 1500);
  assert.equal(waitHintMs('Account cooldown: 45s remaining'), 45_000);
  assert.equal(waitHintMs('wait 250 ms'), 250);
  assert.equal(waitHintMs('Wait 3 more tries'), undefined, 'a count is not a duration');
  assert.equal(waitHintMs('rate limit is 30 per minute'), undefined);
  assert.equal(waitHintMs('model gemini-4 returned 503 after 27 attempts'), undefined);
  assert.equal(waitHintMs('wait 0s'), undefined);
  assert.equal(waitHintMs(undefined), undefined);
});

test('the hint is read from the Retry-After header first, then from the body text, for rate limits and 5xx alike', () => {
  const body = {error: {message: 'All accounts rate-limited. Cooldown wait 27s.'}};
  assert.equal(providerFailure(503, body).diagnostic?.retryAfterMs, 27_000, 'gateway body text');
  assert.equal(providerFailure(503, undefined, undefined, {body: 'upstream: retry after 9 seconds'}).diagnostic?.retryAfterMs, 9000, 'unparsed body text');
  assert.equal(providerFailure(503, body, parseRetryAfter('5')).diagnostic?.retryAfterMs, 5000, 'the header wins');
  assert.equal(providerFailure(429, {error: {message: 'slow down'}}, parseRetryAfter('12')).diagnostic?.retryAfterMs, 12_000);
  assert.equal(providerFailure(502, undefined, parseRetryAfter('3')).diagnostic?.retryAfterMs, 3000, 'a header on a 5xx counts');
  assert.equal(providerFailure(503, {error: {message: 'Service unavailable'}}).diagnostic?.retryAfterMs, undefined, 'no hint stays no hint');
  assert.equal(providerFailure(400, {error: {message: 'wait 27s'}}).diagnostic?.retryAfterMs, undefined, 'only temporary failures carry one');
});

test('a stated wait lasts at least that long, with small jitter, and the normal schedule never shortens it', () => {
  const none = (attempt: number) => retryDelay(temporary(), attempt);
  assert.deepEqual([0, 1, 2, 3, 7, 10].map(attempt => none(attempt).ms), [500, 1000, 2000, 4000, 30_000, 30_000], 'no hint: the existing schedule, untouched');
  assert.equal(none(0).hintedMs, undefined);
  const first = retryDelay(temporary(27_000), 0, () => 0), last = retryDelay(temporary(27_000), 0, () => 0.999);
  assert.equal(first.ms, 27_000); assert.equal(first.hintedMs, 27_000);
  assert.ok(last.ms > 27_000 && last.ms < 27_600, 'jitter stays small: ' + last.ms);
  assert.equal(retryDelay(temporary(27_000), 3, () => 0).ms, 27_000, 'a later attempt does not shorten it');
  assert.equal(retryDelay(temporary(1000), 3, () => 0.5).ms, 4000, 'a hint below the schedule leaves the schedule');
  assert.equal(retryDelay(temporary(1000), 3, () => 0.5).hintedMs, undefined);
  assert.equal(retryDelay(temporary(600_000), 0, () => 0.999).ms, MAX_HINTED_WAIT_MS, 'capped at 120 s per wait');
  assert.equal(retryDelay(temporary(MAX_HINTED_WAIT_MS), 0, () => 0.999).ms, MAX_HINTED_WAIT_MS, 'jitter never passes the cap');
  assert.equal(retryDelay(new Error('plain'), 2).ms, 2000);
});

async function loop(failures: readonly ProviderError[], retries = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-retry-wait-'));
  const store = new RuntimeStore();
  const sent: number[] = [];
  const finish: ModelTurn = {message: {role: 'assistant', text: 'Done.', toolCalls: [{id: 'f', name: '_FinishRound', arguments: JSON.stringify({title: 'Done', summary: 'Round outcome.'})}]}, stop: 'tools'};
  const provider: Provider = {async respond(_request, delta) {
    sent.push(Date.now());
    const failure = failures[sent.length - 1];
    if (failure) throw failure;
    delta({kind: 'text', text: 'Done.'});
    return finish;
  }};
  const execute = createAgent({cwd: directory, store, tools: new Tools(directory), provider: () => provider, iterations: 0, retries,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd: directory, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(directory, 'sessions')), execute, {handoff: async () => {}});
  const task = ensemble.dispatch('logox', 'Go', 'direct');
  const retryDetail = async () => {
    await waitForSnapshot(store, snapshot => snapshot.activities.some(activity => activity.activityId === task.activityId && activity.phase === 'retry'), 4000);
    return store.activities.get('s', task.activityId)?.detail ?? '';
  };
  return {task, sent, store, retryDetail, async close() {task.cancel(); await task.done.catch(() => {}); await ensemble.close(); await rm(directory, {recursive: true, force: true});}};
}

test('a retry waits for the gateway cooldown and says so in one concise line', {timeout: 15_000}, async () => {
  const f = await loop([temporary(1500)]);
  try {
    const detail = await f.retryDetail();
    assert.equal(detail, '[Network] Service unavailable (HTTP 503). Retrying in 2s (1/3)...');
    await f.task.done;
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent[1]! - f.sent[0]! >= 1500, 'the retry came after at least the stated wait: ' + (f.sent[1]! - f.sent[0]!));
    assert.equal(f.store.activities.get('s', f.task.activityId)?.status, 'completed');
  } finally {await f.close();}
});

test('without a hint the notice and the schedule are unchanged', {timeout: 15_000}, async () => {
  const f = await loop([temporary()]);
  try {
    assert.equal(await f.retryDetail(), '[Network] Service unavailable (HTTP 503). Retrying (1/3)...');
    await f.task.done;
    const gap = f.sent[1]! - f.sent[0]!;
    assert.ok(gap >= 450 && gap < 1400, 'about the 500 ms first backoff: ' + gap);
  } finally {await f.close();}
});

test('cancelling interrupts a long cooldown wait at once', {timeout: 15_000}, async () => {
  const f = await loop([temporary(90_000)]);
  try {
    assert.match(await f.retryDetail(), /Retrying in 90s \(1\/3\)/);
    const started = Date.now();
    f.task.cancel();
    await f.task.done;
    assert.ok(Date.now() - started < 2000, 'the wait did not run its course');
    assert.equal(f.sent.length, 1, 'no further request');
    assert.equal(f.store.activities.get('s', f.task.activityId)?.status, 'cancelled');
  } finally {await f.close();}
});

test('the retry count stays as configured however long the hints are', {timeout: 15_000}, async () => {
  const f = await loop([temporary(1), temporary(1), temporary(1)], 2);
  try {
    await f.task.done;
    assert.equal(f.sent.length, 3, 'one try plus two retries, then the failure stands');
    assert.equal(f.store.activities.get('s', f.task.activityId)?.status, 'failed');
  } finally {await f.close();}
});
