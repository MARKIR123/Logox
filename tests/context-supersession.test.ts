import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {ContextManager, SUPERSEDE_SUFFIX_TOKENS} from '../src/context/manager.js';
import {contextPolicySchema} from '../src/config/config.js';
import {estimateRequest} from '../src/context/budget.js';
import {supersededReads} from '../src/context/supersession.js';
import {supersededReadText} from '../src/prompts/compaction.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const FILE = join(CWD, 'big.ts');
const OMITTED = '(Remaining lines omitted)';
const signal = new AbortController().signal;
const base = {system: 'rules', tools: []};

/** What `Read` returns for lines `from..to` of a file whose lines are 40 characters wide; `omitted` mirrors a tool-truncated read. */
const body = (from: number, to: number, omitted = false) =>
  Array.from({length: to - from + 1}, (_, index) => (from + index) + ': ' + 'x'.repeat(40)).join('\n') + (omitted ? '\n' + OMITTED : '');
interface ReadOptions {offset?: number; limit?: number; path?: string; text?: string; fail?: boolean; name?: string}
let counter = 0;
function read(options: ReadOptions = {}): ModelMessage[] {
  const id = 'call-' + ++counter;
  const args = {file_path: options.path ?? FILE, ...(options.offset ? {offset: options.offset} : {}), ...(options.limit ? {limit: options.limit} : {})};
  return [{role: 'assistant', text: '', toolCalls: [{id, name: options.name ?? 'Read', arguments: JSON.stringify(args)}]},
    {role: 'tool', callId: id, name: options.name ?? 'Read', text: options.text ?? body(options.offset ?? 1, (options.offset ?? 1) + (options.limit ?? 50) - 1, options.limit !== undefined), isError: options.fail === true}];
}
const idOf = (messages: ModelMessage[], index: number) => (messages[index * 2] as Extract<ModelMessage, {role: 'assistant'}>).toolCalls![0]!.id;
const superseded = (...reads: ModelMessage[][]) => supersededReads(reads.flat(), CWD);

test('a later read supersedes an older one only when its range contains it', () => {
  const older = read({offset: 10, limit: 20});
  const equal = read({offset: 10, limit: 20});
  const wider = read({offset: 1, limit: 100});
  const narrower = read({offset: 20, limit: 5});
  const result = superseded(older, narrower, equal, wider);
  assert.equal(result.get(idOf(older, 0)), 'lines 10-29', 'the nearest later read that contains it');
  assert.equal(result.has(idOf(narrower, 0)), true, 'inside both the equal read and the wider read');
  assert.equal(result.get(idOf(equal, 0)), 'lines 1-100');
  assert.equal(result.has(idOf(wider, 0)), false, 'the newest read is never superseded');
  assert.equal(superseded(read({offset: 10, limit: 20}), read({offset: 1, limit: 5})).size, 0, 'a later read of another range supersedes nothing');
  assert.equal(superseded(read({offset: 1, limit: 100, text: body(1, 100, true)}), read({offset: 1, limit: 50})).size, 0, 'a narrower later read does not contain it');
});

test('a full read contains every range, unless the tool truncated it', () => {
  const ranged = read({offset: 300, limit: 40}), full = read({text: body(1, 120)});
  assert.equal(superseded(ranged, full).get(idOf(ranged, 0)), 'whole file');
  const cut = read({text: body(1, 2000, true)});
  assert.equal(superseded(read({offset: 300, limit: 40}), cut).size, 1, 'inside what the truncated read returned');
  const beyond = read({offset: 2500, limit: 40});
  assert.equal(superseded(beyond, cut).size, 0, 'beyond what the truncated read returned');
  const tail = read({offset: 100, text: body(100, 160)});
  const farther = read({offset: 120, limit: 30});
  assert.equal(superseded(farther, tail).get(idOf(farther, 0)), 'from line 100', 'a read that reached the end of the file covers the rest of it');
});

