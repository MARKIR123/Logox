import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {normalizeMessages, type ModelMessage} from '../src/runtime/messages.js';
import {ContextManager} from '../src/context/manager.js';
import {contextPolicySchema} from '../src/config/config.js';
import {digest} from '../src/context/budget.js';

async function memoryModule() {
  const path = '../src/context/round-memory.js';
  const value = await import(path).catch(() => undefined);
  assert.ok(value, 'Round memory formatting and replay must be implemented');
  return value;
}
async function toolModule() {
  const path = '../src/tools/_FinishRoundTool/_FinishRoundTool.js';
  const value = await import(path).catch(() => undefined);
  assert.ok(value, 'Internal finalization must have a strict schema and explicit policy');
  return value;
}
test('folding replaces human logs and Director assignments with exact indexes, not reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-index-projection-'));
  try {
    const journal = new Journal(root);
    const contexts = new ContextManager({journal, maxOutput: 512, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 1}),
      model: () => ({identity: 'fixture', window: 131072}), summarizer: () => {throw new Error('No summary request needed');}});
    for (const [ownerId, inputKind] of [['techne', 'director'], ['logox', 'human']] as const) {
      const identity = {version: 1 as const, sessionId: 's', ownerId, activityId: 'closed'};
      const put = async (message: ModelMessage) => journal.append({...identity, role: message.role, text: message.text, message});
      await journal.append({...identity, role: 'user', inputKind, text: 'Hypothesis: cache bug, not verified.\nPASTED_LOG '.repeat(800)});
      await put({role: 'assistant', text: '', toolCalls: [{id: 'read', name: 'Read', arguments: '{"file_path":"app.ts"}'}]});
      await put({role: 'tool', callId: 'read', name: 'Read', isError: false, text: 'Actual source evidence'});
      await put({role: 'assistant', text: 'FULL_TASK_REPORT '.repeat(500), toolCalls: [finalCall()]});
      await put({role: 'tool', callId: 'finish', name: '_FinishRound', text: '', isError: false});
      await journal.finishRecord('s', ownerId, 'closed', 'completed');
      await journal.append({...identity, activityId: 'open', role: 'user', inputKind: 'human', text: 'Current goal; do not write files. Prior cache hypothesis is unverified.'});
      const before = await readFile(journal.path('s', ownerId), 'utf8');
      const {request} = await contexts.prepare({sessionId: 's', ownerId}, {system: 'Execution rules', tools: []}, new AbortController().signal, true);
      const text = JSON.stringify(request.messages);
      assert.ok(!text.includes('PASTED_LOG') && !text.includes('FULL_TASK_REPORT') && !text.includes('_FinishRound'));
      assert.ok(request.messages.some(message => message.text === '1 | Fixed cancellation cleanup | Completed; Targeted tests passed | Windows integration unverified | 1:5'));
      assert.deepEqual(request.messages.filter(message => message.role === 'tool').map(message => message.callId), ['read']);
      assert.match(request.messages.findLast(message => message.role === 'user')!.text, /do not write files[\s\S]*unverified/);
      assert.ok(request.messages.some(message => message.role === 'context' && message.kind === 'ledger' && message.text.includes(journal.path('s', ownerId))));
      assert.ok(!text.includes('Round Summary') && !text.includes('轮次摘要') && !text.includes('<number>'));
      assert.equal(await readFile(journal.path('s', ownerId), 'utf8'), before);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test('injected user messages keep an unfinished activity intact across projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-open-projection-'));
  try {
    const journal = new Journal(root), identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'open'};
    await journal.append({...identity, role: 'user', inputKind: 'director', text: 'Current assignment: investigate only'});
    await journal.append({...identity, role: 'assistant', text: 'Confirmed effect: read app.ts. Blocker: missing fixture. Next: request evidence.\n' + 'In-progress evidence '.repeat(500)});
    await journal.append({...identity, role: 'user', inputKind: 'collaboration', source: 'logox', text: 'Permission revoked: no shell commands'});
    const contexts = new ContextManager({journal, maxOutput: 512, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0}),
      model: () => ({identity: 'fixture', window: 131072}), summarizer: () => {throw new Error('No summary request needed');}});
    const {request} = await contexts.prepare(identity, {system: '', tools: []}, new AbortController().signal, true);
    assert.equal(request.messages.length, 3);
    assert.ok(request.messages.some(message => message.text.includes('Current assignment')));
    assert.ok(request.messages.some(message => message.text.includes('Confirmed effect') && message.text.includes('Blocker') && message.text.includes('Next:')));
    assert.match(request.messages.at(-1)!.text, /Permission revoked/);
    assert.ok(!request.messages.some(message => /^\d+ \|/.test(message.text)));
  } finally {await rm(root, {recursive: true, force: true});}
});

