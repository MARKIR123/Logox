import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {ContextManager, type ContextOptions} from '../src/context/manager.js';
import {contextPolicySchema, loadConfig, modelSettings, RETIRED_CONTEXT_KEYS} from '../src/config/config.js';
import {cacheLifetimeMs, LONG_CACHE_MS, SHORT_CACHE_MS} from '../src/providers/cache.js';
import {builtinActors} from '../src/actors/builtins.js';
import {parseActor, serializeActor} from '../src/actors/definitions.js';
import {Ensemble} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';
import type {RoundStatus} from '../src/context/contracts.js';

const SESSION = 's';
const base = {system: 'rules', tools: []};
const signal = new AbortController().signal;
const noModel = () => {throw new Error('A routine fold must not ask the model.');};

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-round-folding-'));
  return {directory, journal: new Journal(directory), cleanup: () => rm(directory, {recursive: true, force: true})};
}
/** One closed round: the human task, a working reply, and the round record with `status`. */
async function round(journal: Journal, ownerId: string, activityId: string, status: RoundStatus = 'completed', chars = 400, time?: number) {
  const id = {version: 1 as const, sessionId: SESSION, ownerId, activityId};
  await journal.append({...id, role: 'user', text: 'task ' + activityId, ...(time !== undefined ? {time} : {})});
  await journal.append({...id, role: 'assistant', text: 'work '.repeat(Math.ceil(chars / 5)) + activityId, ...(time !== undefined ? {time} : {})});
  await journal.finishRecord(SESSION, ownerId, activityId, status);
}
const open = (journal: Journal, ownerId: string, activityId: string, text = 'current task') =>
  journal.append({version: 1, sessionId: SESSION, ownerId, activityId, role: 'user', text});
const root = (journal: Journal, ownerId: string, activityId: string, rootActivityId: string, extra: {resumeTaskId?: string} = {}) =>
  journal.checkpoint(SESSION, {activityId, ownerId, prompt: 'p', source: 'logox', status: 'completed', time: Date.now(), rootActivityId, ...extra});
const folds = async (journal: Journal, ownerId: string) =>
  [...(await journal.loadContext(SESSION, ownerId, await journal.load(SESSION, ownerId)))?.folded ?? []].sort((a, b) => a - b);
const options = (journal: Journal, extra: Partial<ContextOptions> = {}, policy: object = {}): ContextOptions => ({journal, maxOutput: 256,
  model: () => ({identity: 'test', window: 131072}), summarizer: noModel,
  policy: ({ownerId}) => contextPolicySchema.parse({keep_recent_rounds: ownerId === 'logox' ? 2 : 0, keep_recent_tools: 0, ...policy}), ...extra});
const texts = (request: ModelRequest) => request.messages.map(message => message.text);

test('a failed or cancelled companion round stays in full until its Director round is closed, then folds as its runtime line', async () => {
  const f = await workspace();
  try {
    for (const [owner, status, marker] of [['techne', 'failed', '[failed]'], ['kalon', 'cancelled', '[interrupted]']] as const) {
      await open(f.journal, 'logox', 'dir-' + owner, 'build it');
      await round(f.journal, owner, 'stopped-' + owner, status);
      await root(f.journal, owner, 'stopped-' + owner, 'dir-' + owner);
      await round(f.journal, owner, 'fine-' + owner);
      await root(f.journal, owner, 'fine-' + owner, 'other-root');
      await open(f.journal, owner, 'next-' + owner);
      const identity = {sessionId: SESSION, ownerId: owner, activityId: 'next-' + owner};
      const manager = new ContextManager(options(f.journal));
      await manager.roundStart(identity, base, signal, {keepLast: false});
      assert.deepEqual(await folds(f.journal, owner), [2], owner + ': only the ordinary round folds while the Director round is open');
      assert.ok(texts((await manager.prepare(identity, base, signal)).request).some(text => text.startsWith('work ')), 'the stopped round keeps its detail');
      // The Director round that dispatched it closes (its record exists in the Director ledger).
      await f.journal.append({version: 1, sessionId: SESSION, ownerId: 'logox', activityId: 'dir-' + owner, role: 'assistant', text: 'accepted'});
      await f.journal.finishRecord(SESSION, 'logox', 'dir-' + owner, 'completed');
      await manager.roundStart(identity, base, signal, {keepLast: false});
      assert.deepEqual(await folds(f.journal, owner), [0, 2], owner + ': the stopped round folds once its root task ended');
      const request = (await manager.prepare(identity, base, signal)).request;
      assert.ok(texts(request).some(text => text.startsWith('T1|') && text.includes(marker + ' ')), 'it renders its runtime-written ' + marker + ' line');
      assert.ok(!texts(request).some(text => text.startsWith('work ')));
    }
  } finally {await f.cleanup();}
});

