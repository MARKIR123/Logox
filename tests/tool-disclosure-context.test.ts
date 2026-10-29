import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {ContextManager} from '../src/context/manager.js';
import {contextPolicySchema} from '../src/config/config.js';
import {estimateRequest, TokenMeter} from '../src/context/budget.js';
import {createRuntimeContextMessage, type ExecutionEnvironment} from '../src/runtime/context-updates.js';
import type {ModelMessage, ModelRequest} from '../src/runtime/messages.js';
import {extractDiscoveredToolNames, collectDiscoveredTools, retainDiscoveryPairs} from '../src/tools/discovery.js';
import {agentRequestBase} from '../src/kernel/agent.js';
import {Resources} from '../src/resources/manager.js';
import {ToolRegistry} from '../src/tools/registry.js';
import {encodeOpenAIToolSearchResult} from '../src/providers/disclosure/openai.js';

const identity = {sessionId: 's', ownerId: 'logox'};
const signal = new AbortController().signal;
const environment: ExecutionEnvironment = {model: 'fixture', effort: 'medium', permission: 'review', directory: '/project', scratchpad: '/scratch', rules: 'v1', services: []};
const base: ModelRequest = {system: 'Stable rules and original environment.', tools: [
  {name: 'LoadTools', description: 'Load contracts', parameters: {type: 'object'}},
  ...['A', 'B'].map(name => ({name, description: 'Selected contract ' + name, parameters: {type: 'object', properties: {value: {type: 'string', description: name.repeat(800)}}}, deferLoading: true as const})),
], messages: [], toolDiscovery: 'openai-responses'};
async function fixture(high = 8000) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-disclosure-context-'));
  const journal = new Journal(directory);
  const options = {journal, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0, max_budget_tokens: high, target_budget_tokens: 1000}),
    model: () => ({identity: 'fixture', window: 131072}), maxOutput: 1024,
    summarizer: () => ({model: {identity: 'summary', window: 131072}, provider: {respond: async () => ({message: {role: 'assistant' as const, text: 'Historical results retained; no new authorization.'}, stop: 'complete' as const})}})};
  return {directory, journal, options, contexts: new ContextManager(options),
    async append(activityId: string, message: ModelMessage, owner = 'logox') {
      await journal.append({version: 1, sessionId: 's', ownerId: owner, activityId, role: message.role, text: message.text, message});
    }, async cleanup() {await rm(directory, {recursive: true, force: true});}};
}
async function discover(f: Awaited<ReturnType<typeof fixture>>, activity: string, name: string) {
  await f.append(activity, {role: 'assistant', text: '', toolCalls: [{id: 'load-' + name, name: 'LoadTools', kind: 'tool-search', arguments: JSON.stringify({names: [name]})}]});
  await f.append(activity, {role: 'tool', name: 'LoadTools', callId: 'load-' + name, text: 'Loaded ' + name + '.'.repeat(2000), isError: false, discoveredTools: [name]});
}
function assertOriginalPairs(messages: readonly ModelMessage[], names = ['A', 'B']) {
  for (const name of names) {
    const call = messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []).find(call => call.id === 'load-' + name);
    assert.equal(call?.arguments, JSON.stringify({names: [name]}), 'Original discovery arguments survive, not archive placeholders');
    const result = messages.find(message => message.role === 'tool' && message.callId === call?.id);
    assert.ok(result?.role === 'tool' && !result.isError && result.discoveredTools?.includes(name));
    const wire = encodeOpenAIToolSearchResult(call!.id, [name], base.tools);
    assert.equal(wire.call_id, 'load-' + name);
    assert.ok((wire.tools as Array<{parameters: {properties: unknown}}>)[0]?.parameters.properties);
  }
  assert.ok(!messages.some(message => message.role === 'tool' && message.name === '_FinishRound'));
}

