import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime, type TaskHandle} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, ModelTurn, Provider, ToolCall} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';

const finish = (id: string, title = 'Closed', summary = 'Model memory.'): ToolCall => ({id, name: '_FinishRound', arguments: JSON.stringify({title, summary})});
const turn = (text: string, calls?: ToolCall[]): ModelTurn => ({message: {role: 'assistant', text, ...(calls ? {toolCalls: calls} : {})}, stop: calls ? 'tools' : 'complete'});
type Script = (request: ModelRequest, index: number, signal: AbortSignal) => ModelTurn | Promise<ModelTurn>;

async function fixture(directorScript: Script, companionScript: Script, existing?: {cwd: string}) {
  const cwd = existing?.cwd ?? await mkdtemp(join(tmpdir(), 'logox-round-boundaries-'));
  const journal = new Journal(join(cwd, 'sessions'));
  const store = new RuntimeStore();
  const requests = {logox: [] as ModelRequest[], techne: [] as ModelRequest[]};
  const make = (owner: 'logox' | 'techne', script: Script): Provider => ({async respond(request, delta, signal) {
    signal.throwIfAborted();
    requests[owner].push(request);
    const value = await script(request, requests[owner].length, signal);
    if (value.message.text) delta({kind: 'text', text: value.message.text});
    return value;
  }});
  const agents = (['logox', 'techne'] as const).map(owner => {
    const provider = make(owner, owner === 'logox' ? directorScript : companionScript);
    return createAgent({cwd, store, tools: new Tools(cwd), provider: () => provider, iterations: 0, retries: 0,
      requestBase: async () => ({...composeBaseSystemPrompt({cwd, ownerId: owner, builtinPrompt: 'Test execution'}), tools: toolDefinitions})});
  });
  const ensemble = new EnsembleRuntime<string>('s', store, journal, (prompt, context) => agents[context.ownerId === 'logox' ? 0 : 1]!(prompt, context), {concurrency: 'actor'});
  return {cwd, journal, store, requests, ensemble,
    async close() {await ensemble.close();},
    async cleanup() {await ensemble.close(); await rm(cwd, {recursive: true, force: true});}};
}
const gate = () => {let open!: () => void; const wait = new Promise<void>(resolve => {open = resolve;}); return {wait, open};};
const records = async (f: {journal: Journal}, owner = 'logox') => f.journal.rounds('s', owner, await f.journal.load('s', owner));

test('a Director round spans dispatch, wait and acceptance: one record, one closing follow-up', async () => {
  let techne: TaskHandle | undefined;
  const f = await fixture((_request, index) => {
    if (index === 1) {techne = f.ensemble.dispatch('techne', 'Build it', 'logox', {inputKind: 'director'}); return turn('Dispatched, waiting.');}
    return index === 2 ? turn('Accepted and verified.') : turn('', [finish('close', 'Feature accepted', 'Techne built it; accepted.')]);
  }, () => turn('Built.', [finish('t')]));
  try {
    const first = f.ensemble.dispatch('logox', 'Build a feature', 'direct'); await first.done;
    assert.equal(f.requests.logox.length, 1, 'no closing follow-up while work is open');
    assert.equal((await records(f)).length, 0, 'a suspended round writes no record');
    await techne!.done;
    const wake = f.ensemble.dispatch('logox', 'Reports arrived', 'techne', {inputKind: 'actor'}); await wake.done;
    assert.equal(f.requests.logox.length, 3, 'exactly one closing follow-up in all');
    const entries = await f.journal.load('s', 'logox');
    const found = await records(f);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.start, 0); assert.equal(found[0]!.end, entries.length); assert.equal(found[0]!.activityId, first.activityId);
    assert.equal(found[0]!.ordinal, 1);
    assert.equal(found[0]!.memory?.source, 'model'); assert.equal(found[0]!.memory?.title, 'Feature accepted');
    const users = entries.filter(entry => entry.role === 'user');
    assert.equal(users[0]!.roundId, undefined); assert.equal(users[1]!.roundId, first.activityId);
  } finally {await f.cleanup();}
});

