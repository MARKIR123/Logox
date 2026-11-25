import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {withoutSynopses} from '../src/context/round-memory.js';
import {ROUND_SYNOPSIS_CONTRACT} from '../src/prompts/charter.js';
import {createApplication as production} from '../src/application.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows, synopsisFoldId} from '../src/tui/timeline/stage.js';
import type {ModelMessage, ModelRequest, Provider} from '../src/runtime/messages.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';

const ANSWER = 'The wheels now sit on the ground line; all four phases checked in the browser.';
const SYNOPSIS = '<synopsis title="Wheel alignment">\nAligned both wheels to y=610 in pelican-bike.html; verified 4 phases; nothing open.\n</synopsis>';

test('a reply ending with a synopsis closes the round with no further request, and later requests never carry the block', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-synopsis-app-'));
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    requests.push(request);
    return {message: {role: 'assistant', text: requests.length === 1 ? ANSWER + '\n\n' + SYNOPSIS : 'Second answer.'}, stop: 'complete'};
  }};
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'syn', config, provider, env: {}, authPath: join(cwd, 'auth.json')});
  try {
    await app.ensemble.dispatch('logox', 'Fix the wheels').done;
    assert.equal(requests.length, 1, 'no closing follow-up: the synopsis is the round memory');
    assert.ok(!requests[0]!.tools.some(tool => tool.name === '_FinishRound'), '_FinishRound is not offered');
    assert.ok(requests[0]!.system.includes(ROUND_SYNOPSIS_CONTRACT.trim()) && !requests[0]!.system.includes('_FinishRound'));
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
    assert.equal(requests.length, 2);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('a reply that is only the status line and a synopsis keeps the line as its answer and the synopsis as its memory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-synopsis-line-'));
  const seen: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    seen.push(request);
    return {message: {role: 'assistant', text: '⏵ Checked the wheel alignment\n\n' + SYNOPSIS}, stop: 'complete'};
  }};
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await production({cwd, sessionId: 's', config, env: {}, provider, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    await app.ensemble.dispatch('logox', 'Check the wheels').done;
    assert.equal(seen.length, 1, 'the synopsis is there: no follow-up');
    const record = await app.journal.lastRound('s', 'logox');
    assert.equal(record?.memory?.title, 'Wheel alignment');
    assert.equal(record?.summary.report, 'Checked the wheel alignment');
    const rows = buildStageRows(app.store.getSnapshot(), 's', 'logox', 90, {}, null).map(row => row.text).join('\n');
    assert.ok(rows.includes('Checked the wheel alignment') && rows.includes('▸ Synopsis · Wheel alignment') && !rows.includes('<synopsis'));
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
    const record = await journal.finishRecord('s', 'techne', 'task', 'completed');
    assert.equal(record.delivery?.text, ANSWER);
    assert.equal(record.delivery?.title, 'Wheel alignment');
    assert.equal(record.memory!.source, 'model');

    // A reply that is only a synopsis delivers nothing itself: the report is the last text before it.
    const next = {...identity, activityId: 'task2'};
    await journal.append({...next, role: 'user', inputKind: 'director', text: 'Check again.'});
    await journal.append({...next, role: 'assistant', text: ANSWER, message: {role: 'assistant', text: ANSWER, toolCalls: [{id: 'read', name: 'Read', arguments: '{}'}]}});
    await journal.append({...next, role: 'tool', text: 'ok', message: {role: 'tool', callId: 'read', name: 'Read', isError: false, text: 'ok'}});
    await journal.append({...next, role: 'assistant', text: SYNOPSIS, message: {role: 'assistant', text: SYNOPSIS}});
    const only = await journal.finishRecord('s', 'techne', 'task2', 'completed');
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

test('a follow-up that repeats the answer shows only its synopsis, before and after a restart, and no later request carries either', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-synopsis-repair-'));
  const seen: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    seen.push(request);
    const text = seen.length === 1 ? 'Normal answer' : seen.length === 2 ? 'PRIVATE_REPAIR_TEXT\n\n<synopsis title="Folded title">\nPRIVATE_SUMMARY\n</synopsis>' : 'Next answer';
    return {message: {role: 'assistant', text}, stop: 'complete'};
  }};
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  // The plain production application: no fixture appends synopses, so the first reply really lacks one.
  const options = {cwd, sessionId: 's', config, env: {}, provider, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}};
  let app = await production(options);
  try {
    const first = app.ensemble.dispatch('techne', 'Explain', 'direct', {inputKind: 'human'});
    await first.done;
    assert.equal(seen.length, 2, 'one follow-up for the missing synopsis');
    assert.ok((await readFile(app.journal.path('s', 'techne'), 'utf8')).includes('PRIVATE_REPAIR_TEXT'), 'the ledger keeps the follow-up as written');
    const rows = () => ['logox', 'techne'].map(view => buildStageRows(app.store.getSnapshot(), 's', view, 90, {[first.activityId]: true}, null).map(row => row.text).join('\n'));
    for (const text of rows()) assert.ok(!text.includes('PRIVATE_REPAIR_TEXT') && !text.includes('PRIVATE_SUMMARY') && !text.includes('<synopsis'));
    assert.ok(rows()[1]!.includes('Normal answer') && rows()[1]!.includes('▸ Synopsis · Folded title'));
    await app.close(); app = await production(options);
    assert.equal(seen.length, 2, 'a restart requests no model');
    for (const text of rows()) assert.ok(!text.includes('PRIVATE_REPAIR_TEXT') && !text.includes('PRIVATE_SUMMARY'));
    assert.ok(rows()[1]!.includes('▸ Synopsis · Folded title'), 'the restored follow-up synopsis still folds under the answer');
    await app.ensemble.dispatch('techne', 'Continue', 'direct', {inputKind: 'human'}).done;
    const history = JSON.stringify(seen[2]!.messages);
    assert.ok(history.includes('T1|Folded title|PRIVATE_SUMMARY|'), 'the closed round is its index line: the synopsis is the memory'); assert.ok(!history.includes('PRIVATE_REPAIR_TEXT') && !history.includes('<synopsis') && !history.includes('Round closure'));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('a session written with the retired _FinishRound restores with its calls, results and follow-ups hidden, and never sends them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-synopsis-legacy-'));
  const seen: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {seen.push(request); return {message: {role: 'assistant', text: 'Fresh answer'}, stop: 'complete'};}};
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const options = {cwd, sessionId: 's', config, env: {}, provider, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}};
  let app = await createApplication(options);
  try {
    const identity = {version: 1 as const, sessionId: 's', ownerId: 'logox', activityId: 'old'};
    const put = (message: ModelMessage) => app.journal.append({...identity, role: message.role, text: message.text, message});
    await app.journal.append({...identity, role: 'user', inputKind: 'human', text: 'Old question'});
    await put({role: 'assistant', text: 'Old answer'});
    await put({role: 'context', kind: 'finalizer', text: '# Round closure\nReply with one _FinishRound call.'} as ModelMessage);
    await put({role: 'assistant', text: 'OLD_REPAIR_TEXT', memoryOnly: true, toolCalls: [{id: 'old-finish', name: '_FinishRound', arguments: '{"title":"Old","summary":"OLD_SUMMARY"}'}]});
    await put({role: 'tool', callId: 'old-finish', name: '_FinishRound', text: '', isError: false});
    await app.close(); app = await createApplication(options);
    const rows = buildStageRows(app.store.getSnapshot(), 's', 'logox', 90, {}, null).map(row => row.text).join('\n');
    assert.ok(rows.includes('Old answer') && !rows.includes('_FinishRound') && !rows.includes('OLD_REPAIR_TEXT'));
    await app.ensemble.dispatch('logox', 'New question').done;
    const history = JSON.stringify(seen[0]!.messages);
    assert.ok(history.includes('Old answer'));
    assert.ok(!history.includes('_FinishRound') && !history.includes('OLD_REPAIR_TEXT') && !history.includes('OLD_SUMMARY') && !history.includes('Round closure'));
    assert.ok(!seen[0]!.tools.some(tool => tool.name === '_FinishRound'));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
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
