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
  const path = '../src/tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
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
      assert.ok(request.messages.some(message => message.text === 'T1|Fixed cancellation cleanup|Round outcome.|1-5'));
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
    assert.ok(!request.messages.some(message => /^T\d+\|/.test(message.text)));
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
      assert.ok(request.messages.some(message => /^T1\|Legacy done\|.*\|1-4$/.test(message.text)), JSON.stringify(request.messages));
      assert.ok(!request.messages.some(message => message.text.includes('[failed]')));
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

const finalCall = (id = 'finish') => ({id, name: '_FinishRound', arguments: JSON.stringify({title: 'Fixed cancellation cleanup', summary: 'Round outcome.'})});

test('round indexes use four compact columns and sanitise separators', async () => {
  const {formatRoundIndex} = await memoryModule();
  assert.equal(formatRoundIndex({ordinal: 42, title: 'Fixed cancellation cleanup', summary: 'Release now waits for exit; tests passed', start: 120, end: 158}),
    'T42|Fixed cancellation cleanup|Release now waits for exit; tests passed|120-158');
  const sanitized = formatRoundIndex({ordinal: 1, title: 'First\nSecond|Third', summary: '[interrupted] Blocker\r\ncontinued|detail', start: 1, end: 2});
  assert.equal(sanitized, 'T1|First Second/Third|[interrupted] Blocker continued/detail|1-2');
  assert.equal(sanitized.split('|').length, 4);
  assert.throws(() => formatRoundIndex({ordinal: 0, title: 'Bad range', summary: 'x', start: 3, end: 2}));
});

test('token-budget truncation counts non-ASCII as 1 and ASCII as 0.25 and never exceeds the budget', async () => {
  const {truncateToTokens, estimateText} = await import('../src/context/budget.js');
  assert.equal(truncateToTokens('  short text  ', 30), 'short text');
  const chinese = truncateToTokens('这是一个很长的标题'.repeat(10), 30);
  assert.ok(estimateText(chinese) <= 30 && chinese.endsWith('…'));
  assert.equal([...chinese].length, 30, 'about one token per Chinese character: 29 characters plus the ellipsis');
  const english = truncateToTokens('word '.repeat(100), 30);
  assert.ok(estimateText(english) <= 30 && english.endsWith('…'));
  assert.ok([...english].length > 100, 'ASCII text keeps roughly four characters per token');
  assert.equal(truncateToTokens('漢'.repeat(30), 30), '漢'.repeat(30), 'exactly on budget stays whole');
  assert.equal(truncateToTokens('x'.repeat(10), 0), '…');
  const astral = truncateToTokens('😀'.repeat(50), 10);
  assert.ok(estimateText(astral) <= 10 && !/[�-�](?![�-�])|(?<![�-�])[�-�]/.test(astral), 'surrogate pairs are never split');
});