test('missing finalizer and unsuccessful plain-text correction retain material constraints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-pending-memory-'));
  try {
    const journal = new Journal(root), identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'closed'};
    await journal.append({...identity, role: 'user', inputKind: 'director', text: 'Original assignment ' + 'Material data '.repeat(1000) + '\nKeep pending issue A and full artifact references'});
    await journal.append({...identity, role: 'assistant', text: 'Answer: ' + 'Full result detail '.repeat(1000) + '\nUnverified work B remains'});
    await journal.append({...identity, role: 'assistant', text: 'Unable to provide metadata', message: {role: 'assistant', text: 'Unable to provide metadata', memoryOnly: true}});
    await journal.finishRecord('s', 'techne', 'closed', 'completed');
    await journal.append({...identity, activityId: 'open', role: 'user', text: 'Continue'});
    const before = await readFile(journal.path('s', 'techne'), 'utf8');
    const contexts = new ContextManager({journal, maxOutput: 512, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0}),
      model: () => ({identity: 'fixture', window: 131072}), summarizer: () => {throw new Error('No trustworthy overview available');}});
    const {request} = await contexts.prepare(identity, {system: '', tools: []}, new AbortController().signal, true);
    const text = JSON.stringify(request.messages);
    assert.ok(text.includes('Keep pending issue A and full artifact references'));
    assert.ok(text.includes('Unverified work B remains'));
    assert.ok(!text.includes('Unable to provide metadata'));
    assert.equal(await readFile(journal.path('s', 'techne'), 'utf8'), before);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('validated legacy sidecars beginning at injected input retain completed status after restart and rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-legacy-injection-'));
  try {
    const journal = new Journal(root), identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'a'};
    await journal.append({...identity, role: 'user', inputKind: 'director', text: 'Original assignment'});
    await journal.append({...identity, role: 'assistant', text: 'Work'});
    await journal.append({...identity, role: 'user', inputKind: 'collaboration', text: 'Extra evidence'});
    await journal.append({...identity, role: 'assistant', text: '[Round Summary]\nTitle: Legacy done\nReport:\nLegacy report'});
    const entries = await journal.load('s', 'techne');
    await writeFile(journal.path('s', 'techne') + '.rounds.json', JSON.stringify([{activityId: 'a', start: 2, end: 4, sourceHash: digest(entries.slice(2, 4)), status: 'completed', summary: {title: 'Legacy done', report: 'Legacy report', source: 'model'}}]));
    const verify = async () => {
      const restored = new Journal(root);
      assert.equal((await restored.rounds('s', 'techne', await restored.load('s', 'techne'))).length, 1);
      const contexts = new ContextManager({journal: restored, maxOutput: 512, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0}),
        model: () => ({identity: 'fixture', window: 131072}), summarizer: () => {throw new Error('No summary request needed');}});
      const {request} = await contexts.prepare(identity, {system: '', tools: []}, new AbortController().signal, true);
      assert.ok(request.messages.some(message => /^1 \| Legacy done \| Completed \|.*\| 1:4$/.test(message.text)), JSON.stringify(request.messages));
      assert.ok(!request.messages.some(message => message.text.includes('| Failed')));
    };
    await verify();
    await journal.append({...identity, activityId: 'b', role: 'user', text: 'Next assignment'});
    await verify();
    const before = await readFile(journal.path('s', 'techne'), 'utf8');
    await journal.fork('s', ['techne'], ['b']);
    await verify();
    assert.equal(await readFile(journal.path('s', 'techne'), 'utf8'), before);
  } finally {await rm(root, {recursive: true, force: true});}
});

