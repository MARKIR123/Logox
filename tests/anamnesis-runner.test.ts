import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorModelStorage} from '../src/actors/actor-models-storage.js';
import {MemoryStore} from '../src/anamnesis/memory.js';
import {anamnesisModel, bindAnamnesisModel, noUsableModel, resolveModel, type ResolvedModel} from '../src/anamnesis/model.js';
import {DREAM_SYSTEM_PROMPT, RECAP_SYSTEM_PROMPT} from '../src/anamnesis/prompts.js';
import {AnamnesisRunner, dreamMessage, recapMessage, splitRecap} from '../src/anamnesis/runner.js';
import type {RunContext} from '../src/anamnesis/service.js';
import {ARGUMENT_CAP, DREAM_TRANSCRIPT_CAP, ERROR_CAP, MESSAGE_CAP, OMITTED_MARKER, RECAP_TRANSCRIPT_CAP, argumentSummary, buildTranscript, hasNewMaterial, marksOf} from '../src/anamnesis/transcript.js';
import {WatermarkStore} from '../src/anamnesis/watermark.js';
import {loadConfig} from '../src/config/config.js';
import {AuthStorage} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {Journal, type HistoryEntry} from '../src/store/journal.js';

const SESSION = 's1';
let clock = 0;
const base = (ownerId: string) => ({version: 1 as const, sessionId: SESSION, ownerId, time: ++clock * 1000});
const human = (owner: string, text: string, time?: number): HistoryEntry => ({...base(owner), ...(time !== undefined ? {time} : {}), role: 'user', text, inputKind: 'human'});
const said = (owner: string, text: string, time?: number): HistoryEntry => ({...base(owner), ...(time !== undefined ? {time} : {}), role: 'assistant', text, message: {role: 'assistant', text}});
const untimed = (entry: HistoryEntry): HistoryEntry => {const {time: _time, ...rest} = entry; return rest;};
const calling = (owner: string, name: string, args: unknown, text = ''): HistoryEntry => ({...base(owner), role: 'assistant', text,
  message: {role: 'assistant', text, toolCalls: [{id: 'c-' + clock, name, arguments: JSON.stringify(args)}]}});
const result = (owner: string, name: string, text: string, isError = false): HistoryEntry => ({...base(owner), role: 'tool', text,
  message: {role: 'tool', text, callId: 'c', name, isError}});

test('the transcript keeps what people said and what was answered; tools collapse to one line, results show only errors, injected entries are left out', () => {
  const owners = [{ownerId: 'logox', entries: [
    human('logox', 'Please fix the parser.'),
    {...base('logox'), role: 'user' as const, text: '[Actor report] done', inputKind: 'actor' as const},
    {...base('logox'), role: 'user' as const, text: '[Director assignment] go', inputKind: 'director' as const},
    {...base('logox'), role: 'context' as const, text: 'Reminder: be brief', message: {role: 'context' as const, kind: 'reminder' as const, text: 'Reminder: be brief'}},
    said('logox', '⏵ Looking at the parser\nThe parser lives in src/parse.ts.'),
    calling('logox', 'Read', {file_path: 'src/parse.ts', offset: 1}),
    result('logox', 'Read', 'file contents that must not appear'),
    calling('logox', 'Shell', {command: 'npm   test\n-- --watch'}),
    result('logox', 'Shell', 'x'.repeat(500), true),
    calling('logox', '_FinishRound', {title: 'internal', summary: 'internal'}),
    {...base('logox'), role: 'assistant' as const, text: 'call(Read)', message: {role: 'assistant' as const, text: 'call(Read)', textToolCall: true as const}},
    said('logox', 'Fixed.'),
  ]}];
  const lines = buildTranscript(owners, {}, DREAM_TRANSCRIPT_CAP).split('\n');
  assert.deepEqual(lines.slice(0, 3), ['[logox · user] Please fix the parser.', '[logox · assistant] The parser lives in src/parse.ts.', '[logox · tool] Read src/parse.ts']);
  assert.equal(lines[3], '[logox · tool] Shell npm test -- --watch');
  assert.equal(lines[4], '[logox · tool error] ' + 'x'.repeat(ERROR_CAP) + '…');
  assert.equal(lines[5], '[logox · assistant] Fixed.');
  assert.equal(lines.length, 6, lines.join('\n'));
});

