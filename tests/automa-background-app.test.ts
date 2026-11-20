import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {runHeadless, type HeadlessIo} from '../src/headless.js';
import {projectDelegations} from '../src/runtime/delegations.js';
import {statusText} from '../src/commands/tasks-page.js';
import {createTestApplication, finalizingProvider, waitForSnapshot} from './runtime-fixture.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const reply = (text: string): ModelTurn => ({stop: 'complete', message: {role: 'assistant', text}});
const calls = (name: string, args: unknown): ModelTurn => ({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id: name.toLowerCase() + '-1', name, arguments: JSON.stringify(args)}]}});
const sse = (chunk: unknown) => 'data: ' + JSON.stringify(chunk) + '\n\n';
const text = (request: ModelRequest) => request.messages.map(message => message.text).join('\n');

/** The worker endpoint: a Read, then (after `gate`, or once the request is aborted) the Finish. Counts requests and notes aborts. */
function endpoint(gate: Promise<void>, state = {requests: 0, aborted: 0, hang: false}) {
  const fetcher: typeof fetch = async (_url, init) => {
    const first = state.requests++ % 2 === 0;
    if (!first) {
      await new Promise<void>((resolve, reject) => {
        if (state.hang) {
          const abort = () => {state.aborted++; reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));};
          if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, {once: true});
        } else void gate.then(() => resolve());
      });
    }
    const delta = {tool_calls: [{index: 0, id: 'w' + state.requests, type: 'function', function: first ? {name: 'Read', arguments: JSON.stringify({file_path: 'notes.txt'})}
      : {name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'the answer is 42', evidence: ['notes.txt:1']})}}]};
    return new Response(sse({choices: [{index: 0, delta, finish_reason: 'tool_calls'}]}) + sse({choices: [], usage: {prompt_tokens: 100, completion_tokens: 7}}) + 'data: [DONE]\n\n',
      {status: 200, headers: {'content-type': 'text/event-stream'}});
  };
  return {fetcher, state};
}

const CONFIG = {permissions: {mode: 'default' as const}, provider: {name: 'alpha', model: 'session-model'}, providers: {alpha: {base_url: 'http://127.0.0.1:7777/v1'}},
  models: {'alpha/session-model': {context_window: 64000}, 'alpha/my-worker': {context_window: 64000}}, kernel: {max_retries: 0}};

/** The Director: dispatches one background job, says it is working, and when the result arrives as a message, answers with it. */
function director(counter: {calls: number}, hold = false): Provider {
  return {async respond(request) {
    counter.calls++;
    if (text(request).includes('<automa-result')) return reply('The answer is 42.');
    if (request.messages.some(message => message.role === 'tool')) return reply(hold ? 'Waiting for the worker.' : 'The worker is running; I will use its result when it arrives.');
    return calls('Automa', {mode: 'background', jobs: [{title: 'Find the answer', brief: 'Find the answer in notes.txt', scope: 'exact'}]});
  }};
}