const finalCall = (id = 'finish') => ({id, name: '_FinishRound', arguments: JSON.stringify({title: 'Fixed cancellation cleanup', verification: 'Targeted tests passed', carry_forward: ['Windows integration unverified']})});

test('round indexes use five compact fields and keep an empty carry-forward column', async () => {
  const {formatRoundIndex} = await memoryModule();
  assert.equal(formatRoundIndex({ordinal: 42, title: 'Fixed cancellation cleanup', status: 'completed', verification: 'targeted tests passed', carryForward: ['Windows integration unverified'], start: 120, end: 158}),
    '42 | Fixed cancellation cleanup | Completed; targeted tests passed | Windows integration unverified | 120:158');
  assert.equal(formatRoundIndex({ordinal: 43, title: 'Explained actor model selection', status: 'completed', verification: null, carryForward: [], start: 159, end: 172}),
    '43 | Explained actor model selection | Completed || 159:172');
  const sanitized = formatRoundIndex({ordinal: 1, title: 'First\nSecond|Third', status: 'cancelled', verification: null, carryForward: ['Blocker\r\ncontinued|detail'], start: 1, end: 2});
  assert.equal(sanitized, '1 | First Second/Third | Cancelled | Blocker continued/detail | 1:2');
  assert.equal(sanitized.split('|').length, 5);
  assert.throws(() => formatRoundIndex({ordinal: 0, title: 'Bad range', status: 'failed', verification: null, carryForward: [], start: 3, end: 2}));
});

test('finalization accepts semantic metadata, not model-owned runtime facts', async () => {
  const {finishRoundSchema, finishRoundTool, finishRoundPolicy} = await toolModule();
  const metadata = {title: 'Explained tools', verification: null, carry_forward: []};
  assert.deepEqual(finishRoundSchema.parse(metadata), metadata);
  for (const extra of [{status: 'completed'}, {ordinal: 3}, {start: 4}, {end: 7}]) assert.equal(finishRoundSchema.safeParse({...metadata, ...extra}).success, false);
  for (const invalid of [{...metadata, title: ' '}, {...metadata, title: 'x'.repeat(121)}, {...metadata, carry_forward: [' ']}, {...metadata, verification: 'x'.repeat(241)}, {...metadata, carry_forward: Array(9).fill('item')}]) {
    assert.equal(finishRoundSchema.safeParse(invalid).success, false);
  }
  assert.equal(finishRoundTool.name, '_FinishRound');
  assert.equal(finishRoundPolicy.terminal, true);
  assert.equal(finishRoundPolicy.replay, 'omit-pair');
});

test('replay omits internal pairs without losing normal text, business calls or signatures', async () => {
  const {omitInternalToolPairs} = await memoryModule();
  const messages: ModelMessage[] = [
    {role: 'user', text: 'Inspect the source'},
    {role: 'assistant', text: 'Visible answer', reasoning: 'preserved protocol reasoning', signature: 'signature', toolCalls: [
      {id: 'read', name: 'Read', arguments: '{"file_path":"app.ts"}'}, finalCall(),
    ]},
    {role: 'tool', callId: 'read', name: 'Read', text: 'Source content', isError: false},
    {role: 'tool', callId: 'finish', name: '_FinishRound', text: '', isError: false},
    {role: 'assistant', text: '', toolCalls: [finalCall('empty')]},
    {role: 'tool', callId: 'empty', name: '_FinishRound', text: 'Invalid metadata', isError: true},
  ];
  const original = JSON.stringify(messages);
  const projected = normalizeMessages(omitInternalToolPairs(messages));
  assert.equal(projected.length, 3);
  assert.deepEqual(projected[1], {...messages[1], toolCalls: [{id: 'read', name: 'Read', arguments: '{"file_path":"app.ts"}'}]});
  assert.deepEqual(projected[2], messages[2]);
  assert.equal(JSON.stringify(messages), original);
  assert.ok(!JSON.stringify(projected).includes('_FinishRound'));
  const correction = omitInternalToolPairs(messages, new Set(['empty']));
  assert.ok(correction.some((message: ModelMessage) => message.role === 'tool' && message.callId === 'empty'));
  assert.ok(!correction.some((message: ModelMessage) => message.role === 'tool' && message.callId === 'finish'));
});