test('caps: a message is cut at 2000 characters with a marker, an argument at 120, the whole transcript keeps its newest part and says so', () => {
  const long = buildTranscript([{ownerId: 'logox', entries: [human('logox', 'a'.repeat(5000))]}], {}, DREAM_TRANSCRIPT_CAP);
  assert.equal(long, '[logox · user] ' + 'a'.repeat(MESSAGE_CAP) + ' […]');
  const summary = argumentSummary(JSON.stringify({command: 'echo ' + 'b'.repeat(400)}));
  assert.ok(summary.length <= ARGUMENT_CAP + 1 && summary.endsWith('…'), summary.length + ' chars');
  assert.equal(argumentSummary(JSON.stringify({unknown: 1, other: 'x'})), '{"unknown":1,"other":"x"}');
  assert.equal(argumentSummary('not json at all'), 'not json at all');
  const entries = Array.from({length: 40}, (_, index) => human('logox', 'm' + String(index).padStart(2, '0') + ' ' + 'z'.repeat(996)));
  const cut = buildTranscript([{ownerId: 'logox', entries}], {}, 10_000).split('\n');
  assert.equal(cut[0], OMITTED_MARKER);
  assert.ok(cut.length > 2 && cut.length < 12, 'about ten of forty lines remain');
  assert.match(cut.at(-1)!, /^\[logox · user\] m39 /);
  assert.ok(cut.slice(1).every((line, index, all) => index === 0 || line > all[index - 1]!), 'oldest to newest');
  assert.ok(cut.slice(1).join('\n').length <= 10_000);
  const whole = buildTranscript([{ownerId: 'logox', entries: entries.slice(0, 5)}], {}, 10_000);
  assert.ok(!whole.includes(OMITTED_MARKER), 'nothing cut, no marker');
  assert.equal(RECAP_TRANSCRIPT_CAP, 16_000);
  assert.equal(DREAM_TRANSCRIPT_CAP, 60_000);
});

test('owners merge by time; an entry without a time follows its predecessor; marks skip what a run already covered', () => {
  const owners = [
    {ownerId: 'logox', entries: [human('logox', 'one', 1000), said('logox', 'three', 3000), said('logox', 'four', 4000)]},
    {ownerId: 'techne', entries: [said('techne', 'two', 2000), untimed(said('techne', 'two-b'))]},
  ];
  assert.deepEqual(buildTranscript(owners, {}, 10_000).split('\n'), ['[logox · user] one', '[techne · assistant] two', '[techne · assistant] two-b', '[logox · assistant] three', '[logox · assistant] four']);
  assert.deepEqual(buildTranscript(owners, {logox: 2, techne: 1}, 10_000).split('\n'), ['[techne · assistant] two-b', '[logox · assistant] four']);
  assert.equal(buildTranscript(owners, {logox: 99, techne: 99}, 10_000), '', 'a mark past the end (after a rewind) covers everything');
  assert.deepEqual(marksOf(owners), {logox: 3, techne: 2});
});

test('new material means a human message or an assistant text beyond the mark; tool steps and injected notes do not count', () => {
  const owners = [{ownerId: 'logox', entries: [human('logox', 'hello'), said('logox', 'hi'), calling('logox', 'Read', {file_path: 'a'}), result('logox', 'Read', 'x', true),
    {...base('logox'), role: 'user' as const, text: '[Actor report]', inputKind: 'actor' as const}]}];
  assert.equal(hasNewMaterial(owners, {}), true);
  assert.equal(hasNewMaterial(owners, {logox: 2}), false);
  assert.equal(hasNewMaterial([{ownerId: 'logox', entries: [...owners[0]!.entries, human('logox', 'more')]}], {logox: 5}), true);
  assert.equal(hasNewMaterial([], {}), false);
});