test('a stopped round that was resumed to completion is an ordinary round', async () => {
  const f = await workspace();
  try {
    await open(f.journal, 'logox', 'dir', 'build it');
    await round(f.journal, 'techne', 'stopped', 'failed');
    await root(f.journal, 'techne', 'stopped', 'dir');
    await round(f.journal, 'techne', 'retry'); // `resumeTask` starts a new activity of the same root task
    await root(f.journal, 'techne', 'retry', 'dir', {resumeTaskId: 'stopped'});
    await open(f.journal, 'techne', 'next');
    await new ContextManager(options(f.journal)).roundStart({sessionId: SESSION, ownerId: 'techne', activityId: 'next'}, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'techne'), [0, 2], 'the Director round is still open, yet the resumed round no longer holds');
  } finally {await f.cleanup();}
});

test('a stopped round whose resumption was not completed stays pinned', async () => {
  const f = await workspace();
  try {
    await open(f.journal, 'logox', 'dir', 'build it');
    await round(f.journal, 'techne', 'stopped', 'cancelled');
    await root(f.journal, 'techne', 'stopped', 'dir');
    await round(f.journal, 'techne', 'retry', 'failed');
    await root(f.journal, 'techne', 'retry', 'dir', {resumeTaskId: 'stopped'});
    await open(f.journal, 'techne', 'next');
    await new ContextManager(options(f.journal)).roundStart({sessionId: SESSION, ownerId: 'techne', activityId: 'next'}, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'techne'), []);
  } finally {await f.cleanup();}
});

test('the watermark fallback may still fold pinned rounds', async () => {
  const f = await workspace();
  try {
    await open(f.journal, 'logox', 'dir', 'build it');
    await round(f.journal, 'techne', 'stopped', 'failed', 9000);
    await root(f.journal, 'techne', 'stopped', 'dir');
    await open(f.journal, 'techne', 'next');
    const result = await new ContextManager(options(f.journal, {}, {max_budget_tokens: 1500}))
      .prepare({sessionId: SESSION, ownerId: 'techne', activityId: 'next'}, base, signal);
    assert.equal(result.compacted, true);
    assert.deepEqual(await folds(f.journal, 'techne'), [0]);
  } finally {await f.cleanup();}
});

test('Logox pins a stopped round until a later round completes normally', async () => {
  const f = await workspace();
  try {
    await round(f.journal, 'logox', 'l1');
    await round(f.journal, 'logox', 'l2', 'cancelled');
    await round(f.journal, 'logox', 'l3', 'failed');
    await round(f.journal, 'logox', 'l4');
    await round(f.journal, 'logox', 'l5');
    await open(f.journal, 'logox', 'l6');
    const identity = {sessionId: SESSION, ownerId: 'logox', activityId: 'l6'};
    // Cache expired: fold all but the latest two rounds. l2 and l3 have a normal completion after them (l4, l5), so they fold.
    const manager = new ContextManager(options(f.journal, {cacheLifetimeMs: () => 1, now: () => Date.now() + 10_000}));
    await manager.roundStart(identity, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'logox'), [0, 2, 4]);
    // Without a later completed round the stopped ones stay.
    await rm(join(f.directory), {recursive: true, force: true}); await mkdir(f.directory, {recursive: true});
    const journal = new Journal(f.directory);
    await round(journal, 'logox', 'm1');
    await round(journal, 'logox', 'm2', 'cancelled');
    await round(journal, 'logox', 'm3', 'failed');
    await round(journal, 'logox', 'm4', 'failed');
    await open(journal, 'logox', 'm5');
    await new ContextManager(options(journal, {cacheLifetimeMs: () => 1, now: () => Date.now() + 10_000}))
      .roundStart({sessionId: SESSION, ownerId: 'logox', activityId: 'm5'}, base, signal, {keepLast: false});
    assert.deepEqual(await folds(journal, 'logox'), [0], 'only the ordinary round folds');
  } finally {await f.cleanup();}
});

