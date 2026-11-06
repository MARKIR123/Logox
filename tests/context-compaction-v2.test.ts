import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {ContextManager} from '../src/context/manager.js';
import {watermarks} from '../src/context/budget.js';
import {contextPolicySchema, loadConfig} from '../src/config/config.js';
import type {ModelMessage, ModelRequest, Provider} from '../src/runtime/messages.js';
import {createTestApplication} from './runtime-fixture.js';

test('the high watermark is the larger of window minus reserve and a share of the window', () => {
  const policy = contextPolicySchema.parse({});
  assert.equal(watermarks({identity: 'm', window: 1_000_000}, policy).high, 1_000_000 - 32768, 'large windows keep the reserve');
  assert.equal(watermarks({identity: 'm', window: 32768}, policy).high, Math.floor(32768 * 0.8), 'small windows keep a usable share');
  assert.equal(watermarks({identity: 'm', window: 1_000_000}, contextPolicySchema.parse({max_budget_tokens: 200_000})).high, 200_000, 'an explicit budget still caps it');
});

const ROUNDS = 16;
const finish = (index: number) => ({id: 'finish-' + index, name: '_FinishRound', arguments: JSON.stringify({
  title: 'Round ' + index + ' work', outcome: 'Outcome of round ' + index + ' '.padEnd(560, 'o'), verification: 'Checked ' + index,
  carry_forward: Array.from({length: 8}, (_, item) => 'Open item ' + item + ' '.padEnd(200, 'x'))})});

async function history() {
  const root = await mkdtemp(join(tmpdir(), 'logox-compaction-v2-'));
  const journal = new Journal(root);
  const id = (activityId: string) => ({version: 1 as const, sessionId: 's', ownerId: 'techne', activityId});
  const put = (activityId: string, message: ModelMessage) => journal.append({...id(activityId), role: message.role, text: message.text, message});
  for (let index = 1; index <= ROUNDS; index++) {
    const activityId = 'round-' + index;
    await journal.append({...id(activityId), role: 'user', inputKind: 'human', text: 'Task ' + index});
    await put(activityId, {role: 'assistant', text: 'Done ' + index, toolCalls: [finish(index)]});
    await put(activityId, {role: 'tool', callId: 'finish-' + index, name: '_FinishRound', text: '', isError: false});
    await journal.finishRecord('s', 'techne', activityId, 'completed');
  }
  await journal.append({...id('open'), role: 'user', inputKind: 'human', text: 'Current task'});
  await put('open', {role: 'assistant', text: '', reasoning: 'OLD_THINKING', signature: 'old-signature', toolCalls: [{id: 'read', name: 'Read', arguments: '{"file_path":"a.ts"}'}]});
  await put('open', {role: 'tool', callId: 'read', name: 'Read', text: 'source', isError: false});
  return {root, journal, put};
}

