import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {markInterruptedJobs} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {createTestApplication, waitForSnapshot} from './runtime-fixture.js';
import type {Provider} from '../src/runtime/messages.js';

/** A real application: the Director is scripted, and the worker goes through the production registry, gate and HTTP client against a fake endpoint. */
test('A real application runs a dispatch end to end: gate, permissions, live swarm, journal and usage', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-app-'));
  try {
    await writeFile(join(cwd, 'notes.txt'), 'the answer is 42\n');
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'alpha', model: 'session-model'}, providers: {alpha: {base_url: 'http://127.0.0.1:7777/v1'}},
      models: {'alpha/session-model': {context_window: 64000}, 'alpha/my-worker': {context_window: 64000}}}, {}, cwd, cwd);
    let requests = 0;
    const sse = (chunk: unknown) => 'data: ' + JSON.stringify(chunk) + '\n\n';
    const models: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      models.push((JSON.parse(String(init?.body)) as {model: string}).model);
      const first = requests++ === 0;
      const delta = first
        ? {tool_calls: [{index: 0, id: 'worker-1', type: 'function', function: {name: 'Read', arguments: JSON.stringify({file_path: 'notes.txt'})}}]}
        : {content: 'summary: the answer is 42\nevidence: notes.txt:1'};
      const body = sse({choices: [{index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop'}]}) + sse({choices: [], usage: {prompt_tokens: 100, completion_tokens: 7}}) + 'data: [DONE]\n\n';
      return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}});
    };
    let turn = 0;
    const director: Provider = {async respond() {
      turn++;
      return turn === 1
        ? {message: {role: 'assistant', text: '', toolCalls: [{id: 'd1', name: 'Automa', arguments: JSON.stringify({jobs: [{title: 'Find the answer', brief: 'Find the answer in notes.txt'}]})}]}, stop: 'tools'}
        : {message: {role: 'assistant', text: 'The answer is 42.'}, stop: 'complete'};
    }};
    const app = await createTestApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'), provider: director, fetcher, sessionId: 'automa-session'});
    try {
      await app.submit('/model automa alpha/my-worker');
      await app.submit('go');
      await waitForSnapshot(app.store, snapshot => snapshot.activities.length > 0 && snapshot.activities.every(activity => ['completed', 'failed'].includes(activity.status)));
      const settled = app.store.getSnapshot();
      assert.equal(settled.activities[0]!.status, 'completed', JSON.stringify(settled.messages.map(message => [message.kind, message.text.slice(0, 300)])));
      assert.equal(requests, 2, 'the worker went through the production HTTP client');
      assert.deepEqual(models, ['my-worker', 'my-worker'], 'the choice of the user outranks the shipped preset');
      const tool = app.store.getSnapshot().messages.find(message => message.step?.call?.name === 'Automa');
      assert.equal(tool?.step?.state, 'completed');
      const swarm = tool!.step!.swarm!;
      assert.equal(swarm.name, 'runners');
      assert.equal(swarm.jobs[0]!.state, 'done');
      assert.equal(swarm.jobs[0]!.calls[0]!.state, 'completed');
      assert.match(swarm.jobs[0]!.receipt!, /evidence: notes\.txt:1/);
      const journal = join(cwd, '.logox', 'state', 'sessions', 'automa-session', 'subagents', 'automa.jsonl');
      const events = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {event: string; principal: string});
      assert.deepEqual(events.map(event => event.event), ['start', 'message', 'tool', 'message', 'end']);
      assert.ok(events.every(event => event.principal === 'logox'));
      assert.equal(await markInterruptedJobs(journal), 0);
      await app.submit('/usage');
      const page = app.surfaces.getSnapshot();
      assert.ok(page?.kind === 'page');
      const lines = page.tabs.find(item => item.id === 'session')!.lines.join('\n');
      assert.match(lines, /Dispatched by Logox: .*200 in \/ 14 out/);
      assert.match(lines, /alpha\/my-worker: .*200 in \/ 14 out/);
      app.surfaces.cancel();
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});