interface Rig {
  root: string; journal: Journal; memory: MemoryStore; watermarks: WatermarkStore; requests: ModelRequest[]; charged: {usage: ModelTurn['usage']; identity: string}[];
  answer: {text: string; wait?: Promise<void>};
  runner(): AnamnesisRunner;
  context(kind: 'recap' | 'dream', signal?: AbortSignal): RunContext;
  close(): Promise<void>;
}
async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'logox-anamnesis-'));
  const journal = new Journal(join(root, 'sessions')), memory = new MemoryStore(join(root, 'project'), join(root, 'home'));
  const watermarks = new WatermarkStore(join(root, 'sessions', SESSION));
  const requests: ModelRequest[] = [], charged: Rig['charged'] = [], answer: Rig['answer'] = {text: ''};
  const provider: Provider = {async respond(request, _delta, signal) {
    requests.push(request);
    if (answer.wait) await Promise.race([answer.wait, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}))]);
    signal.throwIfAborted();
    return {message: {role: 'assistant', text: answer.text}, stop: 'complete', usage: {input: 120, output: 30}};
  }};
  const model: ResolvedModel = {provider: 'p', model: 'm', inherited: true, respond: provider, identity: JSON.stringify(['p', 'm'])};
  return {root, journal, memory, watermarks, requests, charged, answer,
    runner: () => new AnamnesisRunner({sessionId: SESSION, cwd: root, journal, owners: async () => ['logox', 'techne'], memory, watermarks, model: async () => model,
      charge: (usage, identity) => {charged.push({usage, identity});}, gitStatus: async () => 'Branch main (clean working tree)', today: () => '2026-11-14'}),
    context: (kind, signal = new AbortController().signal) => ({runId: 'r', sessionId: SESSION, kind, manual: false, signal, report() {}}),
    close: () => rm(root, {recursive: true, force: true})};
}

test('a dream reads only what is beyond its watermark, applies the answer, and a restart does not review the same material again', async () => {
  const r = await rig();
  try {
    for (const entry of [human('logox', 'Remember that I work in Python notebooks.'), said('logox', 'Noted.'), said('techne', 'Unrelated report')]) await r.journal.append(entry);
    assert.equal(await r.runner().material('dream'), true);
    r.answer.text = '```json\n' + JSON.stringify({operations: [{op: 'save', scope: 'user', type: 'user', name: 'notebooks', description: 'The user works in Python notebooks', content: 'Quote: "I work in Python notebooks."'}]}) + '\n```';
    const outcome = await r.runner().run(r.context('dream'));
    assert.equal(outcome.stage, 'Saved 1 memory record');
    assert.equal(outcome.detail, "Remembered in your memory (all projects)\n• notebooks (about you): The user works in Python notebooks");
    assert.equal(outcome.empty, false);
    assert.deepEqual((await r.memory.list()).map(record => record.scope + '/' + record.name), ['user/notebooks']);
    const request = r.requests[0]!;
    assert.equal(request.system, DREAM_SYSTEM_PROMPT);
    assert.deepEqual(request.tools, []);
    assert.equal(request.maxTokens, 4000);
    assert.equal(request.thinking, false);
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0]!.role, 'user');
    assert.equal(request.messages[0]!.text, dreamMessage('2026-11-14', [], '[logox · user] Remember that I work in Python notebooks.\n[logox · assistant] Noted.\n[techne · assistant] Unrelated report'));
    assert.deepEqual(r.charged, [{usage: {input: 120, output: 30}, identity: '["p","m"]'}]);
    assert.deepEqual(JSON.parse(await readFile(join(r.root, 'sessions', SESSION, 'anamnesis.json'), 'utf8')), {version: 1, recap: {}, dream: {logox: 2, techne: 1}});

    // A new process: new objects over the same files.
    const restarted = new WatermarkStore(join(r.root, 'sessions', SESSION));
    const again = new AnamnesisRunner({sessionId: SESSION, cwd: r.root, journal: new Journal(join(r.root, 'sessions')), owners: async () => ['logox', 'techne'],
      memory: r.memory, watermarks: restarted, model: async () => {throw new Error('no model request expected');}, charge() {}});
    assert.equal(await again.material('dream'), false, 'nothing new since the dream');
    assert.equal(await again.material('recap'), true, 'the recap has its own watermark');
    await r.journal.append(calling('logox', 'Read', {file_path: 'a'}));
    assert.equal(await again.material('dream'), false, 'a tool step is not material');
    await r.journal.append(said('logox', 'A later answer'));
    assert.equal(await again.material('dream'), true);
    r.answer.text = '{"operations": []}';
    r.requests.length = 0;
    const second = await r.runner().run(r.context('dream'));
    assert.equal(second.empty, true);
    assert.equal(second.stage, 'Nothing new to remember');
    assert.match(r.requests[0]!.messages[0]!.text, /^Today: 2026-11-14\n\nCurrent memory records:\n## user\/notebooks \(user\)\nThe user works in Python notebooks\nQuote: "I work in Python notebooks\."\n\nUnreviewed transcript:\n\[logox · tool\] Read a\n\[logox · assistant\] A later answer$/);
  } finally {await r.close();}
});

