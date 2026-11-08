import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import {finalReportsFor} from '../src/runtime/final-reports.js';
import {FINISH_ROUND_DELIVERED, FINISH_ROUND_LATE_REPORT} from '../src/tools/protocol/_FinishRoundTool/prompt.js';
import {EMPTY_REPLY_REMINDER, openWorkNote} from '../src/prompts/runtime/recovery.js';

const metadata = {title: 'Delivered result', outcome: 'Round outcome.', verification: null, carry_forward: []};
const finish = (id = 'finish'): ToolCall => ({id, name: '_FinishRound', arguments: JSON.stringify(metadata)});
const turn = (text: string, calls?: ToolCall[]): ModelTurn => ({message: {role: 'assistant', text, ...(calls ? {toolCalls: calls} : {})}, stop: calls ? 'tools' : 'complete'});
const finalizerText = (request: ModelRequest) => request.messages.findLast(message => message.role === 'context' && message.kind === 'finalizer')?.text ?? '';

async function fixture(respond: (request: ModelRequest, index: number, store: RuntimeStore) => ModelTurn) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-round-delivery-'));
  const journal = new Journal(join(cwd, 'sessions')), store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request, delta, signal) {
    signal.throwIfAborted(); requests.push(request);
    const value = respond(request, requests.length, store);
    if (value.message.text) delta({kind: 'text', text: value.message.text});
    return value;
  }};
  const execute = createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId: 'logox', builtinPrompt: 'Test execution'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, journal, execute, {});
  return {store, requests, ensemble, async cleanup() {await ensemble.close(); await rm(cwd, {recursive: true, force: true});}};
}
const visibleText = (store: RuntimeStore) => store.getSnapshot().messages.filter(message => message.role === 'assistant' && message.kind !== 'thinking').map(message => message.text);

test('text delivered during round-memory repair counts as the delivery and only _FinishRound is asked for', async () => {
  const f = await fixture((request, index) => {
    if (index === 1) return turn('', [finish('early')]);
    if (index === 2) return turn('Here is the answer.');
    assert.equal(index, 3);
    assert.deepEqual(request.tools.map(tool => tool.name), ['_FinishRound']);
    assert.ok(finalizerText(request).startsWith(FINISH_ROUND_DELIVERED));
    assert.ok(!JSON.stringify(request.messages).includes(EMPTY_REPLY_REMINDER), 'no wasted empty-reply reminder');
    return turn('', [finish('late')]);
  });
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 3);
    assert.deepEqual(visibleText(f.store), ['Here is the answer.']);
  } finally {await f.cleanup();}
});

test('text delivered during repair is not failed even if the model never calls _FinishRound', async () => {
  const f = await fixture((_request, index) => index === 1 ? turn('', [finish('early')]) : turn('Delivered text.'));
  try {
    const task = f.ensemble.dispatch('logox', 'Explain', 'direct');
    await task.done;
    assert.equal(f.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 3);
  } finally {await f.cleanup();}
});

test('a Director closing a round with dispatched work still open is told its text is a status update', async () => {
  const f = await fixture((request, index, store) => {
    if (index === 1) {
      const director = store.activities.list().find(activity => activity.ownerId === 'logox')!;
      for (const [ownerId, status, activityId] of [['aletheia', 'running', 'open-1'], ['kalon', 'queued', 'open-2']] as const) {
        store.activities.create({sessionId: 's', activityId, ownerId, kind: 'actor', title: 'Work', status, stage: '', detail: '',
          rootActivityId: director.activityId, inputKind: 'director'});
      }
      store.activities.create({sessionId: 's', activityId: 'other-1', ownerId: 'techne', kind: 'actor', title: 'Work', status: 'running', stage: '', detail: '',
        rootActivityId: 'someone-else', inputKind: 'director'});
      return turn('Waiting for the reviewers.');
    }
    assert.ok(finalizerText(request).includes(openWorkNote(['Aletheia (running)', 'Kalon (queued)'])));
    assert.ok(!finalizerText(request).includes('Techne'));
    return turn('', [finish()]);
  });
  try {
    const task = f.ensemble.dispatch('logox', 'Review', 'direct');
    await task.done;
    assert.equal(f.requests.length, 2);
    assert.equal(finalReportsFor(f.store).has(task.activityId), false, 'a status update is not a final report');
  } finally {await f.cleanup();}
  assert.equal(openWorkNote(['Aletheia (running)']), '[Runtime] Still open: Aletheia (running). Your text is a status update, not the final report.');
});

test('a delivered final report with nothing open is recorded for its root, and a later wake needs no text', async () => {
  const f = await fixture((_request, index) => index === 1 ? turn('Final report.', [finish()]) : turn('', [finish('late')]));
  try {
    const first = f.ensemble.dispatch('logox', 'Do it', 'direct');
    await first.done;
    assert.equal(finalReportsFor(f.store).has(first.activityId), true);
    finalReportsFor(f.store).mark('late-root');
    await f.ensemble.deliveries.enqueue({id: 'late-report', ownerId: 'logox', source: 'techne', sourceActivityId: 'child', rootActivityId: 'late-root',
      kind: 'report', inputKind: 'actor', text: 'Late report.', origin: {rootActivityId: 'late-root'}});
    const wake = f.ensemble.dispatch('logox', 'wake', 'techne', {rootActivityId: 'late-root', inputKind: 'actor', coordinationWake: true});
    await wake.done;
    assert.equal(f.store.activities.get('s', wake.activityId)?.status, 'completed');
    assert.equal(f.requests.length, 2, 'the textless _FinishRound closed the wake in one request');
  } finally {await f.cleanup();}
});

test('the late-report closure text asks for only what changed and accepts a textless close', () => {
  assert.match(FINISH_ROUND_LATE_REPORT, /only what changed/);
  assert.match(FINISH_ROUND_LATE_REPORT, /without text is accepted/);
});
