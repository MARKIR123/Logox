import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {withoutSynopses} from '../src/context/round-memory.js';
import {agentRequestBase} from '../src/kernel/agent.js';
import {ROUND_SUMMARY_CONTRACT, ROUND_SYNOPSIS_CONTRACT} from '../src/prompts/charter.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows, synopsisFoldId} from '../src/tui/timeline/stage.js';
import type {ModelMessage, ModelRequest, Provider} from '../src/runtime/messages.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';

const ANSWER = 'The wheels now sit on the ground line; all four phases checked in the browser.';
const SYNOPSIS = '<synopsis title="Wheel alignment">\nAligned both wheels to y=610 in pelican-bike.html; verified 4 phases; nothing open.\n</synopsis>';

test('in synopsis mode a reply ending with a synopsis closes the round with no further request, and later requests never carry the block', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-synopsis-app-'));
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    requests.push(request);
    return {message: {role: 'assistant', text: requests.length === 1 ? ANSWER + '\n\n' + SYNOPSIS : 'Second answer.'}, stop: 'complete'};
  }};
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}, context: {round_memory: 'synopsis'}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'syn', config, provider, env: {}, authPath: join(cwd, 'auth.json')});
  try {
    await app.ensemble.dispatch('logox', 'Fix the wheels').done;
    assert.equal(requests.length, 1, 'no closing follow-up: the synopsis is the round memory');
    assert.ok(!requests[0]!.tools.some(tool => tool.name === '_FinishRound'), '_FinishRound is not offered');
    assert.ok(requests[0]!.system.includes(ROUND_SYNOPSIS_CONTRACT.trim()) && !requests[0]!.system.includes('call _FinishRound in the same reply'));
    const record = await app.journal.lastRound('syn', 'logox');
    assert.ok(record);
    assert.deepEqual({title: record.memory!.title, summary: record.memory!.summary, source: record.memory!.source},
      {title: 'Wheel alignment', summary: 'Aligned both wheels to y=610 in pelican-bike.html; verified 4 phases; nothing open.', source: 'model'});
    assert.equal(record.summary.title, 'Wheel alignment');
    assert.equal(record.summary.report, ANSWER, 'the report is the answer without the block');
    const raw = (await app.journal.load('syn', 'logox')).findLast(entry => entry.role === 'assistant');
    assert.ok(raw?.text.endsWith('</synopsis>'), 'the ledger keeps the reply exactly as written');

    await app.ensemble.dispatch('logox', 'And now?').done;
    const history = JSON.stringify(requests[1]!.messages);
    assert.ok(history.includes(ANSWER) && !history.includes('<synopsis') && !history.includes('verified 4 phases'), 'the next request carries the answer, never the block');
    const second = await app.journal.lastRound('syn', 'logox');
    assert.equal(second?.memory!.source, 'runtime', 'a reply without a synopsis gets a runtime-written record');
    assert.equal(requests.length, 2, 'and still no follow-up request');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('in synopsis mode a _FinishRound call out of habit beside the answer ends the round without a follow-up', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-synopsis-habit-'));
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    requests.push(request);
    return {message: {role: 'assistant', text: ANSWER + '\n\n' + SYNOPSIS, toolCalls: [{id: 'finish', name: '_FinishRound', arguments: '{"title":"t","summary":"s"}'}]}, stop: 'tools'};
  }};
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}, context: {round_memory: 'synopsis'}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'habit', config, provider, env: {}, authPath: join(cwd, 'auth.json')});
  try {
    await app.ensemble.dispatch('logox', 'Fix the wheels').done;
    assert.equal(requests.length, 1, 'no follow-up asking for a tool that is not offered');
    const record = await app.journal.lastRound('habit', 'logox');
    assert.equal(record?.memory!.title, 'Wheel alignment', 'the synopsis is the memory, not the stray call');
    const entries = await app.journal.load('habit', 'logox');
    assert.ok(entries.some(entry => entry.role === 'tool' && entry.message?.role === 'tool' && entry.message.callId === 'finish'), 'the stray call is answered, so the ledger stays paired');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('a companion report delivered to the Director carries the answer without the synopsis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-synopsis-journal-'));
  try {
    const journal = new Journal(root);
    const identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'task'};
    const put = async (message: ModelMessage) => journal.append({...identity, role: message.role, text: message.text, message});
    await journal.append({...identity, role: 'user', inputKind: 'director', text: 'Fix the wheels.'});
    await put({role: 'assistant', text: '', toolCalls: [{id: 'edit', name: 'Edit', arguments: '{"file_path":"pelican-bike.html"}'}]});
    await put({role: 'tool', callId: 'edit', name: 'Edit', isError: false, text: 'ok'});
    await put({role: 'assistant', text: '⏵ Reporting\n' + ANSWER + '\n\n' + SYNOPSIS});
    const record = await journal.finishRecord('s', 'techne', 'task', 'completed', null);
    assert.equal(record.delivery?.text, ANSWER);
    assert.equal(record.delivery?.title, 'Wheel alignment');
    assert.equal(record.memory!.source, 'model');

    // A reply that is only a synopsis delivers nothing itself: the report is the last text before it.
    const next = {...identity, activityId: 'task2'};
    await journal.append({...next, role: 'user', inputKind: 'director', text: 'Check again.'});
    await journal.append({...next, role: 'assistant', text: ANSWER, message: {role: 'assistant', text: ANSWER, toolCalls: [{id: 'read', name: 'Read', arguments: '{}'}]}});
    await journal.append({...next, role: 'tool', text: 'ok', message: {role: 'tool', callId: 'read', name: 'Read', isError: false, text: 'ok'}});
    await journal.append({...next, role: 'assistant', text: SYNOPSIS, message: {role: 'assistant', text: SYNOPSIS}});
    const only = await journal.finishRecord('s', 'techne', 'task2', 'completed', null);
    assert.equal(only.delivery?.text, ANSWER);
    assert.equal(only.memory!.title, 'Wheel alignment');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('history projection drops synopses and a reply left empty, keeping tool calls', () => {
  const messages: ModelMessage[] = [
    {role: 'assistant', text: ANSWER + '\n' + SYNOPSIS},
    {role: 'assistant', text: SYNOPSIS},
    {role: 'assistant', text: SYNOPSIS, toolCalls: [{id: 'x', name: 'Read', arguments: '{}'}]},
    {role: 'assistant', text: 'Quoted `<synopsis>` stays.'},
    {role: 'user', text: SYNOPSIS},
  ];
  assert.deepEqual(withoutSynopses(messages), [
    {role: 'assistant', text: ANSWER},
    {role: 'assistant', text: '', toolCalls: [{id: 'x', name: 'Read', arguments: '{}'}]},
    {role: 'assistant', text: 'Quoted `<synopsis>` stays.'},
    {role: 'user', text: SYNOPSIS},
  ]);
});

