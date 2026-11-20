import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {FORK_DIRECTIVE} from '../src/tools/orchestration/AutomaTool/prompt.js';
import {createTestApplication, waitForSnapshot} from './runtime-fixture.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

/** A real application: the Director's own request is captured when its `Automa` call runs, and the fork sends exactly that request plus the turn and the directive. */
test('A fork in a real application starts from the Director\'s own request, byte for byte, and is charged as a fork', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-fork-app-'));
  try {
    await writeFile(join(cwd, 'notes.txt'), 'the answer is 42\n');
    const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {name: 'alpha', model: 'session-model'}, providers: {alpha: {base_url: 'http://127.0.0.1:7777/v1'}},
      models: {'alpha/session-model': {context_window: 64000}}}, {}, cwd, cwd);
    const requests: ModelRequest[] = [];
    let directorTurns = 0;
    const director: Provider = {async respond(request): Promise<ModelTurn> {
      requests.push(structuredClone(request));
      if (request.messages.at(-1)?.text.startsWith(FORK_DIRECTIVE)) {
        return {message: {role: 'assistant', text: '', toolCalls: [{id: 'f1', name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'the answer is 42', evidence: ['notes.txt:1']})}]},
          stop: 'tools', usage: {input: 1000, output: 12, cacheRead: 900}};
      }
      directorTurns++;
      return directorTurns === 1
        ? {message: {role: 'assistant', text: '', toolCalls: [{id: 'd1', name: 'Automa', arguments: JSON.stringify({jobs: [{title: 'Find the answer', brief: 'Read notes.txt and report the answer', scope: 'exact', fork: true}]})}]}, stop: 'tools'}
        : {message: {role: 'assistant', text: 'The answer is 42.'}, stop: 'complete'};
    }};
    const app = await createTestApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, config, env: {}, authPath: join(cwd, 'auth.json'), provider: director, sessionId: 'fork-session'});
    try {
      await app.submit('go');
      await waitForSnapshot(app.store, snapshot => snapshot.activities.length > 0 && snapshot.activities.every(activity => ['completed', 'failed'].includes(activity.status)));
      const settled = app.store.getSnapshot();
      assert.equal(settled.activities[0]!.status, 'completed', JSON.stringify(settled.messages.map(message => [message.kind, message.text.slice(0, 300)])));
      const forkIndex = requests.findIndex(request => request.messages.at(-1)?.text.startsWith(FORK_DIRECTIVE));
      assert.ok(forkIndex > 0, 'the fork sent a request');
      const parent = requests[0]!, fork = requests[forkIndex]!;
      assert.deepEqual(fork.system, parent.system);
      assert.deepEqual(fork.tools, parent.tools, 'the Director\'s tool list, in its order');
      assert.ok(!fork.tools.some(tool => tool.name === 'Finish'), 'Finish is not declared for the fork');
      assert.deepEqual([fork.cacheKey, fork.cacheRetention, fork.supportsVision], [parent.cacheKey, parent.cacheRetention, parent.supportsVision]);
      assert.deepEqual(fork.messages.slice(0, parent.messages.length), parent.messages, 'every message of the Director\'s request, untouched');
      const [assistant, result, directive] = fork.messages.slice(parent.messages.length);
      assert.deepEqual([assistant?.role, assistant?.role === 'assistant' ? assistant.toolCalls?.[0]?.name : undefined], ['assistant', 'Automa']);
      assert.deepEqual([result?.role, result?.text], ['tool', 'Forked. Your part follows.']);
      assert.equal(directive?.role, 'user');
      assert.match(directive!.text, /\n\nTitle: Find the answer\n\nRead notes\.txt and report the answer\n\nScope: exact: follow the brief literally\./);
      assert.equal(fork.messages.length, parent.messages.length + 3);
      // The Director's next request holds the real result, never the fork's transcript.
      const next = requests.at(-1)!;
      const returned = next.messages.filter(message => message.role === 'tool').at(-1)!.text;
      assert.match(returned, /<automa-result id="L1" kind="fork" title="Find the answer" status="done" took="\d+:\d\d" model="alpha\/session-model">/);
      // A local endpoint with no prompt cache key caches nothing: the receipt says so, and no cache share is claimed.
      assert.match(returned, /Forks on alpha are not cached; each costs a full read of your context\. Prefer workers with a brief\./);
      const tool = app.store.getSnapshot().messages.find(message => message.step?.call?.name === 'Automa');
      assert.equal(tool?.step?.swarm?.jobs[0]?.kind, 'fork');
      assert.equal(app.store.getSnapshot().activities.length, 1, 'a fork is no activity and no actor');
      await app.submit('/usage');
      const page = app.surfaces.getSnapshot();
      assert.ok(page?.kind === 'page');
      const lines = page.tabs.find(item => item.id === 'session')!.lines.join('\n');
      assert.match(lines, /Forked by Logox: .*1,000 in \/ 12 out · cache hit 90%/);
      app.surfaces.cancel();
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});