test('a _FinishRound call while dispatched work is open gets a normal result and closes nothing', async () => {
  const hold = gate();
  const f = await fixture((_request, index) => {
    if (index === 1) {f.ensemble.dispatch('techne', 'Build it', 'logox', {inputKind: 'director'}); return turn('Waiting for Techne.', [finish('early')]);}
    return turn('unexpected');
  }, async () => {await hold.wait; return turn('Built.', [finish('t')]);});
  try {
    const first = f.ensemble.dispatch('logox', 'Go', 'direct'); await first.done;
    assert.equal(f.store.activities.get('s', first.activityId)?.status, 'completed');
    assert.equal(f.requests.logox.length, 1);
    const receipt = (await f.journal.load('s', 'logox')).find(entry => entry.message?.role === 'tool' && entry.message.name === '_FinishRound');
    assert.equal(receipt?.message?.role === 'tool' && receipt.message.isError, false);
    assert.equal((await records(f)).length, 0);
  } finally {hold.open(); await f.cleanup();}
});

test('a human message while work is open joins the same round', async () => {
  const hold = gate();
  let techne: TaskHandle | undefined;
  const f = await fixture((_request, index) => {
    if (index === 1) {techne = f.ensemble.dispatch('techne', 'Build it', 'logox', {inputKind: 'director'}); return turn('Waiting.');}
    if (index === 2) return turn('Still running; I will report when it lands.');
    return index === 3 ? turn('All done.') : turn('', [finish('close', 'Joined round', 'Both messages handled.')]);
  }, async () => {await hold.wait; return turn('Built.', [finish('t')]);});
  try {
    const first = f.ensemble.dispatch('logox', 'Build', 'direct'); await first.done;
    const second = f.ensemble.dispatch('logox', 'How is it going?', 'direct'); await second.done;
    assert.equal(f.requests.logox.length, 2);
    assert.equal((await records(f)).length, 0);
    hold.open(); await techne!.done;
    await f.ensemble.dispatch('logox', 'Reports arrived', 'techne', {inputKind: 'actor'}).done;
    const entries = await f.journal.load('s', 'logox'), found = await records(f);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.start, 0); assert.equal(found[0]!.end, entries.length);
    assert.equal(entries.filter(entry => entry.role === 'user' && entry.roundId === first.activityId).length, 2);
  } finally {hold.open(); await f.cleanup();}
});

test('an interrupted open round closes as interrupted over the whole range', async () => {
  const hold = gate();
  const f = await fixture((_request, index, signal) => {
    if (index === 1) {f.ensemble.dispatch('techne', 'Build it', 'logox', {inputKind: 'director'}); return turn('Waiting.');}
    return new Promise<ModelTurn>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  }, async () => {await hold.wait; return turn('Built.');});
  try {
    const first = f.ensemble.dispatch('logox', 'Build', 'direct'); await first.done;
    const second = f.ensemble.dispatch('logox', 'Change of plan', 'direct');
    const deadline = Date.now() + 20000;
    while (f.requests.logox.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    f.ensemble.cancel(second.activityId); await second.done;
    const entries = await f.journal.load('s', 'logox'), found = await records(f);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.status, 'cancelled'); assert.equal(found[0]!.start, 0); assert.equal(found[0]!.end, entries.length);
    assert.ok(found[0]!.memory?.summary.startsWith('[interrupted]'));
  } finally {hold.open(); await f.cleanup();}
});