test('Logox folds to its latest two rounds when its cache has expired, measured from the ledger timestamp of its last reply', async () => {
  const f = await workspace();
  try {
    const stamp = 5_000_000;
    for (const id of ['l1', 'l2', 'l3', 'l4']) await round(f.journal, 'logox', id, 'completed', 400, stamp);
    await open(f.journal, 'logox', 'l5');
    const identity = {sessionId: SESSION, ownerId: 'logox', activityId: 'l5'}, lifetime = 300_000;
    let now = stamp + lifetime - 1;
    const manager = new ContextManager(options(f.journal, {cacheLifetimeMs: () => lifetime, now: () => now}));
    await manager.roundStart(identity, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'logox'), [], 'one millisecond before the lifetime the cache is still alive');
    now = stamp + lifetime;
    await manager.roundStart(identity, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'logox'), [0, 2], 'at the lifetime everything but the latest two rounds folds');
    const state = await f.journal.loadContext(SESSION, 'logox', await f.journal.load(SESSION, 'logox'));
    assert.equal(state?.thinkingCut, (await f.journal.load(SESSION, 'logox')).length);
    // A restart reads the same persisted state; the clock is not needed again.
    const restarted = (await new ContextManager(options(new Journal(f.directory))).prepare(identity, base, signal)).request;
    assert.ok(texts(restarted).some(text => text.startsWith('T1|')) && texts(restarted).some(text => text.startsWith('T2|')));
    assert.equal(texts(restarted).filter(text => text.startsWith('work ')).length, 2, 'the latest two rounds are still in full');
  } finally {await f.cleanup();}
});

test('Logox does not fold when the cache lifetime is unknown and the request is small', async () => {
  const f = await workspace();
  try {
    for (const id of ['l1', 'l2', 'l3', 'l4']) await round(f.journal, 'logox', id, 'completed', 400, 1);
    await open(f.journal, 'logox', 'l5');
    await new ContextManager(options(f.journal, {cacheLifetimeMs: () => undefined, now: () => Date.now() + 1e12}))
      .roundStart({sessionId: SESSION, ownerId: 'logox', activityId: 'l5'}, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'logox'), [], 'unknown means never expired');
    await new ContextManager(options(f.journal, {now: () => Date.now() + 1e12}))
      .roundStart({sessionId: SESSION, ownerId: 'logox', activityId: 'l5'}, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'logox'), []);
  } finally {await f.cleanup();}
});

test('Logox folds at half the high watermark even with an unknown cache lifetime', async () => {
  const f = await workspace();
  try {
    for (const id of ['l1', 'l2', 'l3', 'l4']) await round(f.journal, 'logox', id, 'completed', 2400);
    await open(f.journal, 'logox', 'l5');
    const identity = {sessionId: SESSION, ownerId: 'logox', activityId: 'l5'}, reports: string[] = [];
    // The high watermark is 4000 tokens; four rounds of about 600 tokens reach half of it (2000).
    await new ContextManager(options(f.journal, {report: (_who, text) => {reports.push(text);}}, {max_budget_tokens: 4000}))
      .roundStart(identity, base, signal, {keepLast: false});
    assert.deepEqual(await folds(f.journal, 'logox'), [0, 2]);
    assert.equal(reports.length, 1);
    assert.match(reports[0]!, /^\[Context\] Folded 2 closed rounds into index lines/);
    // Below half the watermark nothing happens.
    const small = await workspace();
    try {
      for (const id of ['l1', 'l2', 'l3', 'l4']) await round(small.journal, 'logox', id, 'completed', 400);
      await open(small.journal, 'logox', 'l5');
      await new ContextManager(options(small.journal, {}, {max_budget_tokens: 4000})).roundStart(identity, base, signal, {keepLast: false});
      assert.deepEqual(await folds(small.journal, 'logox'), []);
    } finally {await small.cleanup();}
  } finally {await f.cleanup();}
});

test('folding at twenty-one or more index lines asks the model for nothing', async () => {
  const f = await workspace();
  try {
    for (let n = 1; n <= 25; n++) await round(f.journal, 'techne', 'r' + n, 'completed', 100);
    await open(f.journal, 'techne', 'next');
    const identity = {sessionId: SESSION, ownerId: 'techne', activityId: 'next'};
    const manager = new ContextManager(options(f.journal));
    await manager.roundStart(identity, base, signal, {keepLast: false});
    const forced = await manager.prepare(identity, base, signal, true);
    const lines = texts(forced.request).filter(text => /^T\d+\|/.test(text));
    assert.equal(lines.length, 25, 'every round keeps its own index line; none is merged into an overview');
    assert.ok(!texts(forced.request).some(text => text.startsWith('[Historical working overview')));
    assert.equal((await f.journal.loadContext(SESSION, 'techne', await f.journal.load(SESSION, 'techne')))?.memo, undefined);
  } finally {await f.cleanup();}
});

