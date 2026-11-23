import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {normalizeMessages, type ModelMessage, type Provider} from '../src/runtime/messages.js';
import {ProviderError} from '../src/providers/http.js';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';

const NOTICE = (n: number) => `[Network] Connection interrupted. Retrying (${n}/3)...`;
type Where = 'actor' | 'director';

/** One owner whose request attempts drop: an actor card (seen from the Director and from its own window) or the Director's own round. */
function fixture(where: Where) {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  const ownerId = where === 'actor' ? 'techne' : 'logox', activityId = where === 'actor' ? 'k' : 'main';
  if (where === 'actor') {
    store.activities.create({sessionId: 's', activityId, ownerId, kind: 'actor', title: 'Build', taskTitle: 'Build the thing', status: 'running', stage: 'x', detail: ''});
    store.message('s', ownerId, 'user', 'Build it.', {activityId, inputKind: 'director', source: 'logox'});
  }
  let clock = 1_000_000;
  const steps = new Steps(store, {sessionId: 's', activityId, ownerId}, () => clock);
  const notice = (n: number) => store.system({id: randomUUID(), sessionId: 's', ownerId, activityId, time: Date.now(), text: NOTICE(n), presentation: 'timeline', kind: 'task_notice'});
  const rows = (view: string) => buildStageRows(store.getSnapshot(), 's', view, 140, where === 'actor' ? {k: true} : {}, null);
  const views = where === 'actor' ? ['logox', 'techne'] : ['logox'];
  return {store, steps, notice, rows, views, activityId, advance: (ms: number) => {clock += ms;}, now: () => clock};
}
const lines = (rows: ReturnType<typeof buildStageRows>) => rows.map(row => row.text.replace(/\s+/g, ' ').trim());
/** The dropped attempt: it thinks for `ms`, the connection drops, the loop announces the retry and waits. */
function drop(f: ReturnType<typeof fixture>, ms: number, n: number) {
  const id = f.steps.thinking(); f.store.appendMessage(id, 'reasoning ' + n);
  f.advance(ms);
  f.steps.interrupted(id); f.steps.endGroup('failed');
  f.notice(n);
  return f.steps.reconnecting();
}

for (const where of ['actor', 'director'] as const) {
  test(`${where}: an interrupted attempt keeps its own muted row with the retry attached, and no notice line trails the card`, () => {
    const f = fixture(where);
    // (a) attempt 1 interrupted, backoff running.
    const resume = drop(f, 155_246, 1);
    for (const view of f.views) {
      const text = lines(f.rows(view));
      assert.ok(text.some(line => /Thinking · interrupted after 2m 35s · reconnecting \(1\/3\)$/.test(line)), view + ': ' + text.join('\n'));
      assert.ok(!text.some(line => line.includes('[Network]')), view + ': the notice is not a line of its own');
      assert.ok(!text.some(line => /^[▸▾⊞ ]*Thinking$/.test(line)), view + ': no live row while waiting');
    }
    // (b) attempt 2 live after the reconnect: its clock counts attempt 2 only.
    resume();
    const second = f.steps.thinking();
    f.advance(116_600);
    for (const view of f.views) {
      const rows = f.rows(view), text = lines(rows);
      const dropped = text.findIndex(line => /Thinking · interrupted after 2m 35s · reconnected$/.test(line));
      assert.ok(dropped >= 0, view + ': ' + text.join('\n'));
      assert.ok(!text.some(line => line.includes('[Network]')), view + ': no trailing notice');
      assert.ok(!text.some(line => /reconnecting/.test(line)));
      const live = rows.findIndex(row => row.animation?.step?.state === 'running' && row.animation.step.title.includes('Thinking'));
      assert.ok(live > dropped, view + ': the live row comes last');
      assert.equal(rows[live]!.animation!.step!.elapsedMs, 0);
      assert.equal(rows[live]!.animation!.step!.runningSince, f.now() - 116_600, 'the live clock started with attempt 2');
    }
    // (b2) a second drop and its retry: two interrupted rows, the first reconnected, the second reconnecting.
    f.steps.interrupted(second); f.steps.endGroup('failed'); f.notice(2); f.steps.reconnecting();
    const text = lines(f.rows('logox'));
    assert.ok(text.some(line => /interrupted after 2m 35s · reconnected$/.test(line)) && text.some(line => /interrupted after 1m 57s · reconnecting \(2\/3\)$/.test(line)), text.join('\n'));
  });

  test(`${where}: a final failure after the last retry reads gave up on the last interrupted row`, () => {
    const f = fixture(where);
    drop(f, 155_246, 1)();
    drop(f, 131_608, 2)();
    // The last attempt drops too; no notice follows because the retries are spent.
    const last = f.steps.thinking(); f.store.appendMessage(last, 'more');
    f.advance(90_000);
    f.steps.interrupted(last);
    f.store.activities.update('s', f.activityId, {status: 'failed', detail: '[Network] Connection failed.'});
    for (const view of f.views) {
      const text = lines(f.rows(view));
      assert.ok(text.some(line => /interrupted after 2m 35s · reconnected$/.test(line)), view + ': ' + text.join('\n'));
      assert.ok(text.some(line => /interrupted after 2m 12s · reconnected$/.test(line)), view);
      assert.ok(text.some(line => /interrupted after 1m 30s · gave up$/.test(line)), view);
      assert.ok(!text.some(line => /reconnecting/.test(line)));
    }
  });
}

