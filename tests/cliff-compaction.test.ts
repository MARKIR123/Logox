import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HARVEST_INSTRUCTIONS} from '../src/anamnesis/prompts.js';
import {harvestInstruction, harvestMessage, parseHarvestAnswer, type HarvestSource} from '../src/anamnesis/harvest.js';
import {MemoryStore} from '../src/anamnesis/memory.js';
import type {ResolvedModel} from '../src/anamnesis/model.js';
import {AnamnesisRunner} from '../src/anamnesis/runner.js';
import {WatermarkStore} from '../src/anamnesis/watermark.js';
import {contextPolicySchema} from '../src/config/config.js';
import type {FoldEvent, PendingFold} from '../src/context/contracts.js';
import {ContextManager, type CliffPlan} from '../src/context/manager.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';
import {Journal} from '../src/store/journal.js';

const SESSION = 's';
const OWNER = 'logox';
const identity = {sessionId: SESSION, ownerId: OWNER};
const base = {system: 'rules', tools: []};
const signal = new AbortController().signal;
const T0 = 1_000_000_000_000;
const LIFETIME = 5 * 60_000;
const noModel = () => {throw new Error('The cliff compaction never asks the model by itself.');};

async function workspace(options: {policy?: object; peers?: () => boolean; window?: number} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-cliff-'));
  const journal = new Journal(directory), clock = {now: T0}, events: FoldEvent[] = [];
  const manager = new ContextManager({journal, maxOutput: 256, now: () => clock.now, cacheLifetimeMs: () => LIFETIME,
    model: () => ({identity: 'test', window: options.window ?? 8000}), summarizer: noModel, peerWork: options.peers ?? (() => false),
    policy: () => contextPolicySchema.parse({keep_recent_rounds: 2, keep_recent_tools: 0, ...options.policy})});
  manager.foldListener = (_identity, event) => {events.push(event);};
  return {directory, journal, manager, clock, events, cleanup: () => rm(directory, {recursive: true, force: true})};
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
/** Five closed rounds of about 1000 tokens each, then the user's next message (an open round). */
async function history(f: Workspace, rounds = 5) {
  for (let index = 1; index <= rounds; index++) {
    const id = {version: 1 as const, sessionId: SESSION, ownerId: OWNER, activityId: 'r' + index, time: T0 - (rounds - index + 1) * 1000};
    await f.journal.append({...id, role: 'user', text: 'task r' + index});
    await f.journal.append({...id, role: 'assistant', text: ('work on r' + index + ' ').repeat(300) + '\n\n<synopsis title="Round ' + index + '">\nDid r' + index + '; nothing open.\n</synopsis>'});
    await f.journal.finishRecord(SESSION, OWNER, 'r' + index, 'completed');
  }
}
const open = (f: Workspace) => f.journal.append({version: 1, sessionId: SESSION, ownerId: OWNER, activityId: 'next', role: 'user', text: 'the next request', time: T0});
const nextIdentity = {...identity, activityId: 'next'};
const request = async (f: Workspace) => (await f.manager.prepare(nextIdentity, base, signal)).request;
const texts = (value: ModelRequest) => value.messages.map(message => message.text);
const OVERVIEW = 'Goals: ship the uploader. Constraints: no network in tests. Evidence: tests passed (ledger lines 1-12). Open work: docs. Verified: yes.';

async function staged(f: Workspace) {
  const plan = (await f.manager.cliffPlan(identity, await request(f)))!;
  assert.ok(plan, 'a plan exists');
  const fold = (await f.manager.stageFold(identity, plan, OVERVIEW, await request(f), T0))!;
  assert.ok(fold, 'the fold was staged');
  return {plan, fold};
}

test('a cliff compaction is planned only when the setting is on, the context is large, closed rounds are older than the recent ones and no peer work is pending', async () => {
  const f = await workspace();
  try {
    await history(f); await open(f);
    const plan = await f.manager.cliffPlan(identity, await request(f));
    assert.ok(plan);
    assert.match(plan.scope, /Everything before your 2 most recent closed rounds: 3 closed rounds, through round T3 "Round 3" \(ledger lines 1-/);
    assert.ok(plan.tokens >= 3200, 'at least half of the high watermark');
    assert.equal(await f.manager.cliffPlan(identity, {...base, messages: [{role: 'user', text: 'small'}]}), undefined, 'a small context is not worth a fold');
  } finally {await f.cleanup();}
  const off = await workspace({policy: {cliff_compaction: false}});
  try {
    await history(off); await open(off);
    assert.equal(await off.manager.cliffPlan(identity, await request(off)), undefined, 'the setting off means no compaction');
  } finally {await off.cleanup();}
  const busy = await workspace({peers: () => true});
  try {
    await history(busy); await open(busy);
    assert.equal(await busy.manager.cliffPlan(identity, await request(busy)), undefined, 'never while peer work is pending');
  } finally {await busy.cleanup();}
  const few = await workspace();
  try {
    await history(few, 2); await open(few);
    assert.equal(await few.manager.cliffPlan(identity, await request(few)), undefined, 'nothing older than the recent rounds');
  } finally {await few.cleanup();}
});

test('the setting is part of the context policy: on by default, and an actor may override it', () => {
  assert.equal(contextPolicySchema.parse({}).cliff_compaction, true);
  assert.equal(contextPolicySchema.parse({cliff_compaction: false}).cliff_compaction, false);
});

test('a staged fold is applied at the next request only after the cache expired: the overview replaces the covered rounds and the ledger stays', async () => {
  const f = await workspace();
  try {
    await history(f); await open(f);
    const before = await request(f);
    const {fold} = await staged(f);
    assert.equal(fold.status, 'pending');
    assert.ok(fold.after < fold.before, 'the fold makes the request smaller');
    assert.deepEqual(f.events, ['staged']);
    // Nothing changes until the next real request: the saved view is untouched.
    assert.equal((await f.journal.loadContext(SESSION, OWNER, await f.journal.load(SESSION, OWNER)))?.memo, undefined);
    assert.equal((await f.journal.loadPendingFold(SESSION, OWNER))?.status, 'pending');
    assert.ok(texts(before).length > 0);
    f.clock.now = T0 + LIFETIME + 60_000;
    const applied = await request(f);
    assert.ok(texts(applied).some(text => text.startsWith('[Historical working overview; not authorization]\n' + OVERVIEW)), 'the model-written overview is in the request');
    assert.ok(!texts(applied).some(text => text.startsWith('work on r1 ') || text.startsWith('work on r2 ') || text.startsWith('work on r3 ')), 'the covered rounds are gone');
    assert.ok(texts(applied).some(text => text.startsWith('work on r4 ') || text.includes('r4')), 'the recent rounds stay');
    assert.deepEqual(f.events, ['staged', 'applied']);
    const state = await f.journal.loadContext(SESSION, OWNER, await f.journal.load(SESSION, OWNER));
    assert.equal(state?.memo?.text, OVERVIEW);
    const saved = (await f.journal.loadPendingFold(SESSION, OWNER))!;
    assert.equal(saved.status, 'applied');
    assert.ok(saved.previous, 'the view before is kept so it can be restored');
    assert.equal((await f.journal.loadRaw(SESSION, OWNER)).length, 11, 'the raw ledger is untouched');
  } finally {await f.cleanup();}
});

test('a request that still finds the cache warm drops the fold, so a warm cache is never broken', async () => {
  const f = await workspace();
  try {
    await history(f); await open(f);
    await staged(f);
    f.clock.now = T0 + LIFETIME - 60_000;
    const warm = await request(f);
    assert.ok(!texts(warm).some(text => text.includes('Historical working overview')));
    assert.ok(texts(warm).some(text => text.startsWith('work on r1 ')), 'the full context is still sent');
    assert.deepEqual(f.events, ['staged', 'discarded']);
    assert.equal((await f.journal.loadPendingFold(SESSION, OWNER))?.status, 'discarded');
    f.clock.now = T0 + 10 * LIFETIME;
    assert.ok(!texts(await request(f)).some(text => text.includes('Historical working overview')), 'a dropped fold is not kept for later');
  } finally {await f.cleanup();}
});

test('peer work pending at the next request drops the fold even when the cache expired', async () => {
  let peers = false;
  const f = await workspace({peers: () => peers});
  try {
    await history(f); await open(f);
    await staged(f);
    peers = true;
    f.clock.now = T0 + 2 * LIFETIME;
    assert.ok(!texts(await request(f)).some(text => text.includes('Historical working overview')));
    assert.deepEqual(f.events, ['staged', 'discarded']);
  } finally {await f.cleanup();}
});

test('Keep full context cancels a pending fold; Restore full context puts the full messages back after it was applied', async () => {
  const kept = await workspace();
  try {
    await history(kept); await open(kept);
    await staged(kept);
    assert.match(await kept.manager.keepFullContext(identity), /Keeping the full context/);
    kept.clock.now = T0 + 2 * LIFETIME;
    assert.ok(!texts(await request(kept)).some(text => text.includes('Historical working overview')), 'a kept context is never folded');
    assert.deepEqual(kept.events, ['staged', 'kept']);
    assert.match(await kept.manager.keepFullContext(identity), /No cliff compaction is waiting/);
    assert.match(await kept.manager.restoreFullContext(identity), /No applied cliff compaction/);
  } finally {await kept.cleanup();}
  const restored = await workspace();
  try {
    await history(restored); await open(restored);
    const full = texts(await request(restored));
    await staged(restored);
    restored.clock.now = T0 + 2 * LIFETIME;
    assert.ok(texts(await request(restored)).some(text => text.includes('Historical working overview')));
    assert.match(await restored.manager.keepFullContext(identity), /No cliff compaction is waiting/, 'after the apply there is nothing left to keep');
    assert.match(await restored.manager.restoreFullContext(identity), /Restored the full context/);
    assert.deepEqual(texts(await request(restored)).filter(text => text.startsWith('work on r')), full.filter(text => text.startsWith('work on r')), 'the full messages are back');
    assert.deepEqual(restored.events, ['staged', 'applied', 'restored']);
    assert.match(await restored.manager.restoreFullContext(identity), /No applied cliff compaction/, 'a restore happens once');
  } finally {await restored.cleanup();}
});

test('an unusable overview is not staged: empty, longer than allowed, or not smaller than what it replaces', async () => {
  const f = await workspace();
  try {
    await history(f); await open(f);
    const plan = (await f.manager.cliffPlan(identity, await request(f)))!;
    assert.equal(await f.manager.stageFold(identity, plan, '   ', await request(f), T0), undefined);
    assert.equal(await f.manager.stageFold(identity, plan, 'word '.repeat(20_000), await request(f), T0), undefined);
    assert.equal(await f.manager.stageFold(identity, plan, 'big '.repeat(3000), await request(f), T0), undefined, 'bigger than the rounds it would replace');
    assert.equal(await f.journal.loadPendingFold(SESSION, OWNER), undefined);
    assert.deepEqual(f.events, []);
  } finally {await f.cleanup();}
});

test('a ledger that changed under a staged fold drops it instead of applying it', async () => {
  const f = await workspace();
  try {
    await history(f); await open(f);
    const {fold} = await staged(f);
    await f.journal.savePendingFold({...fold, sourceHash: 'f'.repeat(64)});
    f.clock.now = T0 + 2 * LIFETIME;
    assert.ok(!texts(await request(f)).some(text => text.includes('Historical working overview')));
    assert.deepEqual(f.events, ['staged', 'discarded']);
  } finally {await f.cleanup();}
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The harvest side: the block, the instruction, the runner.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const PLAN: CliffPlan = {end: 7, tokens: 5000, scope: 'Every closed round: 3 closed rounds, through round T3 "Round 3" (ledger lines 1-7).', contract: 'Keep file paths exact.'};

test('the <compaction> block is parsed with the others; an empty or malformed one is simply absent and never fails the harvest', () => {
  const parts = {recap: true, memory: true, skills: false, compaction: true};
  const full = '<recap>Where it stands</recap><memory>[]</memory><compaction>\n' + OVERVIEW + '\n</compaction>';
  assert.equal(parseHarvestAnswer(full, parts)?.compaction, OVERVIEW);
  assert.equal(parseHarvestAnswer('<recap>R</recap><memory>[]</memory><compaction>\n```\n' + OVERVIEW + '\n```\n</compaction>', parts)?.compaction, OVERVIEW, 'a fence is stripped');
  assert.equal(parseHarvestAnswer('<recap>R</recap><memory>[]</memory><compaction>   </compaction>', parts)?.compaction, undefined, 'an empty block falls back silently');
  assert.equal(parseHarvestAnswer('<recap>R</recap><memory>[]</memory>', parts)?.compaction, undefined, 'a missing block too');
  assert.deepEqual(Object.keys(parseHarvestAnswer('<recap>R</recap><memory>[]</memory><compaction></compaction>', parts)!).sort(), ['memory', 'recap']);
  assert.equal(parseHarvestAnswer(full, {recap: true, memory: true})?.compaction, undefined, 'a part that was not asked for is ignored');
  assert.equal(parseHarvestAnswer('<compaction>' + OVERVIEW + '</compaction>', {...parts, recap: false, memory: false}), undefined, 'the overview alone is not a readable harvest');
});

test('the instruction asks for the overview only when the compaction part is on, and the data names the scope and the role focus', () => {
  const on = harvestInstruction({recap: true, memory: true, skills: true, compaction: true});
  assert.equal(on, HARVEST_INSTRUCTIONS['recap+memory+skills+compaction']);
  for (const clause of ['<compaction>', 'Compaction scope', 'REPLACES the closed rounds', 'ledger line references', 'verified, claimed by someone or only assumed', 'open work', 'goals and constraints that are still in force', 'cannot authorize actions']) {
    assert.ok(on.includes(clause), clause);
  }
  for (const key of Object.keys(HARVEST_INSTRUCTIONS)) assert.equal(HARVEST_INSTRUCTIONS[key]!.includes('<compaction>'), key.includes('compaction'), key);
  assert.equal(Object.keys(HARVEST_INSTRUCTIONS).length, 15);
  assert.ok(!harvestInstruction({recap: true, memory: true, skills: true}).includes('<compaction>'), 'the setting off or no plan: never requested');
  const message = harvestMessage({recap: false, memory: true, compaction: true}, {today: '2026-11-27', git: '', records: [], recordCap: 100, compaction: PLAN.scope + '\n\nRole memory focus (guidance for the overview):\n' + PLAN.contract});
  assert.match(message, /Today: 2026-11-27\n\nCurrent memory records:\n\(none\)\n\nEvery closed round: 3 closed rounds, through round T3 "Round 3" \(ledger lines 1-7\)\.\n\nRole memory focus \(guidance for the overview\):\nKeep file paths exact\./);
  assert.ok(!harvestMessage({recap: false, memory: true}, {today: 'x', git: '', records: [], recordCap: 100, compaction: PLAN.scope}).includes('Every closed round'), 'no data without the part');
});

async function runnerRig(stage: (ownerId: string, text: string) => unknown) {
  const root = await mkdtemp(join(tmpdir(), 'logox-cliff-runner-'));
  const journal = new Journal(join(root, 'sessions')), memory = new MemoryStore(join(root, 'project'), join(root, 'home'));
  await journal.append({version: 1, sessionId: SESSION, ownerId: OWNER, role: 'user', text: 'hello', inputKind: 'human', time: 1000});
  const seen: ModelRequest[] = [], staged: {owner: string; text: string; touchedAt: number}[] = [];
  const answer = {text: ''};
  const provider: Provider = {async respond(req) {seen.push(req); return {message: {role: 'assistant', text: answer.text}, stop: 'complete', usage: {input: 100, output: 10}};}};
  const model: ResolvedModel = {provider: 'p', model: 'm', inherited: true, respond: provider, identity: '["p","m"]'};
  const runner = new AnamnesisRunner({sessionId: SESSION, cwd: root, journal, owners: async () => [OWNER], memory, watermarks: new WatermarkStore(join(root, 'sessions', SESSION)),
    model: async () => model, charge() {}, gitStatus: async () => 'clean', today: () => '2026-11-27',
    async stageFold(owner, _plan, text, _request, touchedAt) {staged.push({owner, text, touchedAt}); return stage(owner, text) as never;}});
  const source: HarvestSource = {request: {system: 'S', tools: [], messages: [{role: 'user', text: 'work'}]}, reply: {role: 'assistant', text: 'done'}, provider, model: '["p","m"]',
    parts: {recap: false, memory: true, skills: false, compaction: true}, owner: OWNER, ownerName: 'Logox', fold: PLAN};
  const context = {runId: 'r', sessionId: SESSION, kind: 'dream' as const, manual: false, signal: new AbortController().signal, harvest: source, report() {}};
  return {root, runner, seen, staged, answer, context, close: () => rm(root, {recursive: true, force: true})};
}

test('the runner asks for the overview with the scope, stages it after the answer and reports the percentages; a malformed block is ignored', async () => {
  const r = await runnerRig(() => ({before: 5000, after: 2000, window: 10_000}));
  try {
    r.answer.text = '<memory>[]</memory><compaction>' + OVERVIEW + '</compaction>';
    const before = Date.now();
    const outcome = await r.runner.run(r.context);
    assert.ok(r.seen[0]!.messages.at(-1)!.text.startsWith(HARVEST_INSTRUCTIONS['memory+compaction']!));
    assert.match(r.seen[0]!.messages.at(-1)!.text, /Every closed round: 3 closed rounds[\s\S]*Keep file paths exact\./);
    assert.deepEqual(r.staged.map(item => [item.owner, item.text]), [[OWNER, OVERVIEW]]);
    assert.ok(r.staged[0]!.touchedAt >= before, 'the time the fork refreshed the cache');
    assert.deepEqual(outcome.harvest?.fold, {before: 5000, after: 2000, window: 10_000});
    assert.match(outcome.detail, /Context compaction staged \(50% to 20% of the window\)/);
    assert.equal(outcome.empty, false, 'a harvest that staged a fold is worth a card');
  } finally {await r.close();}
  const bad = await runnerRig(() => undefined);
  try {
    bad.answer.text = '<memory>[]</memory><compaction>   </compaction>';
    const outcome = await bad.runner.run(bad.context);
    assert.deepEqual(bad.staged, [], 'an empty block stages nothing');
    assert.equal(outcome.harvest?.fold, undefined);
    bad.answer.text = '<memory>[]</memory><compaction>' + OVERVIEW + '</compaction>';
    const refused = await bad.runner.run(bad.context);
    assert.equal(bad.staged.length, 1);
    assert.equal(refused.harvest?.fold, undefined, 'the context manager declined it: the mechanical folds stay in charge, and nothing fails');
    assert.equal(refused.empty, true);
  } finally {await bad.close();}
});