test('finalization accepts title and summary and ignores everything else', async () => {
  const {finishRoundSchema, finishRoundTool, finishRoundPolicy} = await toolModule();
  const {normalizeFinishRound} = await memoryModule();
  const metadata = {title: 'Explained tools', summary: 'Round outcome.'};
  assert.deepEqual(finishRoundSchema.parse(metadata), metadata);
  assert.deepEqual(finishRoundSchema.parse({...metadata, status: 'completed', ordinal: 3}), metadata, 'unknown fields are ignored');
  assert.equal(finishRoundSchema.safeParse({title: ' ', summary: 'x'}).success, false);
  assert.equal(finishRoundSchema.safeParse({title: 'No summary'}).success, false);
  assert.deepEqual(normalizeFinishRound(JSON.stringify({summary: 'Only a summary', extra: 1}), 'Stage line'), {title: 'Stage line', summary: 'Only a summary'});
  assert.deepEqual(normalizeFinishRound(JSON.stringify({summary: 'Only a summary'})), {title: 'Round', summary: 'Only a summary'});
  assert.equal(normalizeFinishRound(JSON.stringify({title: 'No summary', summary: '  '})), undefined);
  assert.equal(normalizeFinishRound('{"title":'), undefined);
  assert.equal(normalizeFinishRound('[1]'), undefined);
  assert.deepEqual(normalizeFinishRound(JSON.stringify({title: 'Legacy', outcome: 'Did X.', verification: 'Tests passed', carry_forward: ['Y remains', ' ']})),
    {title: 'Legacy', summary: 'Did X.; Tests passed; Y remains'});
  assert.deepEqual(normalizeFinishRound(JSON.stringify({title: 'Legacy', outcome: 'Did X.', verification: null, carry_forward: []})), {title: 'Legacy', summary: 'Did X.'});
  assert.match(finishRoundTool.description, /files involved/);
  assert.doesNotMatch(finishRoundTool.description + JSON.stringify(finishRoundTool.parameters), /English/);
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
    assert.deepEqual(record.memory, {title: 'Fixed cancellation cleanup', summary: 'Round outcome.', source: 'model'});
    assert.ok(record.delivery);
    assert.equal(record.delivery.text, report, 'A full report is not truncated to the legacy summary limit');
    assert.equal(record.delivery.title, 'Fixed cancellation cleanup', 'The report is titled by the _FinishRound title, not by its first text line');
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

test('the round title is the _FinishRound title, never a stage line or a parenthetical aside from the reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-round-title-'));
  try {
    const journal = new Journal(root);
    for (const [activityId, reply] of [['a', '(closes the test log) Tests pass.'], ['b', 'Tests pass and the page is ready.']] as const) {
      const identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId};
      await journal.append({...identity, role: 'user', inputKind: 'director', text: 'Fix it'});
      await journal.append({...identity, role: 'assistant', text: reply, message: {role: 'assistant', text: reply, toolCalls: [finalCall()]}});
      await journal.append({...identity, role: 'tool', text: '', message: {role: 'tool', callId: 'finish', name: '_FinishRound', text: '', isError: false}});
      const record = await journal.finishRecord('s', 'techne', activityId, 'completed');
      assert.equal(record.summary.title, 'Fixed cancellation cleanup');
      assert.equal(record.delivery?.title, 'Fixed cancellation cleanup');
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test('a record saved with outcome, verification and carryForward still loads and renders as one summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-legacy-memory-'));
  try {
    const journal = new Journal(root), identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'closed'};
    await journal.append({...identity, role: 'user', inputKind: 'director', text: 'Fix it'});
    await journal.append({...identity, role: 'assistant', text: 'Done', message: {role: 'assistant', text: 'Done', toolCalls: [finalCall()]}});
    await journal.append({...identity, role: 'tool', text: '', message: {role: 'tool', callId: 'finish', name: '_FinishRound', text: '', isError: false}});
    await journal.finishRecord('s', 'techne', 'closed', 'completed');
    const file = journal.path('s', 'techne') + '.rounds.json';
    const saved = JSON.parse(await readFile(file, 'utf8')) as Array<{memory: unknown}>;
    saved[0]!.memory = {title: 'Old title', outcome: 'Fixed cleanup.', verification: 'Targeted tests passed', carryForward: ['Windows unverified', 'Docs pending'], source: 'model'};
    await writeFile(file, JSON.stringify(saved));
    await journal.append({...identity, activityId: 'open', role: 'user', text: 'Continue'});
    const before = await readFile(file, 'utf8');
    const entries = await journal.load('s', 'techne');
    assert.deepEqual((await journal.rounds('s', 'techne', entries))[0]!.memory,
      {title: 'Old title', summary: 'Fixed cleanup.; Targeted tests passed; Windows unverified; Docs pending', source: 'model'});
    const contexts = new ContextManager({journal, maxOutput: 512, policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 0}),
      model: () => ({identity: 'fixture', window: 131072}), summarizer: () => {throw new Error('No summary request needed');}});
    const {request} = await contexts.prepare({sessionId: 's', ownerId: 'techne', activityId: 'open'}, {system: '', tools: []}, new AbortController().signal, true);
    assert.ok(request.messages.some(message => message.text === 'T1|Old title|Fixed cleanup.; Targeted tests passed; Windows unverified; Docs pending|1-3'), JSON.stringify(request.messages));
    assert.equal(await readFile(file, 'utf8'), before, 'old files are never rewritten by reading');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('runtime-written rounds open with [interrupted], [failed] or [runtime] and list only ledger facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-runtime-markers-'));
  try {
    const journal = new Journal(root);
    const write = async (activityId: string, status: 'completed' | 'failed' | 'cancelled', work: boolean) => {
      const identity = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId};
      const put = async (message: ModelMessage) => journal.append({...identity, role: message.role, text: message.text, message});
      await journal.append({...identity, role: 'user', inputKind: 'human', text: 'Work'});
      if (work) {
        await put({role: 'assistant', text: '', toolCalls: [
          {id: 'w1', name: 'Write', arguments: JSON.stringify({file_path: 'src/a.ts', content: 'x'})},
          {id: 'e1', name: 'Edit', arguments: JSON.stringify({file_path: 'src/b.ts', old_string: 'a', new_string: 'b'})},
          {id: 'e2', name: 'Edit', arguments: JSON.stringify({file_path: 'src/failed.ts', old_string: 'a', new_string: 'b'})},
          {id: 's1', name: 'Shell', arguments: JSON.stringify({command: 'npm test'})},
        ]});
        await put({role: 'tool', callId: 'w1', name: 'Write', text: 'ok', isError: false});
        await put({role: 'tool', callId: 'e1', name: 'Edit', text: 'ok', isError: false});
        await put({role: 'tool', callId: 'e2', name: 'Edit', text: 'no match', isError: true});
        await put({role: 'tool', callId: 's1', name: 'Shell', text: 'Exit code: 1\nfailing', isError: true});
      }
      await put({role: 'assistant', text: 'Answer', ...(status === 'completed' ? {memoryOnly: true as const} : {})});
      return journal.finishRecord('s', 'techne', activityId, status, null);
    };
    const interrupted = await write('i', 'cancelled', true), failed = await write('f', 'failed', false), runtime = await write('r', 'completed', true);
    assert.equal(interrupted.memory?.source, 'runtime');
    assert.equal(interrupted.memory?.summary, '[interrupted] Changed src/a.ts, src/b.ts. Last command "npm test" exit 1.');
    assert.equal(failed.memory?.summary, '[failed] Ended with an error.');
    assert.equal(runtime.memory?.summary, '[runtime] Changed src/a.ts, src/b.ts. Last command "npm test" exit 1.');
    const {runtimeRoundSummary} = await memoryModule();
    assert.match(runtimeRoundSummary([{role: 'user', text: 'x'}], 'completed'), /^\[runtime\] The model gave no round summary\.$/);
    const {estimateText} = await import('../src/context/budget.js');
    const many: ModelMessage[] = [{role: 'assistant', text: '', toolCalls: Array.from({length: 40}, (_, index) => ({id: 'c' + index, name: 'Write', arguments: JSON.stringify({file_path: 'src/very/long/path/file-' + index + '.ts', content: ''})}))},
      ...Array.from({length: 40}, (_, index): ModelMessage => ({role: 'tool', callId: 'c' + index, name: 'Write', text: 'ok', isError: false}))];
    assert.ok(estimateText(runtimeRoundSummary(many, 'completed')) <= 200);
  } finally {await rm(root, {recursive: true, force: true});}
});
