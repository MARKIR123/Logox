import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {createProvider, ProviderError, parseRetryAfter, providerFailure} from '../src/providers/http.js';
import {AuthStorage} from '../src/providers/auth.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {RequestGate} from '../src/providers/request-gate.js';
import {waitFor} from './wait-for.js';

const live = () => new AbortController().signal;
const rateLimit = (retryAfterMs?: number) => providerFailure(429, undefined, retryAfterMs);
/** An operation the test settles by hand. */
function manual<T = string>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {resolve = a; reject = b;});
  return {promise, resolve, reject, operation: () => promise};
}
const fast = {baseCooldownMs: 5, maxCooldownMs: 40, retryAfterCapMs: 60};

test('gate caps in-flight requests at the limit and starts waiters in FIFO order', async () => {
  const gate = new RequestGate({maxConcurrency: 2});
  const started: number[] = [], jobs = [0, 1, 2, 3].map(() => manual());
  const results = jobs.map((job, index) => gate.run(() => {started.push(index); return job.operation();}, live()));
  assert.deepEqual(started, [0, 1]);
  assert.equal(gate.inFlight, 2); assert.equal(gate.queued, 2);
  jobs[1]!.resolve('b');
  await waitFor(() => started.slice(), value => value.length === 3, {label: 'third starts'});
  assert.deepEqual(started, [0, 1, 2]);
  jobs[0]!.resolve('a');
  await waitFor(() => started.slice(), value => value.length === 4);
  assert.deepEqual(started, [0, 1, 2, 3]);
  jobs[2]!.resolve('c'); jobs[3]!.resolve('d');
  assert.deepEqual(await Promise.all(results), ['a', 'b', 'c', 'd']);
  assert.equal(gate.inFlight, 0);
});

test('default limit is 16', () => {
  assert.equal(new RequestGate().limit, 16);
});

test('an aborted waiter leaves the queue at once without consuming a slot', async () => {
  const gate = new RequestGate({maxConcurrency: 1});
  const first = manual(), controller = new AbortController();
  const running = gate.run(first.operation, live());
  let queuedStarted = false;
  const queued = gate.run(async () => {queuedStarted = true; return 'x';}, controller.signal);
  const behind = gate.run(async () => 'behind', live());
  assert.equal(gate.queued, 2);
  const reason = new Error('stop');
  controller.abort(reason);
  await assert.rejects(queued, error => error === reason);
  assert.equal(gate.queued, 1); assert.equal(gate.inFlight, 1);
  first.resolve('first');
  assert.equal(await running, 'first'); assert.equal(await behind, 'behind');
  assert.equal(queuedStarted, false);
  await assert.rejects(gate.run(async () => 'late', AbortSignal.abort(new Error('pre'))), /pre/);
  assert.equal(gate.inFlight, 0);
});

test('a rate-limit failure halves the limit down to a floor of 1 and is rethrown unretried', async () => {
  const gate = new RequestGate({maxConcurrency: 16, ...fast});
  let calls = 0;
  const fail = async () => {calls++; throw rateLimit();};
  const limits: number[] = [];
  for (let i = 0; i < 6; i++) {
    await assert.rejects(gate.run(fail, live()), (error: unknown) => error instanceof ProviderError && error.retryable);
    limits.push(gate.limit);
  }
  assert.deepEqual(limits, [8, 4, 2, 1, 1, 1]);
  assert.equal(calls, 6, 'the gate never retries');
});

test('simultaneous rate-limit failures reduce the limit once', async () => {
  const gate = new RequestGate({maxConcurrency: 8, ...fast});
  const jobs = [0, 1, 2, 3].map(() => manual());
  const results = jobs.map(job => gate.run(job.operation, live()).catch(error => error));
  assert.equal(gate.inFlight, 4);
  for (const job of jobs) job.reject(rateLimit());
  await Promise.all(results);
  assert.equal(gate.limit, 4);
});