test('failed reads never supersede, and a failed read yields to a later success of the same selector', () => {
  const failed = read({offset: 5, limit: 10, text: 'File not found: x', fail: true});
  const broken = read({fail: true, text: 'File not found: x'});
  const ranged = read({offset: 5, limit: 10});
  assert.equal(superseded(ranged, broken).size, 0, 'a failure replaces nothing');
  assert.equal(superseded(failed, broken).size, 0, 'neither does a later failure');
  assert.equal(superseded(failed, read({offset: 1, limit: 100})).size, 0, 'a different selector leaves the failure');
  assert.equal(superseded(failed, ranged).get(idOf(failed, 0)), 'lines 5-14');
});

test('image reads follow the same rule by path; other files and tools are untouched', () => {
  const png = join(CWD, 'shot.png');
  const first = read({path: png, text: '[Image file]'}), second = read({path: png, text: '[Image file]'});
  assert.equal(superseded(first, second).get(idOf(first, 0)), 'whole file');
  assert.equal(superseded(read({path: png, text: '[Image file]'}), read({path: join(CWD, 'other.png'), text: '[Image file]'})).size, 0);
  assert.equal(superseded(read({offset: 1, limit: 10}), read({path: join(CWD, 'other.ts'), offset: 1, limit: 50})).size, 0, 'another file');
  assert.equal(superseded(read({offset: 1, limit: 10}), read({offset: 1, limit: 50, name: 'Grep'})).size, 0, 'another tool');
  assert.equal(superseded(read({offset: 1, limit: 10, path: 'big.ts'}), read({offset: 1, limit: 50, path: FILE})).size, 1, 'a relative path resolves against the given directory');
});

test('an edit or a write never supersedes a read', () => {
  const edit = (name: string): ModelMessage[] => [{role: 'assistant', text: '', toolCalls: [{id: 'e-' + name, name, arguments: JSON.stringify({file_path: FILE})}]},
    {role: 'tool', callId: 'e-' + name, name, text: 'ok', isError: false}];
  assert.equal(superseded(read({offset: 1, limit: 50}), edit('Edit'), edit('Write')).size, 0);
  const older = read({offset: 1, limit: 50});
  assert.equal(superseded(older, edit('Edit'), read({offset: 1, limit: 50})).size, 1, 'only the later read does');
});

// A session fixture: Read pairs inside one open round of a companion, with explicit ledger times.
const NOW = 100_000_000;
const WARM = 3_600_000;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-supersession-'));
  const journal = new Journal(root);
  const id = {version: 1 as const, sessionId: 's', ownerId: 'techne', activityId: 'open'};
  const put = (message: ModelMessage, time: number) => journal.append({...id, role: message.role, text: message.text, message, time});
  const manager = (extra: {lifetime?: number | undefined; keep_recent_tools?: number} = {}) => new ContextManager({journal, maxOutput: 256, cwd: CWD, now: () => NOW,
    model: () => ({identity: 'test', window: 1_000_000}), summarizer: () => {throw new Error('no model');}, cacheLifetimeMs: () => extra.lifetime,
    policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: extra.keep_recent_tools ?? 0})});
  await journal.append({...id, role: 'user', inputKind: 'human', text: 'Task', time: NOW - 10_000});
  return {root, journal, put, manager, cleanup: () => rm(root, {recursive: true, force: true})};
}
const identity = {sessionId: 's', ownerId: 'techne', activityId: 'open'};
const toolTexts = (messages: readonly ModelMessage[]) => messages.flatMap(message => message.role === 'tool' ? [message.text] : []);
const tombstones = (messages: readonly ModelMessage[]) => toolTexts(messages).filter(text => text.startsWith('[Superseded by a later read'));
const state = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.journal.loadContext('s', 'techne', await f.journal.load('s', 'techne')))?.superseded;