test('a dream whose answer cannot be read fails and leaves memory and the watermark alone; an abort applies nothing', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'Something worth keeping'));
    r.answer.text = 'I could not decide.';
    await assert.rejects(r.runner().run(r.context('dream')), /could not read the dream answer/);
    assert.deepEqual(await r.memory.list(), []);
    assert.equal(await r.runner().material('dream'), true, 'the watermark did not move');
    // Aborted while the model is still answering: the answer would have saved a record, but nothing is applied.
    let release!: () => void;
    r.answer.wait = new Promise<void>(resolve => {release = resolve;});
    r.answer.text = JSON.stringify({operations: [{op: 'save', scope: 'project', type: 'project', name: 'late', description: 'd', content: 'c'}]});
    const controller = new AbortController();
    const running = r.runner().run(r.context('dream', controller.signal));
    const settled = assert.rejects(running);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort('pause');
    await settled;
    release();
    assert.deepEqual(await r.memory.list(), []);
    assert.equal(await r.runner().material('dream'), true);
    assert.equal(r.charged.length, 1, 'only the first, answered request was charged');
  } finally {await r.close();}
});

test('a recap covers the whole recent conversation, shows the first line as its title and keeps its own watermark', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'Add a retry to the uploader.'));
    await r.journal.append(said('logox', 'Done in src/upload.ts.'));
    r.answer.text = '\nUploader retries are in place\n\nDone: added a retry in src/upload.ts\nOpen: nothing\nNext: run the tests';
    const outcome = await r.runner().run(r.context('recap'));
    assert.deepEqual(outcome, {stage: 'Uploader retries are in place', detail: 'Done: added a retry in src/upload.ts\n\nOpen: nothing\n\nNext: run the tests'});
    const request = r.requests[0]!;
    assert.equal(request.system, RECAP_SYSTEM_PROMPT);
    assert.equal(request.maxTokens, 600);
    assert.deepEqual(request.tools, []);
    assert.equal(request.messages[0]!.text, recapMessage('Branch main (clean working tree)', '[logox · user] Add a retry to the uploader.\n[logox · assistant] Done in src/upload.ts.'));
    assert.deepEqual(r.charged.map(item => item.identity), ['["p","m"]']);
    assert.equal(await r.runner().material('recap'), false);
    assert.equal(await r.runner().material('dream'), true, 'the dream has not seen it');
    r.answer.text = '  ';
    await r.journal.append(said('logox', 'One more thing.'));
    await assert.rejects(r.runner().run(r.context('recap')), /empty note/);
    assert.deepEqual(splitRecap('⏵ Title\n\nBody one\nBody two'), {stage: 'Title', detail: 'Body one\nBody two'});
    assert.equal(splitRecap('Title\n\nDone: a\nOpen: b\nNext: c').detail, 'Done: a\n\nOpen: b\n\nNext: c');
  } finally {await r.close();}
});

test('a run on an empty session asks nothing', async () => {
  const r = await rig();
  try {
    assert.deepEqual(await r.runner().run(r.context('recap')), {stage: 'Nothing to recap yet', detail: ''});
    assert.deepEqual(await r.runner().run(r.context('dream')), {stage: 'Nothing new to remember', detail: '', empty: true});
    assert.deepEqual(r.requests, []);
  } finally {await r.close();}
});