test('ordinals stay unique when an old-style record set is extended and a rewritten record keeps its number', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-round-ordinals-'));
  const journal = new Journal(join(cwd, 'sessions'));
  try {
    const user = (activityId: string, roundId?: string) => journal.append({version: 1, sessionId: 's', ownerId: 'logox', activityId, role: 'user', text: 'Input ' + activityId,
      message: {role: 'user', text: 'Input ' + activityId}, ...(roundId ? {roundId} : {})});
    const reply = (activityId: string) => journal.append({version: 1, sessionId: 's', ownerId: 'logox', activityId, role: 'assistant', text: 'Done ' + activityId, message: {role: 'assistant', text: 'Done ' + activityId}});
    for (const id of ['a', 'b']) {await user(id); await reply(id); await journal.finishRecord('s', 'logox', id, 'completed');}
    await user('c'); await reply('c');          // suspended round, no record
    await user('d', 'c'); await reply('d');     // continuation
    assert.equal(await journal.openRound('s', 'logox'), 'c');
    const closed = await journal.finishRecord('s', 'logox', 'd', 'completed');
    assert.equal(closed.activityId, 'c'); assert.equal(closed.ordinal, 3); assert.equal(closed.start, 4);
    assert.equal(await journal.openRound('s', 'logox'), undefined);
    await user('e'); await reply('e');
    assert.equal((await journal.finishRecord('s', 'logox', 'e', 'completed')).ordinal, 4);
    const again = await journal.finishRecord('s', 'logox', 'd', 'failed');
    assert.equal(again.ordinal, 3);
    const all = await journal.rounds('s', 'logox', await journal.load('s', 'logox'));
    assert.deepEqual(all.map(record => record.ordinal), [1, 2, 3, 4]);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('an idle companion woken by a same-root teammate message is absorbed; a different root gets a [reply] record', async () => {
  const f = await fixture(() => turn('unused'), (_request, index) => {
    if (index === 1) return turn('Built.', [finish('t1', 'Built the page', 'Wrote index.html.')]);
    return turn('Fine by me.', [finish('t' + index, 'IGNORED', 'IGNORED')]);
  });
  try {
    await f.ensemble.dispatch('techne', 'Build', 'logox', {inputKind: 'director', rootActivityId: 'root-1'}).done;
    const before = (await records(f, 'techne'))[0]!;
    const sent = f.requests.techne.length;
    await f.ensemble.dispatch('techne', '[Message from kalon · Palette note]\nUse teal.', 'kalon', {inputKind: 'collaboration', rootActivityId: 'root-1'}).done;
    assert.equal(f.requests.techne.length, sent + 1, 'no closing follow-up for an aside');
    let entries = await f.journal.load('s', 'techne'), found = await records(f, 'techne');
    assert.equal(found.length, 1);
    assert.equal(found[0]!.end, entries.length); assert.ok(found[0]!.end > before.end);
    assert.deepEqual(found[0]!.memory, before.memory); assert.equal(found[0]!.ordinal, before.ordinal);
    const receipt = entries.findLast(entry => entry.message?.role === 'tool' && entry.message.name === '_FinishRound');
    assert.equal(receipt?.message?.role === 'tool' && receipt.message.isError, false);

    await f.ensemble.dispatch('techne', '[Message from kalon · Other topic]\nQuestion.', 'kalon', {inputKind: 'collaboration', rootActivityId: 'root-2'}).done;
    entries = await f.journal.load('s', 'techne'); found = await records(f, 'techne');
    assert.equal(found.length, 2);
    assert.ok(found[1]!.memory?.summary.startsWith('[reply]')); assert.equal(found[1]!.memory?.title, 'Other topic');
    assert.equal(found[1]!.ordinal, 2); assert.equal(found[1]!.end, entries.length);
    assert.equal(found[1]!.start, found[0]!.end);
  } finally {await f.cleanup();}
});

test('an open suspended round survives a restart and is closed by the next Director activity', async () => {
  const hold = gate();
  const first = await fixture((_request, index) => {
    if (index === 1) {first.ensemble.dispatch('techne', 'Build it', 'logox', {inputKind: 'director'}); return turn('Waiting.');}
    return turn('unexpected');
  }, async () => {await hold.wait; return turn('Built.');});
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const opened = first.ensemble.dispatch('logox', 'Build', 'direct'); await opened.done;
    await first.close();
    second = await fixture((_request, index) => index === 1 ? turn('Resumed answer.') : turn('', [finish('close', 'After restart', 'Closed after restart.')]), () => turn('unused'), {cwd: first.cwd});
    assert.equal(await second.journal.openRound('s', 'logox'), opened.activityId);
    await second.ensemble.dispatch('logox', 'Reports arrived', 'techne', {inputKind: 'actor'}).done;
    const found = await records(second), entries = await second.journal.load('s', 'logox');
    assert.equal(found.length, 1); assert.equal(found[0]!.activityId, opened.activityId);
    assert.equal(found[0]!.start, 0); assert.equal(found[0]!.end, entries.length);
  } finally {hold.open(); await second?.cleanup(); await rm(first.cwd, {recursive: true, force: true});}
});