test('gate (b): with a warm cache a covered read is tombstoned only when little follows it', async () => {
  const f = await fixture();
  try {
    const older = read({offset: 1, limit: 50}), newer = read({offset: 1, limit: 80});
    for (const message of [...older, ...newer]) await f.put(message, NOW - 1000);
    const manager = f.manager({lifetime: WARM});
    const sent = (await manager.prepare(identity, base, signal)).request.messages;
    assert.deepEqual(toolTexts(sent).slice(0, 1), [supersededReadText('lines 1-80')], 'the suffix after it is a few hundred tokens');
    assert.equal(toolTexts(sent).length, 2);
    assert.deepEqual(await state(f), {[idOf(older, 0)]: 'lines 1-80'});
    // The pair stays intact and the assistant message is untouched.
    const assistants = sent.filter(message => message.role === 'assistant');
    assert.deepEqual(assistants.map(message => message.toolCalls?.[0]?.id), [idOf(older, 0), idOf(newer, 0)]);
    assert.deepEqual(assistants[0], older[0]);
  } finally {await f.cleanup();}
});

test('gate (b) refuses while more than the suffix limit follows, and an unknown cache lifetime never counts as cold', async () => {
  const f = await fixture();
  try {
    const older = read({offset: 1, limit: 50}), newer = read({offset: 1, limit: 80});
    // Long ago, but the last assistant entry (what the cache check measures) is fresh; more than the limit follows the covered read.
    for (const message of [...older, ...newer]) await f.put(message, NOW - 9_000_000);
    await f.put({role: 'assistant', text: 'y'.repeat(SUPERSEDE_SUFFIX_TOKENS * 4 + 400)}, NOW - 1000);
    const warm = (await f.manager({lifetime: WARM}).prepare(identity, base, signal)).request.messages;
    assert.deepEqual(tombstones(warm), [], 'warm cache and an expensive suffix');
    assert.equal(await state(f), undefined, 'nothing was decided');
    // An unknown lifetime is never expired, even when the last reply is very old.
    const stale = await fixture();
    try {
      for (const message of [...older, ...newer]) await stale.put(message, NOW - 90_000_000);
      await stale.put({role: 'assistant', text: 'y'.repeat(SUPERSEDE_SUFFIX_TOKENS * 4 + 400)}, NOW - 90_000_000);
      const unknown = (await stale.manager({lifetime: undefined}).prepare(identity, base, signal)).request.messages;
      assert.deepEqual(tombstones(unknown), []);
      assert.equal(await state(stale), undefined);
      const known = (await stale.manager({lifetime: WARM}).prepare(identity, base, signal)).request.messages;
      assert.equal(tombstones(known).length, 1, 'the same ledger with a known lifetime is cold');
    } finally {await stale.cleanup();}
  } finally {await f.cleanup();}
});

test('gate (a): an expired cache tombstones every covered read whatever follows', async () => {
  const f = await fixture();
  try {
    const older = read({offset: 1, limit: 50}), middle = read({offset: 1, limit: 60}), newer = read({offset: 1, limit: 80});
    const times = NOW - 10_000_000;
    for (const message of [...older, ...middle, ...newer]) await f.put(message, times);
    await f.put({role: 'assistant', text: 'y'.repeat(SUPERSEDE_SUFFIX_TOKENS * 4 + 400)}, times);
    const cold = await f.manager({lifetime: WARM}).prepare(identity, base, signal);
    assert.equal(tombstones(cold.request.messages).length, 2);
    assert.deepEqual(Object.keys((await state(f))!).sort(), [idOf(older, 0), idOf(middle, 0)].sort());
  } finally {await f.cleanup();}
});