test('a request started after a reduction can reduce again', async () => {
  const gate = new RequestGate({maxConcurrency: 8, ...fast});
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  assert.equal(gate.limit, 4);
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  assert.equal(gate.limit, 2);
});

test('new starts wait out the exponential cooldown, which doubles and resets on success', async () => {
  const gate = new RequestGate({maxConcurrency: 4, baseCooldownMs: 30, maxCooldownMs: 120, retryAfterCapMs: 500});
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  const first = gate.cooldownRemainingMs;
  assert.ok(first > 0 && first <= 30);
  let startedAt = 0;
  const begin = Date.now();
  await gate.run(async () => {startedAt = Date.now(); return 'ok';}, live());
  assert.ok(startedAt - begin >= first - 5, 'start was held for the cooldown');
  // The success reset the step to base: a new failure holds for base again, not doubled.
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  assert.ok(gate.cooldownRemainingMs <= 30);
  // Two consecutive failures double the hold (up to 60 ms).
  await gate.run(async () => 'ok', live());
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  assert.ok(gate.cooldownRemainingMs > 30 && gate.cooldownRemainingMs <= 60, 'second consecutive failure doubles the hold: ' + gate.cooldownRemainingMs);
});

test('Retry-After is honored and capped', async () => {
  const gate = new RequestGate({maxConcurrency: 4, baseCooldownMs: 1, maxCooldownMs: 2, retryAfterCapMs: 80});
  await assert.rejects(gate.run(async () => {throw rateLimit(50);}, live()));
  assert.ok(gate.cooldownRemainingMs > 5 && gate.cooldownRemainingMs <= 50);
  let startedAt = 0;
  const begin = Date.now();
  await gate.run(async () => {startedAt = Date.now(); return 1;}, live());
  assert.ok(startedAt - begin >= 40);
  await assert.rejects(gate.run(async () => {throw rateLimit(10_000);}, live()));
  assert.ok(gate.cooldownRemainingMs <= 80 && gate.cooldownRemainingMs > 40, 'capped at 80: ' + gate.cooldownRemainingMs);
});

test('an aborted waiter during cooldown rejects immediately', async () => {
  const gate = new RequestGate({maxConcurrency: 4, baseCooldownMs: 10_000, maxCooldownMs: 10_000});
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  const controller = new AbortController();
  const waiting = gate.run(async () => 'never', controller.signal);
  assert.equal(gate.queued, 1);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  assert.equal(gate.queued, 0);
});

test('additive recovery adds one slot after `limit` consecutive successes, up to the max', async () => {
  const gate = new RequestGate({maxConcurrency: 4, ...fast});
  await assert.rejects(gate.run(async () => {throw rateLimit();}, live()));
  assert.equal(gate.limit, 2);
  const ok = () => gate.run(async () => 'ok', live());
  await ok(); assert.equal(gate.limit, 2);
  await ok(); assert.equal(gate.limit, 3);
  await ok(); await ok(); await ok(); assert.equal(gate.limit, 4);
  for (let i = 0; i < 10; i++) await ok();
  assert.equal(gate.limit, 4);
});

test('non-rate-limit errors leave the limit alone and release the slot', async () => {
  const gate = new RequestGate({maxConcurrency: 3});
  for (const error of [new Error('boom'), providerFailure(500), providerFailure(401), providerFailure(402), new ProviderError('x', true)]) {
    await assert.rejects(gate.run(async () => {throw error;}, live()));
    assert.equal(gate.limit, 3); assert.equal(gate.inFlight, 0);
  }
  await assert.rejects(gate.run(() => {throw new Error('sync');}, live()), /sync/);
  assert.equal(gate.inFlight, 0);
});

test('a stream-time overloaded_error counts as rate limiting and the slot is held until the operation settles', async () => {
  const gate = new RequestGate({maxConcurrency: 2, ...fast});
  const job = manual();
  const streaming = gate.run(job.operation, live()).catch(error => error);
  assert.equal(gate.inFlight, 1);
  job.reject(providerFailure(200, {error: {type: 'overloaded_error'}}));
  await streaming;
  assert.equal(gate.inFlight, 0); assert.equal(gate.limit, 1);
});