test('durable closure covers the whole activity and stores report separately from memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-round-memory-'));
  try {
    const journal = new Journal(root) as Journal & {finishRecord(session: string, owner: string, activity: string, status: string): Promise<any>};
    assert.equal(typeof journal.finishRecord, 'function', 'Journal needs typed durable round closure');
    const identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'a'};
    await journal.append({...identity, role: 'user', inputKind: 'director', source: 'logox', text: 'Original assignment'});
    await journal.append({...identity, role: 'assistant', text: 'Working on the assignment'});
    await journal.append({...identity, role: 'user', inputKind: 'collaboration', source: 'logox', text: 'Additional evidence'});
    const report = 'Outcome: completed\nDeliverables: src/app.ts\nVerification: targeted tests passed\nOpen Items: Windows unverified\n' + 'Evidence details. '.repeat(200);
    const message = {role: 'assistant' as const, text: report, toolCalls: [finalCall()]};
    await journal.append({...identity, role: 'assistant', text: report, message});
    await journal.append({...identity, role: 'tool', text: '', message: {role: 'tool', name: '_FinishRound', callId: 'finish', text: '', isError: false}});
    const before = await readFile(journal.path('s', 'techne'), 'utf8');
    const record = await journal.finishRecord('s', 'techne', 'a', 'completed');
    assert.equal(record.start, 0);
    assert.equal(record.ordinal, 1);
    assert.deepEqual(record.sourceLines, {start: 1, end: 5});
    assert.deepEqual(record.memory, {title: 'Fixed cancellation cleanup', verification: 'Targeted tests passed', carryForward: ['Windows integration unverified'], source: 'model'});
    assert.ok(record.delivery);
    assert.equal(record.delivery.text, report, 'A full report is not truncated to the legacy summary limit');
    assert.equal(record.delivery.title, 'Outcome: completed', 'Report presentation does not expose private memory metadata');
    assert.equal((await journal.finishRecord('s', 'techne', 'a', 'completed')).ordinal, 1);
    const entries = await journal.load('s', 'techne');
    assert.equal((await journal.rounds('s', 'techne', entries)).length, 1);
    assert.equal(await readFile(journal.path('s', 'techne'), 'utf8'), before);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('ordinals and physical lines survive rollback, restart and a failed readable mirror', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-round-lines-'));
  try {
    await writeFile(join(root, 's'), 'Block the optional session mirror');
    const journal = new Journal(root) as Journal & {finishRecord(session: string, owner: string, activity: string, status: string): Promise<any>};
    assert.equal(typeof journal.finishRecord, 'function', 'Journal needs typed durable round closure');
    for (const activityId of ['first', 'second', 'third']) {
      const identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId};
      await journal.append({...identity, role: 'user', inputKind: 'human', source: 'direct', text: 'Human request'});
      await journal.append({...identity, role: 'assistant', text: 'Normal answer', message: {role: 'assistant', text: 'Normal answer', toolCalls: [finalCall(activityId)]}});
      await journal.append({...identity, role: 'tool', text: '', message: {role: 'tool', name: '_FinishRound', callId: activityId, text: '', isError: false}});
      const record = await journal.finishRecord('s', 'techne', activityId, 'completed');
      assert.equal(record.delivery, undefined, 'Human requests do not create Director reports');
    }
    const before = await readFile(journal.path('s', 'techne'), 'utf8');
    await journal.fork('s', ['techne'], ['second']);
    const restored = new Journal(root) as typeof journal;
    const third = await restored.finishRecord('s', 'techne', 'third', 'completed');
    assert.equal(third.ordinal, 3);
    assert.deepEqual(third.sourceLines, {start: 7, end: 9});
    assert.equal(await readFile(journal.path('s', 'techne'), 'utf8'), before);
  } finally {await rm(root, {recursive: true, force: true});}
});