test('older rounds become an overview written at the end of the real conversation; the newest index lines stay', async () => {
  const f = await history();
  const summaries: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    summaries.push(request);
    return {message: {role: 'assistant', text: 'OVERVIEW of the early rounds'}, stop: 'complete'};
  }};
  const model = {identity: 'fixture', window: 16384};
  const contexts = new ContextManager({journal: f.journal, maxOutput: 512, model: () => model, summarizer: () => ({model, provider}),
    policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0, keep_index_lines: 2})});
  try {
    const base = {system: 'Execution rules', tools: []};
    const {request} = await contexts.prepare({sessionId: 's', ownerId: 'techne', activityId: 'open'}, base, new AbortController().signal, true);
    assert.equal(summaries.length, 1);
    const summary = summaries[0]!;
    assert.equal(summary.system, base.system, 'same system prompt as the task, so the prefix is shared');
    assert.equal(summary.messages[0]?.role === 'user' && summary.messages[0].text.includes('Task 1'), true, 'the prefix is the uncompacted conversation');
    assert.match(summary.messages.at(-1)!.role === 'user' ? summary.messages.at(-1)!.text : '', /up to and including round 14[\s\S]*Do not call tools/);
    const texts = request.messages.map(message => message.text);
    assert.ok(texts.some(text => text.includes('OVERVIEW of the early rounds')));
    for (const kept of [15, 16]) assert.ok(texts.some(text => text.startsWith(kept + ' | Round ' + kept + ' work | Completed; Checked ' + kept + ' | Outcome of round ' + kept)), 'round ' + kept + ' keeps its index line');
    assert.ok(!texts.some(text => /^3 \| /.test(text)), 'older index lines are inside the overview');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('thinking from before a compaction is not sent again; thinking produced after it is', async () => {
  const f = await history();
  const model = {identity: 'fixture', window: 16384};
  const provider: Provider = {async respond() { return {message: {role: 'assistant', text: 'OVERVIEW'}, stop: 'complete'}; }};
  const contexts = new ContextManager({journal: f.journal, maxOutput: 512, model: () => model, summarizer: () => ({model, provider}),
    policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 2, keep_index_lines: 2})});
  try {
    const identity = {sessionId: 's', ownerId: 'techne', activityId: 'open'}, base = {system: 'rules', tools: []}, signal = new AbortController().signal;
    const thinking = (request: ModelRequest) => request.messages.flatMap(message => message.role === 'assistant' && message.reasoning ? [message.reasoning] : []);
    const first = await contexts.prepare(identity, base, signal, true);
    assert.equal(first.compacted, true);
    assert.deepEqual(thinking(first.request), [], 'the current task\'s earlier thinking was bound to the replaced history');
    assert.ok(first.request.messages.some(message => message.role === 'assistant' && message.toolCalls?.some(call => call.id === 'read')), 'its tool calls stay');
    await f.put('open', {role: 'assistant', text: '', reasoning: 'NEW_THINKING', signature: 'new-signature', toolCalls: [{id: 'read-2', name: 'Read', arguments: '{"file_path":"b.ts"}'}]});
    await f.put('open', {role: 'tool', callId: 'read-2', name: 'Read', text: 'more source', isError: false});
    const second = await contexts.prepare(identity, base, signal);
    assert.equal(second.compacted, false);
    assert.deepEqual(thinking(second.request), ['NEW_THINKING']);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('/rewind names each round by its _FinishRound title and outcome', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-rewind-title-')));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const app = await createTestApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json'), sessionId: 'first', config,
    provider: {async respond() { return {message: {role: 'assistant', text: 'ok'}, stop: 'complete'}; }}});
  try {
    const add = async (activityId: string, text: string, memory?: {title: string; outcome: string}) => {
      const id = {version: 1 as const, sessionId: 'first', ownerId: 'logox', activityId};
      await app.journal.append({...id, role: 'user', inputKind: 'human', text, time: Date.now(), message: {role: 'user', text}});
      const call = memory ? [{id: 'f-' + activityId, name: '_FinishRound', arguments: JSON.stringify({...memory, verification: null, carry_forward: []})}] : undefined;
      await app.journal.append({...id, role: 'assistant', text: 'answer', message: {role: 'assistant', text: 'answer', ...(call ? {toolCalls: call} : {})}});
      if (call) await app.journal.append({...id, role: 'tool', text: '', message: {role: 'tool', callId: call[0]!.id, name: '_FinishRound', text: '', isError: false}});
      await app.journal.finishRecord('first', 'logox', activityId, 'completed');
    };
    await add('titled', '帮我看看这个缓存为什么不命中，顺便', {title: 'Explained the cache miss', outcome: 'Snapshot moved behind the cache boundary'});
    await add('plain', 'An older round without memory');
    await app.submit('/rewind');
    const picker = app.surfaces.getSnapshot();
    assert.ok(picker?.kind === 'picker' && picker.status === 'ready');
    const titled = picker.items.find(item => item.id === 'titled')!, plain = picker.items.find(item => item.id === 'plain')!;
    assert.match(titled.label, /^\d+\. Explained the cache miss$/);
    assert.match(titled.description ?? '', /Snapshot moved behind the cache boundary/);
    assert.match(plain.label, /An older round without memory/, 'rounds without memory fall back to the input');
    app.surfaces.cancel();
  } finally { await app.close(); await rm(cwd, {recursive: true, force: true}); }
});

test('compaction is bracketed by the compacting hook, which closes even when the summary fails', async () => {
  const f = await history();
  const events: string[] = [];
  const provider: Provider = {async respond() { throw new Error('summary unavailable'); }};
  const model = {identity: 'fixture', window: 16384};
  const contexts = new ContextManager({journal: f.journal, maxOutput: 512, model: () => model, summarizer: () => ({model, provider}),
    compacting: (identity, active) => events.push(identity.activityId + ':' + active),
    policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0, keep_index_lines: 2})});
  try {
    await contexts.prepare({sessionId: 's', ownerId: 'techne', activityId: 'open'}, {system: 'rules', tools: []}, new AbortController().signal, true).catch(() => undefined);
    assert.deepEqual(events, ['open:true', 'open:false']);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});