test('the index-line merge fires only when the lines themselves keep the request over the high watermark', async () => {
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {requests.push(request); return {message: {role: 'assistant', text: 'MERGED OVERVIEW'}, stop: 'complete'};}};
  const model = {identity: 'test', window: 2400};
  const summarizer = () => ({model: {identity: 'summarizer', window: 200000}, provider});
  // A huge current round keeps the request over the watermark although the index lines are small: no merge.
  const first = await workspace();
  try {
    for (let n = 1; n <= 4; n++) await round(first.journal, 'techne', 'r' + n, 'completed', 80);
    await open(first.journal, 'techne', 'next', 'big '.repeat(9000));
    await new ContextManager(options(first.journal, {model: () => model, summarizer})).prepare({sessionId: SESSION, ownerId: 'techne', activityId: 'next'}, base, signal, true).catch(() => undefined);
    assert.equal(requests.length, 0, 'the lines are not the cause, so no overview is requested');
  } finally {await first.cleanup();}
  // Many lines over the watermark: one merge whose input is the lines.
  const second = await workspace();
  try {
    for (let n = 1; n <= 40; n++) await round(second.journal, 'techne', 'r' + n, 'completed', 700);
    await open(second.journal, 'techne', 'next');
    const result = await new ContextManager(options(second.journal, {model: () => model, summarizer})).prepare({sessionId: SESSION, ownerId: 'techne', activityId: 'next'}, base, signal);
    assert.equal(result.compacted, true);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.messages.map(message => message.text).join('\n'), /T1\|/);
    assert.ok(texts(result.request).some(text => text.includes('MERGED OVERVIEW')));
  } finally {await second.cleanup();}
});

test('routine fold state survives a restart', async () => {
  const f = await workspace();
  try {
    await round(f.journal, 'techne', 'old');
    await open(f.journal, 'techne', 'next');
    const identity = {sessionId: SESSION, ownerId: 'techne', activityId: 'next'};
    await new ContextManager(options(f.journal)).roundStart(identity, base, signal, {keepLast: false});
    const restarted = await new ContextManager(options(new Journal(f.directory))).prepare(identity, base, signal);
    assert.equal(restarted.compacted, false, 'nothing is compacted again');
    assert.ok(texts(restarted.request).some(text => text.startsWith('T1|')));
    assert.ok(!texts(restarted.request).some(text => text.startsWith('work ')));
  } finally {await f.cleanup();}
});

test('/compact takes the watermark ladder: it folds the closed rounds, keeps pinned ones, and reports the result', async () => {
  const f = await workspace();
  try {
    await open(f.journal, 'logox', 'dir', 'build it');
    await round(f.journal, 'techne', 'stopped', 'failed');
    await root(f.journal, 'techne', 'stopped', 'dir');
    await round(f.journal, 'techne', 'a');
    await round(f.journal, 'techne', 'b');
    await open(f.journal, 'techne', 'next');
    const reports: string[] = [];
    const result = await new ContextManager(options(f.journal, {report: (_who, text) => {reports.push(text);}}))
      .prepare({sessionId: SESSION, ownerId: 'techne', activityId: 'next'}, base, signal, true);
    assert.equal(result.compacted, true);
    assert.deepEqual(await folds(f.journal, 'techne'), [2, 4], 'the pinned round stays');
    assert.ok(reports.some(text => text.startsWith('[Context] Compacted')));
  } finally {await f.cleanup();}
});

test('the ensemble tells the fold whether the new task shares the root task of the latest round', async () => {
  const f = await workspace();
  try {
    const seen: boolean[] = [], starts: string[] = [];
    const ensemble = new Ensemble(SESSION, new RuntimeStore(), f.journal, async (_prompt, context) => context.say('done'), {
      roundStart: async (context, info) => {seen.push(info.keepLast); starts.push(context.inputKind ?? '');},
    });
    await ensemble.dispatch('techne', 'first', 'logox', {inputKind: 'director', rootActivityId: 'root-a'}).done;
    await ensemble.dispatch('techne', 'rework', 'logox', {inputKind: 'director', rootActivityId: 'root-a'}).done;
    await ensemble.dispatch('techne', 'unrelated', 'logox', {inputKind: 'director', rootActivityId: 'root-b'}).done;
    await ensemble.dispatch('techne', 'aside', 'kalon', {inputKind: 'collaboration', rootActivityId: 'root-b'}).done;
    assert.deepEqual(seen, [false, true, false], 'asides never start a fold');
    await ensemble.close();
  } finally {await f.cleanup();}
});

