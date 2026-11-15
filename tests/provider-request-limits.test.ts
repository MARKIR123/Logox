import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../src/config/config.js';
import {AuthStorage} from '../src/providers/auth.js';
import {ProviderError, providerFailure} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {RequestGate} from '../src/providers/request-gate.js';
import {Tools} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import type {ActorContext} from '../src/actors/ensemble.js';

const live = () => new AbortController().signal;
const request = {system: 's', messages: [{role: 'user' as const, text: 'hi'}], tools: []};

function sse(call?: {id: string; name: string; args: unknown}): Response {
  const chunk = (delta: unknown, finish?: string) => 'data: ' + JSON.stringify({choices: [{delta, ...(finish ? {finish_reason: finish} : {})}]}) + '\n\n';
  const body = (call ? chunk({tool_calls: [{index: 0, id: call.id, function: {name: call.name, arguments: JSON.stringify(call.args)}}]}, 'tool_calls') : chunk({content: 'ok'}, 'stop'))
    + 'data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 10, completion_tokens: 5}}) + '\n\ndata: [DONE]\n\n';
  return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}});
}

async function registryFor(cwd: string, fetcher: typeof fetch, providers: Record<string, object>) {
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'alpha', model: 'm'}, providers}, {}, cwd, cwd);
  return new ProviderRegistry(config, {}, fetcher, new AuthStorage(join(cwd, 'auth.json')));
}

test('max_concurrent_requests is a provider setting between 1 and 256 and defaults to unset', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-limits-'));
  try {
    const config = await loadConfig(cwd, {providers: {alpha: {kind: 'openai_compat', base_url: 'http://127.0.0.1:1/v1', max_concurrent_requests: 3}, beta: {kind: 'openai_compat', base_url: 'http://127.0.0.1:2/v1'}}}, {}, cwd, cwd);
    assert.equal(config.providers.alpha?.max_concurrent_requests, 3);
    assert.equal(config.providers.beta?.max_concurrent_requests, undefined);
    await assert.rejects(loadConfig(cwd, {providers: {alpha: {kind: 'openai_compat', base_url: 'http://127.0.0.1:1/v1', max_concurrent_requests: 0}}}, {}, cwd, cwd));
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('The request semaphore wraps one HTTP request: two workers and an actor sharing a provider with max 1 all finish, never two requests at once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-limits-'));
  try {
    await writeFile(join(cwd, 'a.txt'), 'one\n');
    let active = 0, peak = 0, total = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      active++; peak = Math.max(peak, active); total++;
      await delay(15);
      active--;
      const body = JSON.parse(String(init?.body)) as {messages: {role: string}[]};
      // A worker that has seen a tool result finishes; otherwise it reads a file first, which takes time between its two requests.
      return body.messages.some(message => message.role === 'tool')
        ? sse({id: 'fin', name: 'Finish', args: {status: 'done', summary: 'read it'}})
        : body.messages.length === 1 && /actor/.test(JSON.stringify(body.messages)) ? sse() : sse({id: 'r1', name: 'Read', args: {file_path: 'a.txt'}});
    };
    const registry = await registryFor(cwd, fetcher, {alpha: {kind: 'openai_compat', base_url: 'http://127.0.0.1:7001/v1', max_concurrent_requests: 1}});
    const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    const profile = {name: 'work crew', default_style: 'scout', styles: {scout: {}}};
    tools.setAutomaEnvironment({resolveModel: () => ({provider: registry.providerFor('alpha', 'm'), model: 'alpha/m'}), profile: () => profile,
      workerDir: session => join(cwd, 'parked', session)});
    const context = (ownerId: string): ActorContext => ({sessionId: 's', activityId: 'act-' + ownerId, ownerId, history: [], signal: live(),
      report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}});
    const dispatch = (briefs: string[]) => ({id: 'd', name: 'Automa', arguments: JSON.stringify({jobs: briefs.map(brief => ({title: brief, brief, scope: 'exact'}))})});
    // The actor makes three requests with thinking time between them; two workers of one dispatcher and one of another run meanwhile.
    const actor = (async () => {
      for (let turn = 0; turn < 3; turn++) {
        await registry.provider().respond({system: 's', messages: [{role: 'user', text: 'actor turn ' + turn}], tools: []}, () => {}, live());
        await delay(10);
      }
      return 'actor done';
    })();
    const [first, second, actorDone] = await Promise.all([
      tools.execute(dispatch(['first worker', 'second worker']), context('techne')),
      tools.execute(dispatch(['third worker']), context('kalon')),
      actor,
    ]);
    assert.match(first.text, /2\/2 done/);
    assert.match(second.text, /1\/1 done/);
    assert.equal(actorDone, 'actor done');
    assert.equal(peak, 1, 'one request in flight at a time');
    assert.equal(total, 3 * 2 + 3, 'three workers with two requests each, and the actor\'s three');
  } finally {
    await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true});
    await rm(cwd, {recursive: true, force: true});
  }
});

test('A stated cooldown holds every later request of the provider, actor and worker alike, and is capped at 120 s', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-limits-'));
  const cleanup: (() => void)[] = [];
  try {
    const stamps: number[] = [];
    const fetcher: typeof fetch = async () => {
      stamps.push(Date.now());
      return stamps.length === 1 ? new Response('{"error":{"message":"busy"}}', {status: 503, headers: {'retry-after': '0.4'}}) : sse();
    };
    const registry = await registryFor(cwd, fetcher, {alpha: {kind: 'openai_compat', base_url: 'http://127.0.0.1:7002/v1'}});
    // The gate's cooldown timer is unref'd (the app has other handles); the test holds the loop open itself.
    const hold = setInterval(() => {}, 50);
    cleanup.push(() => clearInterval(hold));
    const actor = registry.provider(), worker = registry.providerFor('alpha', 'm');
    await assert.rejects(actor.respond(request, () => {}, live()), (error: unknown) => error instanceof ProviderError && error.diagnostic?.retryAfterMs === 400);
    const failedAt = stamps[0]!;
    // Both a worker's and another actor's request, sent right after the failure, wait for the stated cooldown.
    await Promise.all([worker.respond(request, () => {}, live()), registry.candidate('alpha', 'm').provider().respond(request, () => {}, live())]);
    assert.equal(stamps.length, 3);
    assert.ok(stamps[1]! - failedAt >= 350, `the worker waited ${stamps[1]! - failedAt} ms`);
    assert.ok(stamps[2]! - failedAt >= 350, `the actor waited ${stamps[2]! - failedAt} ms`);
    // A single cooldown never exceeds 120 s, whatever the gateway states.
    const gate = new RequestGate({maxConcurrency: 4});
    await gate.run(async () => {throw providerFailure(503, undefined, 900_000);}, live()).catch(() => {});
    assert.ok(gate.cooldownRemainingMs > 100_000 && gate.cooldownRemainingMs <= 120_000, String(gate.cooldownRemainingMs));
    assert.equal(gate.limit, 4, 'only a rate-limit failure lowers the limit');
  } finally {for (const stop of cleanup) stop(); await rm(cwd, {recursive: true, force: true});}
});