async function registryRig(provider = {name: 'deepseek', model: 'deepseek-flash'}) {
  const root = await mkdtemp(join(tmpdir(), 'logox-anamnesis-model-'));
  const config = await loadConfig(root, {provider, providers: {nokey: {kind: 'openai_compat', base_url: 'https://example.test/v1', api_key_env: 'NOKEY_ENV'}}}, {}, root, root);
  const registry = new ProviderRegistry(config, {DEEPSEEK_API_KEY: 'k', ANTHROPIC_API_KEY: 'k'}, async () => {throw new Error('No real network');},
    new AuthStorage(join(root, 'auth.json')), new CustomProviderStorage(join(root, 'custom-providers.json')));
  const storage = new ActorModelStorage(join(root, 'actor-models.json'));
  return {registry, storage, close: () => rm(root, {recursive: true, force: true})};
}

test('the model follows the Director without a binding, uses the binding when there is one, and never substitutes another', async () => {
  const r = await registryRig();
  try {
    assert.deepEqual(anamnesisModel(r.registry, r.storage), {provider: 'deepseek', model: 'deepseek-flash', inherited: true});
    const injected: Provider = {async respond() {throw new Error('unused');}};
    const inherited = await resolveModel(r.registry, r.storage, injected);
    assert.equal(inherited.respond, injected);
    assert.equal(inherited.identity, '["deepseek","deepseek-flash"]');
    assert.equal(inherited.effort, undefined, 'no effort override');

    await bindAnamnesisModel(r.storage, {provider: 'anthropic', model: 'claude-x', effort: 'high'});
    assert.deepEqual(anamnesisModel(r.registry, r.storage), {provider: 'anthropic', model: 'claude-x', effort: 'high', inherited: false});
    const bound = await resolveModel(r.registry, r.storage, injected);
    assert.equal(bound.identity, '["anthropic","claude-x"]');
    assert.equal(bound.effort, 'high', 'the effort is passed through');
    assert.equal(bound.inherited, false);
    assert.equal(await new ActorModelStorage(r.storage.path).read().then(map => map.anamnesis?.model), 'claude-x', 'persisted under the id anamnesis');

    await bindAnamnesisModel(r.storage, {provider: 'anthropic', model: 'claude-y'});
    assert.equal((await resolveModel(r.registry, r.storage, injected)).effort, undefined);

    await bindAnamnesisModel(r.storage, {provider: 'vanished', model: 'm1'});
    await assert.rejects(resolveModel(r.registry, r.storage, injected), (error: Error) => error.message === 'Anamnesis has no usable model (vanished/m1). Choose one under /anamnesis.');
    await bindAnamnesisModel(r.storage, {provider: 'nokey', model: 'm2'});
    await assert.rejects(resolveModel(r.registry, r.storage), (error: Error) => error.message === noUsableModel('nokey', 'm2').message, 'a provider without credentials is an error, not a fallback');
    await bindAnamnesisModel(r.storage, undefined);
    assert.equal(anamnesisModel(r.registry, r.storage).inherited, true);
    assert.equal((await new ActorModelStorage(r.storage.path).read()).anamnesis, undefined);
  } finally {await r.close();}
});

test('an effort on the binding is what the request runs with; without one thinking is off', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'x'));
    r.answer.text = '{"operations": []}';
    const withEffort = new AnamnesisRunner({sessionId: SESSION, cwd: r.root, journal: r.journal, owners: async () => ['logox'], memory: r.memory, watermarks: r.watermarks,
      model: async () => ({provider: 'p', model: 'm', inherited: false, effort: 'high', identity: '["p","m"]', respond: {respond: async request => {r.requests.push(request); return {message: {role: 'assistant', text: '{"operations": []}'}, stop: 'complete'} satisfies ModelTurn;}}}),
      charge() {}});
    await withEffort.run(r.context('dream'));
    assert.equal(r.requests[0]!.thinking, undefined);
    await r.journal.append(human('logox', 'y'));
    await r.runner().run(r.context('dream'));
    assert.equal(r.requests[1]!.thinking, false);
  } finally {await r.close();}
});