test('the round-memory mode chooses the contract and whether _FinishRound is offered', async () => {
  const tool = await agentRequestBase('.', 'techne');
  assert.ok(tool.system.includes(ROUND_SUMMARY_CONTRACT.trim()) && tool.tools.some(item => item.name === '_FinishRound'));
  const synopsis = await agentRequestBase('.', 'techne', [], undefined, undefined, true, undefined, undefined, undefined, undefined, undefined, 'synopsis');
  assert.ok(synopsis.system.includes(ROUND_SYNOPSIS_CONTRACT.trim()) && !synopsis.tools.some(item => item.name === '_FinishRound'));
  assert.ok(!synopsis.system.includes('call _FinishRound'));
});

test('the timeline folds a synopsis under the reply and opens it on demand', () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', ANSWER + '\n\n' + SYNOPSIS);
  const text = (folds: Record<string, boolean>) => buildStageRows(store.getSnapshot(), 's', 'logox', 100, folds, null).map(row => row.text).join('\n');
  const folded = text({});
  assert.ok(folded.includes('The wheels now sit on the ground line'));
  assert.match(folded, /▸ Synopsis · Wheel alignment/);
  assert.ok(!folded.includes('<synopsis') && !folded.includes('verified 4 phases'), 'folded: neither the tag nor the summary shows');
  const opened = text({[synopsisFoldId(id)]: true});
  assert.match(opened, /▾ Synopsis · Wheel alignment/);
  assert.ok(opened.includes('verified 4 phases') && !opened.includes('<synopsis'));
  // While the block streams in, the reply shows only its answer.
  store.updateMessage(id, {text: ANSWER + '\n\n<synop'});
  const streaming = text({});
  assert.ok(streaming.includes('The wheels now sit') && !streaming.includes('<synop'));
});