test('closed compaction and cold resume retain all original discovery pairs and environment snapshots without modifying ledgers', async () => {
  const f = await fixture();
  try {
    await f.append('a', {role: 'user', text: 'Load A'});
    await f.append('a', createRuntimeContextMessage('environment-baseline', 'Initial boundary', environment));
    await discover(f, 'a', 'A');
    await f.append('a', {role: 'assistant', text: 'Evidence A '.repeat(3000)});
    await f.journal.finish('s', 'logox', 'a', 'completed');
    await f.append('b', {role: 'user', text: 'Load B'});
    await f.append('b', createRuntimeContextMessage('environment-change', 'Permission changed', {...environment, permission: 'creative'}));
    await discover(f, 'b', 'B');
    await f.append('b', {role: 'assistant', text: 'Evidence B '.repeat(3000)});
    await f.journal.finish('s', 'logox', 'b', 'completed');
    await f.append('c', {role: 'user', text: 'Use A without another search'});
    const raw = await readFile(f.journal.path('s', 'logox'), 'utf8');
    const first = await f.contexts.prepare(identity, base, signal, true);
    assertOriginalPairs(first.request.messages);
    const state = await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox'));
    assert.deepEqual((state as any)?.discoveredTools, ['A', 'B']);
    assert.deepEqual((state as any)?.environmentBaseline, environment);
    assert.equal((state as any)?.environmentCurrent.permission, 'creative');
    assert.equal(state?.archives.length, 0, 'Discovery contracts must not be archived');
    assert.ok(first.request.messages.some(message => message.role === 'context' && message.kind === 'environment-change' && message.text.includes('creative')));
    const restored = await new ContextManager(f.options).prepare(identity, base, signal);
    assertOriginalPairs(restored.request.messages);
    assert.deepEqual(restored.request.messages, first.request.messages);
    assert.equal(await readFile(f.journal.path('s', 'logox'), 'utf8'), raw);
    assert.ok(state);
    const {discoveredTools: _names, environmentBaseline: _baseline, environmentCurrent: _current, ...legacy} = state;
    await f.journal.saveContext(legacy);
    assert.ok(await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox')), 'Version-1 side state without snapshots remains readable');
    await f.journal.saveContext({...state, discoveredTools: ['A', 'B', 'NotInLedger']});
    assert.equal(await f.journal.loadContext('s', 'logox', await f.journal.load('s', 'logox')), undefined, 'Snapshots are checked against their authoritative source prefix');
    const entries = await f.journal.load('s', 'logox');
    await f.journal.saveContext({...state, memo: {end: entries.findIndex(entry => entry.activityId === 'c'), text: 'Merged historical outcomes, not authorization.'}});
    const merged = await new ContextManager(f.options).prepare(identity, base, signal);
    assertOriginalPairs(merged.request.messages);
    await f.journal.fork('s', ['logox'], ['b', 'c']);
    const branch = await new ContextManager(f.options).prepare(identity, base, signal, true);
    assert.deepEqual([...extractDiscoveredToolNames(branch.request.messages)], ['A']);
    assert.ok(!branch.request.messages.some(message => message.role === 'context' && message.data?.permission === 'creative'));
    assertOriginalPairs(branch.request.messages, ['A']);
    const clean = await f.contexts.prepare({...identity, ownerId: 'custom'}, base, signal);
    assert.deepEqual([...extractDiscoveredToolNames(clean.request.messages)], []);
    const newSession = await f.contexts.prepare({...identity, sessionId: 'new'}, base, signal);
    assert.deepEqual([...extractDiscoveredToolNames(newSession.request.messages)], []);
  } finally {await f.cleanup();}
});

test('working-history compaction retains discovery identities and a complete latest environment before subsequent progress', async () => {
  const f = await fixture(5000);
  try {
    await f.append('active', {role: 'user', text: 'Continue the current task'});
    await f.append('active', createRuntimeContextMessage('environment-baseline', 'Initial boundary', environment));
    await discover(f, 'active', 'A');
    await f.append('active', createRuntimeContextMessage('environment-change', 'Working directory changed', {...environment, directory: '/next'}));
    await f.append('active', {role: 'assistant', text: 'Old verbose process '.repeat(6000)});
    await f.append('active', createRuntimeContextMessage('environment-change', 'Permission changed', {...environment, directory: '/next', permission: 'creative'}));
    await f.append('active', {role: 'assistant', text: '', toolCalls: [{id: 'recent', name: 'Read', arguments: '{}'}]});
    await f.append('active', {role: 'tool', name: 'Read', callId: 'recent', text: 'Current evidence', isError: false});
    const {request} = await f.contexts.prepare({...identity, activityId: 'active'}, base, signal, true);
    assertOriginalPairs(request.messages, ['A']);
    const latest = request.messages.findLast(message => message.role === 'context' && message.kind === 'environment-change');
    assert.match(latest?.text ?? '', /Working directory: \/next/);
    assert.match(latest?.text ?? '', /creative/);
    assert.equal(request.messages.filter(message => message.role === 'user')[0]?.text, 'Continue the current task');
    assert.ok(request.messages.some(message => message.role === 'tool' && message.callId === 'recent'));
  } finally {await f.cleanup();}
});

test('orphan discovery metadata cannot expose a native contract, while real evidence survives current removal', async () => {
  const f = await fixture();
  try {
    const registry = new ToolRegistry(f.directory, f.directory), resources = new Resources(f.directory, {home: f.directory, boundary: f.directory});
    await resources.reload();
    const result: ModelMessage = {role: 'tool', name: 'LoadTools', callId: 'original', text: 'Loaded', isError: false, discoveredTools: ['_GitStatus']};
    const capabilities = {toolDiscovery: 'anthropic' as const, runtimeInstructions: 'meta-user' as const, caching: 'anthropic' as const};
    const orphan = await agentRequestBase(f.directory, 'logox', [], resources, undefined, true, undefined, undefined, registry, {capabilities, history: [result]});
    assert.ok(!orphan.tools.some(tool => tool.name === '_GitStatus'), 'A carried name is not an original search pair');
    const history: ModelMessage[] = [{role: 'assistant', text: '', toolCalls: [{id: 'original', name: 'LoadTools', arguments: '{"names":["_GitStatus"]}'}]}, result];
    const loaded = await agentRequestBase(f.directory, 'logox', [], resources, undefined, true, undefined, undefined, registry, {capabilities, history});
    assert.ok(loaded.tools.some(tool => tool.name === '_GitStatus'));
    const legal = loaded.tools.filter(tool => tool.name !== '_GitStatus');
    assert.deepEqual(encodeOpenAIToolSearchResult('original', ['_GitStatus'], legal).tools, []);
    assert.deepEqual(collectDiscoveredTools(history, ['B', 'A', 'B']), ['A', 'B', '_GitStatus']);
    assert.equal(retainDiscoveryPairs([...history, ...history.map(message => message.role === 'assistant' ? {...message, toolCalls: message.toolCalls?.map(call => ({...call, id: 'redundant'}))} : message.role === 'tool' ? {...message, callId: 'redundant'} : message)], new Set(['_GitStatus'])).length, 2);
  } finally {await f.cleanup();}
});

test('native token estimation counts only eager and actually expanded contracts once', () => {
  const eager = {name: 'LoadTools', description: 'Load', parameters: {type: 'object'}};
  const deferred = {name: 'A', description: 'Full schema '.repeat(2000), parameters: {type: 'object'}, deferLoading: true as const};
  const cold: ModelRequest = {system: '', tools: [eager], messages: [], toolDiscovery: 'anthropic'};
  assert.equal(estimateRequest({...cold, tools: [eager, deferred]}), estimateRequest(cold), 'Undiscovered deferred definitions are not inline input');
  const messages: ModelMessage[] = [{role: 'assistant', text: '', toolCalls: [{id: 'real', name: 'LoadTools', arguments: '{"names":["A"]}'}]},
    {role: 'tool', callId: 'real', name: 'LoadTools', text: 'Loaded A', isError: false, discoveredTools: ['A']}];
  const once = estimateRequest({...cold, tools: [eager, deferred], messages});
  const {deferLoading: _, ...expanded} = deferred;
  const inline = estimateRequest({...cold, tools: [eager, expanded], messages});
  assert.equal(once, inline, 'A selected definition is charged once, not both declaration and inline contract');
  assert.ok(once > estimateRequest({...cold, messages}) + 5000);
  const meter = new TokenMeter(), model = {identity: 'fixture', window: 131072};
  const answer = {role: 'assistant' as const, text: 'Done'};
  meter.observe(cold, {message: answer, stop: 'complete', usage: {input: 200, output: 5}}, model);
  const changed: ModelRequest = {...cold, messages: [answer], toolDiscovery: 'openai-responses'};
  assert.equal(meter.estimate(changed, model), estimateRequest(changed), 'A different native rendering cannot reuse the old token anchor');
});