test('cacheLifetimeMs: a configured value wins, then Anthropic follows the lifetime LOGOX sets, everything else is unknown', () => {
  const anthropic = {kind: 'anthropic' as const};
  assert.equal(cacheLifetimeMs(anthropic, {cacheRetention: {role: 'short'}}), SHORT_CACHE_MS);
  assert.equal(cacheLifetimeMs(anthropic, {cacheRetention: {role: 'long'}}), LONG_CACHE_MS);
  assert.equal(cacheLifetimeMs({...anthropic, cacheRetention: 'short'}, {cacheRetention: {role: 'long'}}), SHORT_CACHE_MS, 'the model setting beats the role default');
  assert.equal(cacheLifetimeMs(anthropic, {cacheRetention: {actor: 'long', role: 'short'}}), LONG_CACHE_MS, 'the actor beats the role');
  assert.equal(cacheLifetimeMs({...anthropic, cacheTtlMs: 1}, {cacheRetention: {role: 'short'}}), 1, 'a configured lifetime wins, for a gateway that speaks the Anthropic protocol');
  assert.equal(cacheLifetimeMs({kind: 'openai_compat', cacheRetention: 'long'}, {cacheRetention: {role: 'long'}}), undefined);
  assert.equal(cacheLifetimeMs({kind: 'openai_compat', cacheTtlMs: 1_800_000}, {cacheRetention: {role: 'long'}}), 1_800_000);
});

test('config files that still carry the retired context keys load; cache_ttl_seconds follows the cache_retention cascade', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'logox-retired-keys-')));
  try {
    await mkdir(join(home, '.logox'), {recursive: true});
    await writeFile(join(home, '.logox', 'config.toml'), [
      '[context]', 'keep_recent_rounds = 3', 'keep_index_lines = 7', 'task_end_floor_ratio = 0.4', 'compact_accept_ratio = 0.6', '',
      '[provider]', 'name = "gw"', 'model = "m"', 'cache_ttl_seconds = 120', '',
      '[providers.gw]', 'base_url = "http://127.0.0.1:1/v1"', 'cache_ttl_seconds = 60', '',
      '[models."gw/m"]', 'context_window = 100000', '',
    ].join('\n'));
    const config = await loadConfig(home, {}, {}, home, home);
    assert.equal(config.context.keep_recent_rounds, 3);
    for (const key of RETIRED_CONTEXT_KEYS) assert.equal(Object.hasOwn(config.context, key), false, key + ' is ignored');
    assert.equal(modelSettings(config).cacheTtlMs, 120_000, 'the provider table beats the providers entry');
    const declared = await loadConfig(home, {models: {'gw/m': {cache_ttl_seconds: 30}}}, {}, home, home);
    assert.equal(modelSettings(declared).cacheTtlMs, 30_000, 'the model entry is the most specific');
    const fallback = await loadConfig(home, {provider: {cache_ttl_seconds: undefined}}, {}, home, home);
    assert.equal(modelSettings(fallback).cacheTtlMs, 60_000, 'without a provider value the providers entry applies');
    const unset = await loadConfig(home, {provider: {name: 'plain', model: 'm', base_url: 'http://127.0.0.1:1/v1'}}, {}, home, home);
    assert.equal(modelSettings(unset).cacheTtlMs, undefined, 'unset means unknown');
  } finally {await rm(home, {recursive: true, force: true});}
});

test('actor profiles that still carry the retired context keys parse', () => {
  const role = builtinActors[1]!;
  const text = serializeActor(role).replace('\ncontext:\n', '\ncontext:\n  keep_index_lines: 5\n  task_end_floor_ratio: 0.3\n  compact_accept_ratio: 0.9\n');
  assert.ok(text.includes('keep_index_lines: 5'));
  const parsed = parseActor(text);
  assert.equal(parsed.id, role.id);
  for (const key of RETIRED_CONTEXT_KEYS) assert.equal(Object.hasOwn(parsed.context, key), false);
  assert.throws(() => parseActor(text.replace('keep_index_lines: 5', 'bogus_key: 5')), /Unknown context field: bogus_key/);
});