test('a retry notice with no interrupted row to attach to stays a line of its own', () => {
  const f = fixture('director');
  f.notice(1);
  assert.ok(lines(f.rows('logox')).some(line => line.includes(NOTICE(1))));
});

test('attempts the connection dropped never reach the model request', () => {
  const messages: ModelMessage[] = [{role: 'user', text: 'Go'}, {role: 'assistant', text: 'partial output of a dropped attempt', reasoning: 'secret', contextExcluded: true}, {role: 'user', text: 'Continue'}];
  const projected = normalizeMessages(messages);
  assert.deepEqual(projected.map(message => message.role), ['user', 'user']);
  assert.ok(!JSON.stringify(projected).includes('partial output'));
});

test('a streamed partial reply of a dropped attempt is kept for the UI but is absent from the retried request, and the last drop is an interrupted row', {timeout: 15_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-retry-rows-'));
  const store = new RuntimeStore();
  const requests: string[] = [];
  const provider: Provider = {async respond(request, delta) {
    requests.push(JSON.stringify(request.messages));
    delta({kind: 'text', text: 'PARTIAL-' + requests.length});
    throw new ProviderError('[Network] Stream interrupted: Connection closed (UND_ERR_SOCKET)', true, 'temporary', {phase: 'stream', code: 'UND_ERR_SOCKET', elapsedMs: 10, receivedBytes: 10});
  }};
  let retried = 0;
  const execute = createAgent({cwd: directory, store, tools: new Tools(directory), provider: () => provider, iterations: 0, retries: 1,
    retryProvider: async (context) => {
      retried++;
      store.system({id: randomUUID(), sessionId: context.sessionId, ownerId: context.ownerId, activityId: context.activityId, time: Date.now(), text: NOTICE(1), presentation: 'timeline', kind: 'task_notice'});
      return true;
    },
    requestBase: async () => ({...composeBaseSystemPrompt({cwd: directory, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(directory, 'sessions')), execute, {handoff: async () => {}});
  try {
    const task = ensemble.dispatch('logox', 'Go', 'direct');
    await task.done.catch(() => {});
    assert.equal(retried, 1);
    assert.equal(requests.length, 2);
    assert.ok(!requests[1]!.includes('PARTIAL-1'), 'the dropped attempt is not replayed to the model');
    const attempts = store.getSnapshot().messages.filter(message => message.kind === 'thinking' && message.step?.groupId);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(message => message.step!.state === 'failed' && message.step!.interrupted === true), 'both attempts end as interrupted rows');
    const text = lines(buildStageRows(store.getSnapshot(), 's', 'logox', 140, {}, null));
    assert.ok(text.some(line => /Thinking · interrupted after .* · reconnected$/.test(line)), text.join('\n'));
    assert.ok(text.some(line => /Thinking · interrupted after .* · gave up$/.test(line)), text.join('\n'));
  } finally {await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});