test('a tombstoned read stays tombstoned in later requests and after a reload, and the prefix stays byte-identical', async () => {
  const f = await fixture();
  try {
    const older = read({offset: 1, limit: 50}), newer = read({offset: 1, limit: 80});
    for (const message of [...older, ...newer]) await f.put(message, NOW - 1000);
    const first = (await f.manager({lifetime: WARM}).prepare(identity, base, signal)).request.messages;
    assert.equal(tombstones(first).length, 1);
    // Much more history follows, so gate (b) would now refuse a fresh decision; the saved one must not flip back.
    await f.put({role: 'assistant', text: 'z'.repeat(SUPERSEDE_SUFFIX_TOKENS * 8)}, NOW - 500);
    const later = (await f.manager({lifetime: WARM}).prepare(identity, base, signal)).request.messages;
    assert.deepEqual(later.slice(0, first.length).map(message => JSON.stringify(message)), first.map(message => JSON.stringify(message)));
    // A reader that never saw the first request (a restart) gets the same decision.
    const reloaded = (await f.manager({lifetime: undefined}).prepare(identity, base, signal)).request.messages;
    assert.equal(JSON.stringify(reloaded), JSON.stringify(later));
  } finally {await f.cleanup();}
});

test('a request on an append-only protocol is never rewritten', async () => {
  const f = await fixture();
  try {
    const older = read({offset: 1, limit: 50}), newer = read({offset: 1, limit: 80});
    for (const message of [...older, ...newer]) await f.put(message, NOW - 10_000_000);
    const sent = (await f.manager({lifetime: WARM}).prepare(identity, base, signal, false, undefined, true)).request.messages;
    assert.deepEqual(tombstones(sent), []);
    assert.equal(await state(f), undefined);
  } finally {await f.cleanup();}
});

test('gate (c): a routine fold tombstones the covered reads in its own save', async () => {
  const f = await fixture();
  try {
    const older = read({offset: 1, limit: 50}), newer = read({offset: 1, limit: 80});
    for (const message of [...older, ...newer]) await f.put(message, NOW - 1000);
    await f.journal.append({version: 1, sessionId: 's', ownerId: 'techne', activityId: 'open', role: 'assistant', text: 'z'.repeat(SUPERSEDE_SUFFIX_TOKENS * 8), time: NOW - 500});
    await f.journal.finishRecord('s', 'techne', 'open', 'completed');
    await f.journal.append({version: 1, sessionId: 's', ownerId: 'techne', activityId: 'next', role: 'user', inputKind: 'human', text: 'Next task', time: NOW - 100});
    await f.manager({lifetime: WARM}).roundStart({sessionId: 's', ownerId: 'techne', activityId: 'next'}, base, signal, {keepLast: false});
    const saved = await f.journal.loadContext('s', 'techne', await f.journal.load('s', 'techne'));
    assert.deepEqual(saved?.folded, [0]);
    assert.deepEqual(saved?.superseded, {[idOf(older, 0)]: 'lines 1-80'}, 'decided with the fold although the suffix is large and the cache warm');
  } finally {await f.cleanup();}
});

test('the repeated-range pattern of a real session shrinks the request', async () => {
  const f = await fixture();
  try {
    // Nineteen ranged reads of one large file that is being edited, each later pass covering the same ranges again (about 175k characters).
    const spans: [number, number][] = [[1, 220], [180, 400], [380, 600], [1, 220], [180, 400], [380, 600], [1, 400], [380, 600], [1, 220], [180, 400], [380, 600], [1, 220], [180, 400], [380, 600], [1, 220], [180, 400], [380, 600], [1, 220], [380, 600]];
    let at = NOW - 5_000_000;
    for (const [from, to] of spans) for (const message of read({offset: from, limit: to - from + 1})) await f.put(message, at += 1000);
    const total = spans.reduce((sum, [from, to]) => sum + (to - from + 1) * 45, 0);
    assert.ok(total > 170_000 && total < 220_000, 'the fixture is the size of the session it models: ' + total);
    const manager = f.manager({lifetime: WARM});
    const full = estimateRequest({...base, messages: (await f.journal.load('s', 'techne')).map(entry => entry.message ?? {role: 'user' as const, text: entry.text})});
    const sent = await manager.prepare(identity, base, signal);
    const after = estimateRequest(sent.request);
    assert.ok(after < full * 0.6, `the request shrank from ~${full} to ~${after} tokens`);
    assert.equal(tombstones(sent.request.messages).length, spans.length - 4, 'the four reads nothing later covers stay in full');
  } finally {await f.cleanup();}
});