test('A dispatcher with background jobs outstanding parks with no model requests, its round stays open, and the result arrives as one message', {timeout: 60000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-bg-'));
  try {
    await writeFile(join(cwd, 'notes.txt'), 'the answer is 42\n');
    const config = await loadConfig(cwd, CONFIG, {}, cwd, cwd);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const {fetcher} = endpoint(gate);
    const counter = {calls: 0};
    const app = await createTestApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'), provider: director(counter), fetcher, sessionId: 'bg-session'});
    try {
      await app.submit('/model automa read alpha/my-worker');
      await app.submit('go');
      await waitForSnapshot(app.store, snapshot => snapshot.messages.some(message => message.step?.call?.name === 'Automa' && message.step.state === 'completed'));
      // The tool call returned its receipt while the worker was still waiting for its answer.
      const tool = app.store.getSnapshot().messages.find(message => message.step?.call?.name === 'Automa')!;
      assert.match(tool.text, /^Automa\nL1 Find the answer · running\nResults arrive as messages while you keep working; you do not need to wait for them\./);
      await waitForSnapshot(app.store, () => counter.calls >= 2);
      const director = app.store.getSnapshot().activities.find(activity => activity.ownerId === 'logox')!;
      // Parked: no model request for as long as the job is open, and the round is not closed.
      await sleep(1400);
      assert.equal(counter.calls, 2, 'the Director sent no request while it waited');
      assert.equal(app.store.getSnapshot().activities.find(activity => activity.activityId === director.activityId)!.status, 'running', 'the round stays open');
      assert.equal(app.tools.background.outstanding(director.activityId).length, 1);
      assert.equal(app.tools.background.open('bg-session'), true);
      const waiting = projectDelegations({snapshot: app.store.getSnapshot(), sessionId: 'bg-session'}).find(node => node.kind === 'automa')!;
      assert.equal(waiting.background, true);
      assert.equal(waiting.delivered, false);
      assert.match(statusText(waiting, undefined), /background/);
      release();
      await waitForSnapshot(app.store, snapshot => snapshot.activities.every(activity => ['completed', 'failed'].includes(activity.status)));
      assert.equal(counter.calls, 3, 'one request for the delivery');
      const settled = app.store.getSnapshot();
      assert.equal(settled.activities.find(activity => activity.ownerId === 'logox')!.status, 'completed');
      const delivered = settled.messages.filter(message => message.role === 'user' && message.text.includes('<automa-result'));
      assert.equal(delivered.length, 1, 'delivered once');
      assert.match(delivered[0]!.text, /^\[Message from automa · Automa results L1\]\n<automa-result id="L1" title="Find the answer" status="done"/);
      const node = projectDelegations({snapshot: settled, sessionId: 'bg-session'}).find(item => item.kind === 'automa')!;
      assert.deepEqual([node.status, node.background, node.delivered, node.result?.summary], ['done', true, true, 'the answer is 42']);
      assert.match(statusText(node, undefined), /done · .*delivered/);
      assert.equal(app.tools.background.open('bg-session'), false);
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('Cancelling the dispatcher\'s task cancels its background jobs', {timeout: 60000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-bg-'));
  try {
    await writeFile(join(cwd, 'notes.txt'), 'the answer is 42\n');
    const config = await loadConfig(cwd, CONFIG, {}, cwd, cwd);
    const {fetcher, state} = endpoint(Promise.resolve(), {requests: 0, aborted: 0, hang: true});
    const counter = {calls: 0};
    const app = await createTestApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'), provider: director(counter, true), fetcher, sessionId: 'bg-cancel'});
    try {
      await app.submit('/model automa read alpha/my-worker');
      await app.submit('go');
      await waitForSnapshot(app.store, () => counter.calls >= 2 && state.requests >= 2);
      const activity = app.store.getSnapshot().activities.find(item => item.ownerId === 'logox')!;
      assert.equal(app.tools.background.outstanding(activity.activityId).length, 1);
      app.cancel(activity.activityId);
      await waitForSnapshot(app.store, snapshot => snapshot.activities.every(item => ['completed', 'failed', 'cancelled'].includes(item.status)));
      const limit = Date.now() + 5000;
      while (state.aborted === 0 && Date.now() < limit) await sleep(20);
      assert.equal(state.aborted, 1, 'the worker\'s request was aborted with the task');
      assert.equal(app.tools.background.outstanding(activity.activityId).length, 0);
      const node = projectDelegations({snapshot: app.store.getSnapshot(), sessionId: 'bg-cancel'}).find(item => item.kind === 'automa')!;
      assert.equal(node.status, 'cancelled');
      assert.equal(node.stopReason === 'interrupted' || node.stopReason === 'cancelled_by_user', true, String(node.stopReason));
      assert.equal(counter.calls, 2, 'nothing was delivered to a task that ended');
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('A headless run waits for background jobs and reports them as delivered', {timeout: 90000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-test-headless-'));
  try {
    await mkdir(join(dir, '.logox'), {recursive: true});
    await writeFile(join(dir, '.logox', 'config.toml'), '[provider]\nname = "alpha"\nmodel = "session-model"\n\n[providers.alpha]\nbase_url = "http://127.0.0.1:7777/v1"\n\n' +
      '[models."alpha/session-model"]\ncontext_window = 64000\n\n[models."alpha/my-worker"]\ncontext_window = 64000\n\n[kernel]\nmax_retries = 0\n');
    await writeFile(join(dir, 'notes.txt'), 'the answer is 42\n');
    const {fetcher} = endpoint(sleep(1200));
    const counter = {calls: 0};
    const out: string[] = [], err: string[] = [];
    const io = {cwd: dir, env: {}, stdout: (value: string) => out.push(value), stderr: (value: string) => err.push(value), signals: new EventEmitter() as unknown as HeadlessIo['signals'],
      provider: finalizingProvider(director(counter)), fetcher, resourceOptions: {home: dir, boundary: dir}, authPath: join(dir, 'auth.json')} as HeadlessIo;
    assert.equal(await runHeadless(['-p', 'go', '--output', 'json', '--model', 'session-model', '--provider', 'alpha', '--permission-mode', 'creative'], io), 0, err.join(''));
    const report = JSON.parse(out.join(''));
    assert.equal(report.status, 'completed', out.join(''));
    assert.equal(report.final, 'The answer is 42.', 'the run did not end before the background job did');
    assert.equal(counter.calls, 3);
    const worker = report.delegations.find((item: {kind: string}) => item.kind === 'automa');
    assert.deepEqual([worker.status, worker.background, worker.delivered, worker.result.summary], ['done', true, true, 'the answer is 42']);
    assert.deepEqual(report.automa, {jobs: 1, done: 1, blocked: 0, failed: 0});
  } finally {await rm(dir, {recursive: true, force: true});}
});