test('rate-limit classification: 429 and 529 only, quota 429 is not rate limiting', () => {
  assert.equal(providerFailure(429).message, 'Model service temporarily unavailable');
  assert.deepEqual([providerFailure(429).retryable, providerFailure(429).category], [true, 'temporary']);
  assert.equal(providerFailure(529).diagnostic?.status, 529);
  assert.equal(providerFailure(429, {error: {code: 'insufficient_quota'}}).category, 'quota');
  assert.equal(providerFailure(503).diagnostic, undefined);
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter('1.5'), 1500);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

test('createProvider carries Retry-After from an HTTP 429 into the ProviderError diagnostic', async () => {
  const fetcher: typeof fetch = async () => new Response('{"error":{"message":"slow down"}}', {status: 429, headers: {'retry-after': '3'}});
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', key: 'sk-secret',
    temperature: 0, maxTokens: 16, timeoutMs: 1000}, fetcher);
  await assert.rejects(provider.respond({system: 's', messages: [{role: 'user', text: 'hi'}], tools: []}, () => {}, live()), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message, 'Model service temporarily unavailable');
    assert.equal(error.category, 'temporary'); assert.equal(error.retryable, true);
    assert.equal(error.diagnostic?.status, 429); assert.equal(error.diagnostic?.retryAfterMs, 3000);
    return true;
  });
});

test('registry wraps provider() and candidate().provider() in one shared gate per normalized base URL', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-gate-'));
  try {
    const config = await loadConfig(cwd, {provider: {name: 'alpha', model: 'm'}, providers: {
      alpha: {kind: 'openai_compat', base_url: 'http://127.0.0.1:7777/v1'},
      beta: {kind: 'openai_compat', base_url: 'HTTP://127.0.0.1:7777/v1/'},
      gamma: {kind: 'openai_compat', base_url: 'http://127.0.0.1:8888/v1'},
    }}, {}, cwd, cwd);
    let active = 0, peak = 0, release = true;
    const pending: (() => void)[] = [];
    const fetcher: typeof fetch = async () => {
      active++; peak = Math.max(peak, active);
      if (!release) await new Promise<void>(resolve => pending.push(resolve));
      active--;
      return new Response('{}', {status: 500});
    };
    const registry = new ProviderRegistry(config, {}, fetcher, new AuthStorage(join(cwd, 'auth.json')));
    registry.gateOptions = {maxConcurrency: 1};
    const request = {system: 's', messages: [{role: 'user' as const, text: 'hi'}], tools: []};
    const call = (provider: ReturnType<ProviderRegistry['provider']>) => provider.respond(request, () => {}, live()).catch(() => 'failed');
    release = false;
    const sameUrl = [call(registry.provider()), call(registry.candidate('beta', 'm').provider()), call(registry.providerFor('beta', 'm'))];
    await waitFor(() => pending.length, count => count >= 1);
    assert.equal(active, 1, 'one endpoint, one slot');
    assert.equal(peak, 1);
    // Releasing one request admits the next waiter; drain until all three settle.
    release = true;
    while (active || pending.length) {pending.splice(0).forEach(resume => resume()); await waitFor(() => active, count => count === 0, {timeoutMs: 2000}).catch(() => {});}
    assert.deepEqual(await Promise.all(sameUrl), ['failed', 'failed', 'failed']);
    assert.equal(peak, 1, 'never more than one in flight on a shared endpoint');
    // A different endpoint has its own gate and runs concurrently with the first.
    release = false; peak = 0;
    const other = [call(registry.provider()), call(registry.providerFor('gamma', 'm'))];
    await waitFor(() => pending.length, count => count >= 2);
    assert.equal(peak, 2);
    pending.splice(0).forEach(resume => resume());
    await Promise.all(other);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
