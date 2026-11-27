import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {MemoryStore} from '../src/anamnesis/memory.js';
import {changesPage, harvestRequest, parseHarvestAnswer, type HarvestSource} from '../src/anamnesis/harvest.js';
import {HARVEST_INSTRUCTION_BOTH, HARVEST_INSTRUCTION_MEMORY, HARVEST_INSTRUCTION_RECAP} from '../src/anamnesis/prompts.js';
import type {ResolvedModel} from '../src/anamnesis/model.js';
import {AnamnesisRunner} from '../src/anamnesis/runner.js';
import {Anamnesis, type AnamnesisDriver} from '../src/anamnesis/service.js';
import {WatermarkStore} from '../src/anamnesis/watermark.js';
import {loadConfig, type ModelSettings} from '../src/config/config.js';
import {CacheKeeper, type KeepAliveReason, type KeepAliveWho} from '../src/kernel/cache-keepalive.js';
import {HarvestTiming, type HarvestRun} from '../src/kernel/harvest-timing.js';
import {createProvider} from '../src/providers/http.js';
import {flushFingerprints, type FingerprintRecord} from '../src/providers/fingerprint.js';
import type {CacheProfile, ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {cacheLook} from '../src/tui/status/statusbar.js';
import {Journal, type HistoryEntry} from '../src/store/journal.js';
import {createTestApplication as createApplication, waitForSnapshot} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

const MINUTE = 60_000;
const who: KeepAliveWho = {sessionId: 's', ownerId: 'logox', activityId: 'a', rootActivityId: 'a'};
const MODEL = JSON.stringify(['anthropic', 'claude-test']);
const cheapRead = {models: {'anthropic/claude-test': {prices: {currency: 'USD', input: 3, output: 15, cache_read: 0.03, cache_write: 3.75}}}};
const dearRead = {models: {'anthropic/claude-test': {prices: {currency: 'USD', input: 3, output: 15, cache_read: 0.3, cache_write: 3.75}}}};
const REPLY = {role: 'assistant' as const, text: 'All done.'};
const request = (): ModelRequest => ({system: 'rules', tools: [], messages: [{role: 'user', text: 'hello'}], cacheKey: 'k'});
const settle = async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));};
async function advance(ms: number) {mock.timers.tick(ms); await settle();}
async function run(ms: number, step = 30_000) {for (let elapsed = 0; elapsed < ms; elapsed += step) await advance(step);}
const withClock = (body: () => Promise<void>) => async () => {
  mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_000_000});
  try {await body();} finally {mock.timers.reset();}
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Timing: when the harvest fires, on top of the cache keeper.
// ---------------------------------------------------------------------------------------------------------------------------------------------
function timingRig(options: {ttlMs: number; certain?: KeepAliveReason | false; awayMinutes?: number; replayable?: boolean; lifetimeMs?: number | null; decline?: boolean; pricing?: typeof cheapRead}) {
  const pings: number[] = [], starts: number[] = [], cancelled: number[] = [];
  const profile: CacheProfile | undefined = options.replayable === false ? undefined : {ttlMs: options.ttlMs, replayable: true};
  const usage: ModelTurn['usage'] = {input: 100_000, output: 1, cacheRead: 100_000};
  const provider: Provider = {
    async cacheProfile() {return profile;},
    async respond() {pings.push(Date.now()); return {message: {role: 'assistant', text: ''}, stop: 'length', usage};},
  };
  const state = {certain: options.certain ?? 'human' as KeepAliveReason | false, away: options.awayMinutes ?? 60, finish: undefined as ((applied: boolean) => void) | undefined};
  const lifetimeMs = options.lifetimeMs === null ? undefined : options.lifetimeMs ?? options.ttlMs;
  const timing = new HarvestTiming({
    lifetime: () => lifetimeMs === undefined ? undefined : {ms: lifetimeMs, confidence: 'known'},
    awayMs: () => state.away * MINUTE,
    async start() {
      if (options.decline) return undefined;
      starts.push(Date.now());
      return {finished: new Promise<boolean>(resolve => {state.finish = resolve;}), cancel() {cancelled.push(Date.now());}} satisfies HarvestRun;
    },
  });
  const keeper = new CacheKeeper({enabled: () => true, certain: () => state.certain, awayMs: () => state.away * MINUTE, pricing: options.pricing ?? cheapRead, charge: () => {}, harvest: timing});
  timing.attach({awaitingHuman: () => state.certain === 'human', touchedAt: actor => keeper.touchedAt(actor)});
  const arm = () => keeper.arm(who, {request: request(), provider, model: MODEL, startedAt: Date.now(), usage: {input: 100_000, output: 5, cacheRead: 100_000}, reply: REPLY});
  return {pings, starts, cancelled, state, timing, keeper, arm};
}

test('no away warm-ups: the harvest fires at the cache cliff (0.9 x lifetime) and nothing is pinged', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, awayMinutes: 0});
  await r.arm();
  assert.equal(r.timing.pending(), true, 'a harvest is scheduled');
  await run(4 * MINUTE);
  assert.deepEqual(r.starts, []);
  await run(MINUTE);
  assert.deepEqual(r.starts.map(at => at - 1_000_000), [270_000], 'at 4.5 minutes, the keeper cliff');
  assert.deepEqual(r.pings, [], 'the slot is the harvest, not a ping');
  assert.deepEqual(r.timing.phase(who), {state: 'running'});
  r.state.finish!(true);
  await settle();
  assert.deepEqual(r.timing.phase(who), {state: 'done', at: Date.now()});
  assert.equal(r.timing.pending(), false);
}));

test('a provider the keeper cannot replay keeps its own timer at the same cliff', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, replayable: false});
  await r.arm();
  await run(4 * MINUTE);
  assert.deepEqual(r.starts, []);
  await run(MINUTE);
  assert.deepEqual(r.starts.map(at => at - 1_000_000), [270_000]);
  assert.deepEqual(r.pings, []);
}));

test('an estimated or known lifetime longer than the keeper knows: the harvest cliff follows the lifetime the application reports', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, replayable: false, lifetimeMs: 30 * MINUTE});
  await r.arm();
  await run(26 * MINUTE);
  assert.deepEqual(r.starts, []);
  await run(2 * MINUTE);
  assert.deepEqual(r.starts.map(at => at - 1_000_000), [27 * MINUTE]);
}));

test('with away warm-ups the last warm slot is the harvest instead of a ping', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, awayMinutes: 60});
  await r.arm();
  await run(120 * MINUTE);
  assert.equal(r.pings.length, 12, 'the plan was thirteen warm-ups; the thirteenth is the harvest');
  assert.deepEqual(r.starts.map(at => at - 1_000_000), [13 * 270_000]);
  assert.ok(r.starts[0]! - 1_000_000 < 60 * MINUTE, 'inside the away budget');
  assert.equal(r.keeper.state(who), undefined, 'the keeper stopped after the harvest');
}));

test('while a companion works (peer wait) nothing is harvested and the keeper keeps pinging', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, certain: 'peer'});
  await r.arm();
  await run(60 * MINUTE);
  assert.ok(r.pings.length > 0);
  assert.deepEqual(r.starts, []);
  const standalone = timingRig({ttlMs: 5 * MINUTE, replayable: false, certain: 'peer'});
  await standalone.arm();
  await run(10 * MINUTE);
  assert.deepEqual(standalone.starts, [], 'the standalone timer also sees that the human is not the one awaited');
  assert.equal(standalone.timing.pending(), false, 'and stops expecting a harvest');
}));

test('the keeper giving up early on cost is a cliff too: the harvest runs at that slot instead of the cache dying', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, awayMinutes: 600, pricing: dearRead});
  await r.arm();
  await run(120 * MINUTE);
  assert.equal(r.pings.length, 11, 'the cumulative cost cap ends the warm-ups');
  assert.deepEqual(r.starts.map(at => at - 1_000_000), [12 * 270_000], 'the harvest takes the slot where the keeper would have stopped');
  assert.equal(r.keeper.state(who), undefined);
}));

test('an unknown price stops the keeper at its first slot and the harvest runs there', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, awayMinutes: 60, pricing: {models: {}} as never});
  await r.arm();
  await run(10 * MINUTE);
  assert.deepEqual(r.pings, []);
  assert.deepEqual(r.starts.map(at => at - 1_000_000), [270_000]);
  const peer = timingRig({ttlMs: 5 * MINUTE, certain: 'peer', pricing: {models: {}} as never});
  await peer.arm();
  await run(10 * MINUTE);
  assert.deepEqual(peer.starts, [], 'a peer wait never harvests');
}));

test('a harvest that declines leaves the keeper to ping as before', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, awayMinutes: 60, decline: true});
  await r.arm();
  await run(120 * MINUTE);
  assert.equal(r.pings.length, 13);
  assert.deepEqual(r.starts, []);
}));

test('an unknown lifetime schedules nothing: no harvest, nothing pending', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, lifetimeMs: null});
  await r.arm();
  assert.equal(r.timing.pending(), false);
  await run(120 * MINUTE);
  assert.deepEqual(r.starts, []);
}));

test('a real request of the Director cancels a scheduled harvest, a running one and the widget state', withClock(async () => {
  const early = timingRig({ttlMs: 5 * MINUTE, replayable: false});
  await early.arm();
  await run(2 * MINUTE);
  early.keeper.wake(who);
  await run(10 * MINUTE);
  assert.deepEqual(early.starts, [], 'woken before the cliff');
  assert.equal(early.timing.pending(), false);

  const running = timingRig({ttlMs: 5 * MINUTE, replayable: false});
  await running.arm();
  await run(5 * MINUTE);
  assert.equal(running.starts.length, 1);
  running.keeper.wake(who);
  assert.equal(running.cancelled.length, 1, 'a running harvest is cancelled');
  assert.equal(running.timing.phase(who), undefined);
  running.state.finish!(false); await settle();
  assert.equal(running.timing.phase(who), undefined);

  const finished = timingRig({ttlMs: 5 * MINUTE, replayable: false});
  await finished.arm();
  await run(5 * MINUTE);
  finished.state.finish!(true); await settle();
  assert.equal(finished.timing.phase(who)?.state, 'done');
  finished.keeper.wake(who);
  assert.equal(finished.timing.phase(who), undefined, '"harvested" lasts until the next real request');
}));

test('a reply that still carries tool calls is never harvested', withClock(async () => {
  const r = timingRig({ttlMs: 5 * MINUTE, replayable: false});
  await r.keeper.arm(who, {request: request(), provider: {async respond() {throw new Error('unused');}}, model: MODEL, startedAt: Date.now(),
    usage: {input: 100_000, output: 5, cacheRead: 100_000}, reply: {role: 'assistant', text: '', toolCalls: [{id: 'c', name: 'Read', arguments: '{}'}]}});
  assert.equal(r.timing.pending(), false);
  await run(10 * MINUTE);
  assert.deepEqual(r.starts, []);
}));

test('the idle recap and dream wait while a harvest is planned soon, and not for one planned beyond an hour', withClock(async () => {
  const soon = timingRig({ttlMs: 5 * MINUTE, replayable: false});
  await soon.arm();
  assert.equal(soon.timing.pending(), true);
  const late = timingRig({ttlMs: 12 * 60 * MINUTE, replayable: false});
  await late.arm();
  assert.equal(late.timing.pending(), false, 'a 12-hour cache would silence the idle paths for hours; the watermarks prevent repeats instead');
}));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The service: idle clocks defer to a planned harvest; a harvest never queues.
// ---------------------------------------------------------------------------------------------------------------------------------------------
test('the idle recap and dream do not start while a harvest is planned, and a harvest does not start over another run or a pending question', async () => {
  const store = new RuntimeStore();
  let now = 0, deferred = true, runs = 0;
  const driver: AnamnesisDriver = {async material() {return true;}, async run() {runs++; return {stage: 'x', detail: ''};}};
  const service = new Anamnesis('s', store, driver, () => false, {clock: () => now, recapIdleMs: 5 * MINUTE, dreamIdleMs: 30 * MINUTE, deferred: () => deferred});
  now = 6 * MINUTE;
  await service.tick();
  assert.equal(runs, 0, 'deferred to the harvest');
  deferred = false;
  await service.tick(); while (service.running()) await delay(1);
  assert.equal(runs, 1, 'a model with no harvest keeps its idle recap');
  const source = {request: request(), reply: REPLY, provider: {async respond() {throw new Error('unused');}} as Provider, model: MODEL, parts: {recap: true, memory: false}};
  assert.ok(service.startHarvest(source), 'free to start');
  assert.equal(service.startHarvest(source), undefined, 'single flight: no second run');
  await service.pause();
  await service.close();
  assert.equal(service.startHarvest(source), undefined, 'a closed service starts nothing');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The fork request and the answer.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const SESSION = 's1';
let clock = 0;
const entryBase = (ownerId: string) => ({version: 1 as const, sessionId: SESSION, ownerId, time: ++clock * 1000});
const human = (owner: string, text: string): HistoryEntry => ({...entryBase(owner), role: 'user', text, inputKind: 'human'});
const said = (owner: string, text: string): HistoryEntry => ({...entryBase(owner), role: 'assistant', text, message: {role: 'assistant', text}});
const SAVE = {op: 'save', scope: 'project', type: 'feedback', name: 'prefers-tabs', description: 'The user wants tabs, not spaces', content: 'Why: said so.\nHow to apply: every file.'};
const ANSWER = '<recap>\nUploader retries done\n\nDone: retries\nOpen: nothing\nNext: ship\n</recap>\n<memory>\n' + JSON.stringify([SAVE]) + '\n</memory>';

interface Rig {
  root: string; journal: Journal; memory: MemoryStore; watermarks: WatermarkStore; requests: ModelRequest[]; charged: {usage: ModelTurn['usage']; identity: string}[];
  answer: {message: ModelTurn['message']; wait?: Promise<void>};
  runner(): AnamnesisRunner;
  source(parts: {recap: boolean; memory: boolean}): HarvestSource;
  close(): Promise<void>;
}
async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'logox-harvest-'));
  const journal = new Journal(join(root, 'sessions')), memory = new MemoryStore(join(root, 'project'), join(root, 'home'));
  const watermarks = new WatermarkStore(join(root, 'sessions', SESSION));
  const requests: ModelRequest[] = [], charged: Rig['charged'] = [], answer: Rig['answer'] = {message: {role: 'assistant', text: ANSWER}};
  const provider: Provider = {async respond(req, _delta, signal) {
    requests.push(req);
    if (answer.wait) await Promise.race([answer.wait, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}))]);
    signal.throwIfAborted();
    return {message: answer.message, stop: 'complete', usage: {input: 5000, output: 90, cacheRead: 4800}};
  }};
  const model: ResolvedModel = {provider: 'p', model: 'm', inherited: true, respond: {async respond() {throw new Error('a harvest must not use the transcript model');}}, identity: JSON.stringify(['p', 'm'])};
  return {root, journal, memory, watermarks, requests, charged, answer,
    runner: () => new AnamnesisRunner({sessionId: SESSION, cwd: root, journal, owners: async () => ['logox', 'techne'], memory, watermarks, model: async () => model,
      charge() {}, chargeHarvest: (usage, identity) => {charged.push({usage, identity});}, gitStatus: async () => 'Branch main (clean working tree)', today: () => '2026-11-27'}),
    source: parts => ({request: {system: 'SYSTEM', tools: [{name: 'Read', description: 'Read', parameters: {type: 'object'}}], messages: [{role: 'user', text: 'Add a retry'}, {role: 'assistant', text: 'Looking', toolCalls: [{id: 'c1', name: 'Read', arguments: '{}'}]},
      {role: 'tool', callId: 'c1', name: 'Read', text: 'file', isError: false}], cacheKey: 'logox-key', cacheRetention: {role: 'long'}, toolDiscovery: 'anthropic', maxTokens: 9000},
      reply: {role: 'assistant', text: 'Done in src/upload.ts.'}, provider, model: JSON.stringify(['p', 'm']), parts}),
    close: () => rm(root, {recursive: true, force: true})};
}
const context = (r: Rig, source: HarvestSource, signal = new AbortController().signal) => ({runId: 'r', sessionId: SESSION, kind: 'recap' as const, manual: false, signal, harvest: source, report() {}});

test('the fork is the last request untouched plus the reply and one instruction message; nothing is a transcript', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'Add a retry'));
    const source = r.source({recap: true, memory: true});
    await r.runner().run(context(r, source));
    const sent = r.requests[0]!;
    assert.equal(sent.system, source.request.system);
    assert.deepEqual(sent.tools, source.request.tools);
    for (const field of ['cacheKey', 'cacheRetention', 'toolDiscovery', 'maxTokens'] as const) assert.deepEqual(sent[field], source.request[field], field + ' stays as it was sent');
    assert.deepEqual(sent.messages.slice(0, 3), source.request.messages, 'every earlier message is the same object content');
    assert.deepEqual(sent.messages[3], source.reply, 'the reply the model gave');
    assert.equal(sent.messages.length, 5);
    assert.equal(sent.messages[4]!.role, 'user');
    assert.ok(sent.messages[4]!.text.startsWith(HARVEST_INSTRUCTION_BOTH));
    assert.match(sent.messages[4]!.text, /Today: 2026-11-27\n\nWorking tree:\nBranch main \(clean working tree\)\n\nCurrent memory records:\n\(none\)$/);
    assert.equal(sent.purpose, 'harvest');
    assert.equal(sent.stream, false);
    assert.equal(source.request.messages.length, 3, 'the source request is not modified');
    assert.deepEqual(r.charged, [{usage: {input: 5000, output: 90, cacheRead: 4800}, identity: '["p","m"]'}], 'charged to the Director meter through chargeHarvest');
  } finally {await r.close();}
});

test('the variants of the instruction follow the parts, and the memory rules carry the anti-degeneration clauses', () => {
  assert.ok(HARVEST_INSTRUCTION_BOTH.includes('<recap>') && HARVEST_INSTRUCTION_BOTH.includes('<memory>'));
  assert.ok(HARVEST_INSTRUCTION_RECAP.includes('<recap>') && !HARVEST_INSTRUCTION_RECAP.includes('<memory>') && !HARVEST_INSTRUCTION_RECAP.includes('Memory rules'));
  assert.ok(HARVEST_INSTRUCTION_MEMORY.includes('<memory>') && !HARVEST_INSTRUCTION_MEMORY.includes('<recap>') && !HARVEST_INSTRUCTION_MEMORY.includes('Recap rules'));
  for (const text of [HARVEST_INSTRUCTION_BOTH, HARVEST_INSTRUCTION_MEMORY]) {
    for (const clause of ['logs, dated diary entries', 'Patch in place', 'one-off environment failure', 'dead end', 'label on the user', 'not verified', 'web pages, tool output or files']) assert.ok(text.includes(clause), clause);
  }
  for (const text of [HARVEST_INSTRUCTION_BOTH, HARVEST_INSTRUCTION_RECAP, HARVEST_INSTRUCTION_MEMORY]) assert.ok(text.includes('do not call tools'));
});

test('the answer: both blocks, a fenced array, the dream object form, a missing block, and nothing readable', () => {
  const both = {recap: true, memory: true};
  assert.deepEqual(parseHarvestAnswer(ANSWER, both), {recap: 'Uploader retries done\n\nDone: retries\nOpen: nothing\nNext: ship', memory: [SAVE]});
  assert.deepEqual(parseHarvestAnswer('<memory>\n```json\n[]\n```\n</memory>', both), {memory: []});
  assert.deepEqual(parseHarvestAnswer('<memory>{"operations": [{"op": "delete", "name": "x"}]}</memory>', both), {memory: [{op: 'delete', name: 'x'}]});
  assert.deepEqual(parseHarvestAnswer('<RECAP>Where it stands</RECAP>', both), {recap: 'Where it stands'}, 'a block that is missing is nothing, case does not matter');
  assert.deepEqual(parseHarvestAnswer(ANSWER, {recap: false, memory: true}), {memory: [SAVE]}, 'a part that was not asked for is ignored');
  assert.equal(parseHarvestAnswer('', both), undefined, 'a tool-call-only answer has no text');
  assert.equal(parseHarvestAnswer('I think so.', both), undefined);
  assert.equal(parseHarvestAnswer('<memory>not json</memory>', {recap: false, memory: true}), undefined);
});

test('recap and memory are applied only after the answer; both watermarks move, the dream one for the Director alone', async () => {
  const r = await rig();
  try {
    for (const entry of [human('logox', 'Add a retry'), said('logox', 'Done'), said('techne', 'A companion report')]) await r.journal.append(entry);
    const outcome = await r.runner().run(context(r, r.source({recap: true, memory: true})));
    assert.equal(outcome.stage, 'Uploader retries done');
    assert.equal(outcome.detail, "Done: retries\n\nOpen: nothing\n\nNext: ship\n\nRemembered in this project's memory\n• prefers-tabs (preference): The user wants tabs, not spaces");
    assert.deepEqual((await r.memory.list()).map(record => record.scope + '/' + record.name), ['project/prefers-tabs']);
    assert.deepEqual(outcome.harvest?.recap, true);
    assert.deepEqual(outcome.harvest?.changes.map(change => [change.kind, change.scope, change.name]), [['created', 'project', 'prefers-tabs']]);
    assert.deepEqual(JSON.parse(await readFile(join(r.root, 'sessions', SESSION, 'anamnesis.json'), 'utf8')), {version: 1, recap: {logox: 2, techne: 1}, dream: {logox: 2}});
    assert.equal(await r.runner().material('dream'), true, 'the companion report is still unreviewed by the dream path');
  } finally {await r.close();}
});

test('an update shows before and after; the page lists created, updated and deleted records', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'Please use tabs'));
    await r.memory.save({name: 'prefers-tabs', description: 'Old description', type: 'feedback', content: 'Old text.'}, 'project');
    await r.memory.save({name: 'stale', description: 'Gone soon', type: 'project', content: 'Stale.'}, 'project');
    r.answer.message = {role: 'assistant', text: '<memory>' + JSON.stringify([SAVE, {op: 'delete', scope: 'project', name: 'stale'}, {op: 'save', scope: 'user', type: 'user', name: 'role', description: 'Staff engineer', content: 'Staff.'}]) + '</memory>'};
    const outcome = await r.runner().run(context(r, r.source({recap: false, memory: true})));
    const changes = outcome.harvest!.changes;
    assert.deepEqual(changes.map(change => change.kind + ':' + change.scope + '/' + change.name), ['updated:project/prefers-tabs', 'created:user/role', 'deleted:project/stale']);
    assert.deepEqual(changes[0]!.before, {description: 'Old description', content: 'Old text.'});
    assert.deepEqual(changes[0]!.after, {description: 'The user wants tabs, not spaces', content: 'Why: said so.\nHow to apply: every file.'});
    const page = changesPage(changes);
    assert.match(page, /## Updated · project\/prefers-tabs \(feedback\)\n\nBefore: Old description\n\n> Old text\.\n\nAfter: The user wants tabs, not spaces/);
    assert.match(page, /## Created · user\/role \(user\)/);
    assert.match(page, /## Deleted · project\/stale \(project\)\n\nGone soon\n\n> Stale\./);
    assert.equal(outcome.stage, 'Saved 2 memory records, removed 1');
    const request = r.requests[0]!;
    assert.match(request.messages.at(-1)!.text, /Current memory records:\n## project\/prefers-tabs \(feedback\)\nOld description\nOld text\./, 'the model sees the text it is asked to patch');
  } finally {await r.close();}
});

test('secrets are dropped, at most six operations apply and a user record goes to the user folder, exactly as in a dream', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'x'));
    const ops = [{op: 'save', scope: 'project', type: 'user', name: 'me', description: 'Staff', content: 'Staff.'},
      {op: 'save', scope: 'project', type: 'reference', name: 'leak', description: 'Key', content: 'api_key = sk-abcdefghijklmnopqrstuvwxyz'},
      ...Array.from({length: 8}, (_, index) => ({op: 'save', scope: 'project', type: 'project', name: 'fact-' + index, description: 'd', content: 'c'}))];
    r.answer.message = {role: 'assistant', text: '<memory>' + JSON.stringify(ops) + '</memory>'};
    await r.runner().run(context(r, r.source({recap: false, memory: true})));
    const names = (await r.memory.list()).map(record => record.scope + '/' + record.name);
    assert.ok(names.includes('user/me') && !names.some(name => name.includes('leak')));
    assert.equal(names.length, 6, 'the secret is dropped first, then the first six remain');
  } finally {await r.close();}
});

test('an answer of only tool calls, or one that cannot be read, fails without applying anything or moving a watermark', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'Add a retry'));
    r.answer.message = {role: 'assistant', text: '', toolCalls: [{id: 'c', name: 'Write', arguments: '{"file_path":"x"}'}]};
    await assert.rejects(r.runner().run(context(r, r.source({recap: true, memory: true}))), /could not read the harvest answer/);
    r.answer.message = {role: 'assistant', text: 'Sure, here is what I think.'};
    await assert.rejects(r.runner().run(context(r, r.source({recap: true, memory: true}))), /could not read the harvest answer/);
    assert.deepEqual(await r.memory.list(), []);
    assert.deepEqual(await r.watermarks.read(), {version: 1, recap: {}, dream: {}});
    assert.equal(r.charged.length, 2, 'the requests were answered and paid for');
  } finally {await r.close();}
});

test('an abort while the model answers applies nothing', async () => {
  const r = await rig();
  try {
    await r.journal.append(human('logox', 'Add a retry'));
    let release!: () => void;
    r.answer.wait = new Promise<void>(resolve => {release = resolve;});
    const controller = new AbortController();
    const running = r.runner().run(context(r, r.source({recap: true, memory: true}), controller.signal));
    const settled = assert.rejects(running);
    await delay(10);
    controller.abort('pause');
    await settled;
    release();
    assert.deepEqual(await r.memory.list(), []);
    assert.deepEqual(await r.watermarks.read(), {version: 1, recap: {}, dream: {}});
    assert.deepEqual(r.charged, []);
  } finally {await r.close();}
});

test('the parts of a harvest follow the switches and the new material of each', async () => {
  const r = await rig();
  try {
    const runner = r.runner();
    assert.deepEqual(await runner.harvestParts({recap: true, memory: true}), {recap: false, memory: false}, 'an empty session has nothing to harvest');
    await r.journal.append(human('logox', 'Add a retry'));
    assert.deepEqual(await runner.harvestParts({recap: true, memory: true}), {recap: true, memory: true});
    assert.deepEqual(await runner.harvestParts({recap: false, memory: true}), {recap: false, memory: true});
    assert.deepEqual(await runner.harvestParts({recap: false, memory: false}), {recap: false, memory: false}, 'both switches off: no harvest');
    await r.watermarks.save('recap', {logox: 1});
    assert.deepEqual(await runner.harvestParts({recap: true, memory: true}), {recap: false, memory: true}, 'the recap already covers it');
    await r.watermarks.merge('dream', {logox: 1});
    await r.journal.append(said('techne', 'A companion report'));
    assert.deepEqual(await runner.harvestParts({recap: false, memory: true}), {recap: false, memory: false}, 'companion material is the dream path, not the Director harvest');
    assert.deepEqual(await runner.harvestParts({recap: true, memory: true}), {recap: true, memory: false}, 'but it is new to the session-level recap');
  } finally {await r.close();}
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The prefix: the fingerprint of the fork starts with the fingerprint of the real request.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const anthropic = (): ModelSettings => ({kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', key: 'sk-ant-TOPSECRET', temperature: 0.2, maxTokens: 4096, timeoutMs: 5000});
const wire = () => new Response(JSON.stringify({content: [{type: 'text', text: 'ok'}], stop_reason: 'end_turn', usage: {input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}}),
  {status: 200, headers: {'content-type': 'application/json'}});

test('the request fingerprints prove the fork keeps the tools, system, fields and every message hash of the real request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-harvest-fp-'));
  try {
    const file = join(root, 'requests', 'logox.fingerprints.jsonl');
    const provider = createProvider(anthropic(), (async () => wire()) as unknown as typeof fetch);
    const real: ModelRequest = {system: 'Stable rules\n\nvolatile', tools: [{name: 'Read', description: 'Read', parameters: {type: 'object'}}], cacheKey: 'k', cacheRetention: {role: 'long'},
      messages: [{role: 'user', text: 'build the page'}, {role: 'assistant', text: 'looking', toolCalls: [{id: 'c1', name: 'Read', arguments: '{"file_path":"a.html"}'}]},
        {role: 'tool', callId: 'c1', name: 'Read', text: 'file body', isError: false}],
      stream: false, fingerprint: {file, ownerId: 'logox', activityId: 'act1', purpose: 'task'}};
    const reply = {role: 'assistant' as const, text: 'All done.'};
    await provider.respond(real, () => {}, new AbortController().signal);
    await provider.respond(harvestRequest({request: real, reply, provider, model: MODEL, parts: {recap: true, memory: true}}, 'Review the session.'), () => {}, new AbortController().signal);
    await flushFingerprints();
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row['kind'] === 'request') as unknown as FingerprintRecord[];
    const [first, fork] = rows as [FingerprintRecord, FingerprintRecord];
    assert.deepEqual([first.purpose, fork.purpose], ['task', 'harvest']);
    assert.equal(fork.tools, first.tools, 'the tool list hashes the same');
    assert.deepEqual(fork.system, first.system, 'the system blocks hash the same');
    assert.deepEqual(fork.fields, first.fields, 'maxTokens, thinking, retention, lifetime, cache key, stream and discovery are unchanged');
    assert.deepEqual(fork.messages.slice(0, first.messages.length), first.messages, 'every leading message hash is the real request\'s');
    assert.deepEqual(fork.messages.slice(first.messages.length).map(block => block[2]), ['assistant', 'user'], 'then the reply and the instruction');
  } finally {await rm(root, {recursive: true, force: true});}
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The application: manual runs, the automatic harvest, notice, widget, usage.
// ---------------------------------------------------------------------------------------------------------------------------------------------
type App = Awaited<ReturnType<typeof createApplication>>;
const isTranscriptRun = (req: ModelRequest) => req.tools.length === 0 && req.purpose !== 'harvest' && req.system.startsWith('You are Anamnesis');
async function appFixture(options: {ttl?: number; hold?: boolean; auto?: Record<string, unknown>} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-harvest-app-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(home, {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072, ...(options.ttl ? {cache_ttl_seconds: options.ttl} : {})},
    ...(options.auto ? {anamnesis: options.auto} : {})}, {}, home, root);
  const seen: ModelRequest[] = [];
  const control = {answer: ANSWER, hold: options.hold ?? false, aborted: 0, toolOnly: false};
  const provider: Provider = {async respond(req, _delta, signal) {
    seen.push(req);
    if (req.purpose === 'harvest') {
      if (control.hold) await new Promise((_, reject) => signal.addEventListener('abort', () => {control.aborted++; reject(signal.reason);}, {once: true}));
      return {message: control.toolOnly ? {role: 'assistant', text: '', toolCalls: [{id: 'x', name: 'Write', arguments: '{}'}]} : {role: 'assistant', text: control.answer}, stop: 'complete', usage: {input: 2200, output: 80, cacheRead: 2000}};
    }
    if (isTranscriptRun(req)) return {message: {role: 'assistant', text: 'Transcript recap\n\nDone: x\nOpen: nothing\nNext: y'}, stop: 'complete', usage: {input: 400, output: 60}};
    return {message: {role: 'assistant', text: 'Understood, noted.'}, stop: 'complete', usage: {input: 2000, output: 20, cacheRead: 1800}};
  }};
  const apps: App[] = [];
  const open = async (extra: Record<string, unknown> = {}, sessionId = 'harvest-app'): Promise<App> => {
    const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json'), ...extra});
    apps.push(app); return app;
  };
  return {root, cwd, home, seen, control, open, memory: new MemoryStore(cwd, home),
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true});}};
}
async function speak(app: App, text: string) {
  const before = app.store.getSnapshot().activities.filter(activity => activity.status === 'completed').length;
  await app.submit(text);
  await waitForSnapshot(app.store, snapshot => snapshot.activities.filter(activity => activity.status === 'completed').length > before && !app.ensemble.isBusy());
}
const harvests = (seen: readonly ModelRequest[]) => seen.filter(req => req.purpose === 'harvest');
const real = (seen: readonly ModelRequest[]) => seen.filter(req => req.purpose !== 'harvest' && !isTranscriptRun(req));
const notices = (app: App) => app.notices.getSnapshot().filter(notice => notice.id.startsWith('harvest:'));

test('a manual recap while the Director\'s cache is warm forks its request; the recap, the card, the notice, the widget and the usage follow', async () => {
  const f = await appFixture({ttl: 300});
  try {
    const app = await f.open();
    await speak(app, 'Please add a retry to the uploader.');
    const last = real(f.seen).at(-1)!;
    assert.equal(app.status('logox').cache?.harvest, undefined, 'nothing harvested yet');
    const {runId, done} = app.anamnesis.runNow('recap');
    assert.equal(app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!.stage, 'Harvesting the session');
    assert.deepEqual(app.status('logox').cache?.harvest, {state: 'running'});
    const result = await done;
    assert.equal(result.status, 'completed');
    assert.equal(f.seen.filter(isTranscriptRun).length, 0, 'no transcript request');
    const fork = harvests(f.seen)[0]!;
    assert.equal(fork.system, last.system);
    assert.deepEqual(fork.tools, last.tools);
    assert.deepEqual(fork.messages.slice(0, last.messages.length), last.messages, 'the prefix is the last real request\'s');
    assert.equal(fork.messages.at(-2)!.role, 'assistant');
    assert.ok(fork.messages.at(-1)!.text.startsWith(HARVEST_INSTRUCTION_RECAP), 'a recap run asks for the recap part only');
    const card = app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!;
    assert.deepEqual([card.status, card.stage, card.detail], ['completed', 'Uploader retries done', 'Done: retries\n\nOpen: nothing\n\nNext: ship']);
    assert.deepEqual(await f.memory.list(), [], 'the memory block was not asked for');
    const [notice] = notices(app);
    assert.deepEqual(notice!.parts.map(part => part.text), [notice!.parts[0]!.text, 'recap']);
    assert.match(notice!.parts[0]!.text, /^Harvested \d\d:\d\d$/);
    assert.deepEqual(notice!.parts[1]!.action, {kind: 'jump-activity', activityId: runId});
    assert.equal(notice!.tone, 'info');
    const cache = app.status('logox').cache!;
    assert.equal(cache.harvest?.state, 'done');
    assert.equal(cacheLook({...app.status('logox')}, Date.now()).kind, 'harvested');
    const meter = app.contexts.sessionMeters(app.sessionId).get('logox')!;
    assert.deepEqual(meter.usageRecords().filter(record => record.category === 'harvest').map(record => [record.input, record.output, record.cacheRead]), [[2200, 80, 2000]], 'charged to the Director as category harvest');
    assert.equal(app.contexts.sessionMeters(app.sessionId).get('anamnesis')?.usageRecords().length ?? 0, 0);
    // The next real request ends the "harvested" state.
    await speak(app, 'And one more thing.');
    assert.equal(app.status('logox').cache?.harvest, undefined);
  } finally {await f.close();}
});

test('a manual dream forks too and applies the memory; the notice lists the change and opens a page', async () => {
  const f = await appFixture({ttl: 300});
  try {
    const app = await f.open();
    await speak(app, 'Please always use tabs.');
    const result = await app.anamnesis.runNow('dream').done;
    assert.equal(result.status, 'completed');
    assert.ok(harvests(f.seen)[0]!.messages.at(-1)!.text.startsWith(HARVEST_INSTRUCTION_MEMORY));
    assert.deepEqual((await app.anamnesis.memories()).map(record => record.name), ['prefers-tabs']);
    const [notice] = notices(app);
    assert.deepEqual(notice!.parts.map(part => part.text).slice(1), ['1 memory']);
    const action = notice!.parts[1]!.action;
    assert.equal(action?.kind, 'open-page');
    assert.match(action?.kind === 'open-page' ? action.text : '', /## Created · project\/prefers-tabs \(feedback\)/);
  } finally {await f.close();}
});

test('a cold cache (no lifetime known, or past it) uses the transcript path as before', async () => {
  const unknown = await appFixture();
  try {
    const app = await unknown.open();
    await speak(app, 'Please add a retry to the uploader.');
    const result = await app.anamnesis.runNow('recap').done;
    assert.equal(result.status, 'completed');
    assert.equal(harvests(unknown.seen).length, 0);
    assert.equal(unknown.seen.filter(isTranscriptRun).length, 1);
    assert.deepEqual(notices(app), [], 'only a harvest posts the notice');
    assert.equal(app.status('logox').cache, undefined, 'an unknown lifetime shows no countdown or harvest state');
  } finally {await unknown.close();}
  mock.timers.enable({apis: ['Date'], now: Date.now()});
  const expired = await appFixture({ttl: 300});
  try {
    const app = await expired.open();
    await speak(app, 'Please add a retry to the uploader.');
    mock.timers.tick(301_000);
    await app.anamnesis.runNow('recap').done;
    assert.equal(harvests(expired.seen).length, 0, 'the cache is past its lifetime');
    assert.equal(expired.seen.filter(isTranscriptRun).length, 1);
  } finally {mock.timers.reset(); await expired.close();}
});

test('user activity aborts a running harvest: nothing is applied, no card, no notice', async () => {
  const f = await appFixture({ttl: 300, hold: true});
  try {
    const app = await f.open();
    await speak(app, 'Please always use tabs.');
    const {done} = app.anamnesis.runNow('dream');
    await waitFor(() => harvests(f.seen).length, count => count === 1, {label: 'the fork is in flight'});
    assert.deepEqual(app.status('logox').cache?.harvest, {state: 'running'});
    await app.submit('stop that');
    const result = await done;
    assert.equal(result.status, 'aborted');
    assert.equal(f.control.aborted, 1);
    assert.deepEqual(await f.memory.list(), []);
    assert.deepEqual(notices(app), []);
    assert.deepEqual(app.store.getSnapshot().activities.filter(activity => activity.kind === 'anamnesis'), []);
    assert.equal(app.contexts.sessionMeters(app.sessionId).get('logox')!.usageRecords().filter(record => record.category === 'harvest').length, 0);
  } finally {await f.close();}
});

test('an answer of only tool calls fails the run: "could not read", nothing applied, nothing executed, no notice', async () => {
  const f = await appFixture({ttl: 300});
  try {
    const app = await f.open();
    await speak(app, 'Please always use tabs.');
    f.control.toolOnly = true;
    const result = await app.anamnesis.runNow('dream').done;
    assert.equal(result.status, 'failed');
    assert.match(result.status === 'failed' ? result.error : '', /could not read the harvest answer/);
    assert.deepEqual(await f.memory.list(), []);
    assert.deepEqual(notices(app), []);
    assert.equal(app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!.stage, 'Harvest failed');
  } finally {await f.close();}
});

// The automatic path: the keeper's cliff with the human awaited, on the application's real wiring and a fake clock.
async function sleepers() {for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve));}
async function autoApp(options: {auto?: Record<string, unknown>; ttl?: number} = {}) {
  mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_900_000_000_000});
  const f = await appFixture({ttl: options.ttl ?? 300, ...(options.auto ? {auto: options.auto} : {})});
  const app = await f.open();
  return {f, app};
}
const quiet = async (f: Awaited<ReturnType<typeof appFixture>>) => {mock.timers.reset(); await f.close();};

test('automatic: at the cliff of an idle Director the harvest forks its request, recap and memory in one answer, and posts the notice', async () => {
  const {f, app} = await autoApp();
  try {
    await speak(app, 'Please always use tabs.');
    assert.equal(harvests(f.seen).length, 0);
    mock.timers.tick(200_000); await sleepers();
    assert.equal(harvests(f.seen).length, 0, 'not before 0.9 x lifetime');
    mock.timers.tick(80_000); await sleepers();
    await waitFor(() => app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis'), card => card?.status === 'completed', {label: 'harvest card'});
    const fork = harvests(f.seen);
    assert.equal(fork.length, 1);
    assert.ok(fork[0]!.messages.at(-1)!.text.startsWith(HARVEST_INSTRUCTION_BOTH));
    assert.deepEqual(fork[0]!.messages.slice(0, real(f.seen).at(-1)!.messages.length), real(f.seen).at(-1)!.messages);
    assert.equal(f.seen.filter(isTranscriptRun).length, 0);
    const card = app.store.getSnapshot().activities.find(activity => activity.kind === 'anamnesis')!;
    assert.equal(card.stage, 'Uploader retries done');
    assert.match(card.detail, /Remembered in this project's memory\n• prefers-tabs/);
    assert.deepEqual((await app.anamnesis.memories()).map(record => record.name), ['prefers-tabs']);
    const [notice] = notices(app);
    assert.deepEqual(notice!.parts.map(part => part.text).slice(1), ['recap', '1 memory']);
    assert.equal(app.status('logox').cache?.harvest?.state, 'done');
    const marks = JSON.parse(await readFile(await findFile(f.root, 'anamnesis.json'), 'utf8')) as {recap: Record<string, number>; dream: Record<string, number>};
    assert.deepEqual(Object.keys(marks.dream), ['logox'], 'the dream watermark covers the Director journal only');
    assert.ok(marks.recap['logox']! >= marks.dream['logox']! && marks.dream['logox']! > 0);
    // Nothing new since: the next idle stretch makes no second harvest.
    await speak(app, 'ok');
    mock.timers.tick(290_000); await sleepers();
    await waitFor(() => harvests(f.seen).length, count => count === 2, {label: 'second harvest after new material'});
  } finally {await quiet(f);}
});

test('automatic: no new material, or both switches off, means no harvest', async () => {
  const off = await autoApp({auto: {recap: false, dream: false}});
  try {
    await speak(off.app, 'Please always use tabs.');
    mock.timers.tick(290_000); await sleepers();
    assert.equal(harvests(off.f.seen).length, 0, 'both switches off');
  } finally {await quiet(off.f);}
  const none = await autoApp();
  try {
    mock.timers.tick(290_000); await sleepers();
    assert.equal(harvests(none.f.seen).length, 0, 'nothing happened in the session');
  } finally {await quiet(none.f);}
});

test('automatic: the recap switch alone asks for the recap, the dream switch alone for the memory', async () => {
  const recap = await autoApp({auto: {recap: true, dream: false}});
  try {
    await speak(recap.app, 'Please always use tabs.');
    mock.timers.tick(290_000); await sleepers();
    await waitFor(() => harvests(recap.f.seen).length, count => count === 1, {label: 'recap-only harvest'});
    assert.ok(harvests(recap.f.seen)[0]!.messages.at(-1)!.text.startsWith(HARVEST_INSTRUCTION_RECAP));
  } finally {await quiet(recap.f);}
  const dream = await autoApp({auto: {recap: false, dream: true}});
  try {
    await speak(dream.app, 'Please always use tabs.');
    mock.timers.tick(290_000); await sleepers();
    await waitFor(() => harvests(dream.f.seen).length, count => count === 1, {label: 'memory-only harvest'});
    assert.ok(harvests(dream.f.seen)[0]!.messages.at(-1)!.text.startsWith(HARVEST_INSTRUCTION_MEMORY));
  } finally {await quiet(dream.f);}
});

test('automatic: a lifetime that is unknown plans no harvest, so the idle recap path keeps working for that model', async () => {
  mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_900_000_000_000});
  const f = await appFixture();
  try {
    let now = 0;
    const app = await f.open({anamnesis: {clock: () => now, tickMs: 5, recapIdleMs: 1000, dreamIdleMs: 5000}});
    await speak(app, 'what is the plan for the uploader');
    now = 1600;
    mock.timers.tick(20); await sleepers();
    await waitFor(() => f.seen.filter(isTranscriptRun).length, count => count >= 1, {label: 'the idle recap'});
    assert.equal(harvests(f.seen).length, 0);
  } finally {await quiet(f);}
});

test('automatic: while a harvest is planned the idle recap does not fire for the same material', async () => {
  mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_900_000_000_000});
  const f = await appFixture({ttl: 300});
  try {
    let now = 0;
    const app = await f.open({anamnesis: {clock: () => now, tickMs: 5, recapIdleMs: 1000, dreamIdleMs: 5000}});
    await speak(app, 'what is the plan for the uploader');
    now = 1600;
    mock.timers.tick(20); await sleepers();
    assert.equal(f.seen.filter(isTranscriptRun).length, 0, 'the idle recap waits for the harvest');
    now = 9000;
    mock.timers.tick(20); await sleepers();
    assert.equal(f.seen.filter(isTranscriptRun).length, 0, 'and so does the dream');
    mock.timers.tick(270_000); await sleepers();
    await waitFor(() => harvests(f.seen).length, count => count === 1, {label: 'the harvest at the cliff'});
    now = 20_000;
    mock.timers.tick(20); await sleepers();
    assert.equal(f.seen.filter(isTranscriptRun).length, 0, 'the harvest covered the material; the watermarks leave nothing for the idle paths');
  } finally {await quiet(f);}
});

async function findFile(root: string, name: string): Promise<string> {
  const {readdir} = await import('node:fs/promises');
  const walk = async (dir: string): Promise<string | undefined> => {
    for (const entry of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {const found = await walk(path); if (found) return found;}
      else if (entry.name === name) return path;
    }
    return undefined;
  };
  const found = await walk(root);
  if (!found) throw new Error(name + ' not found under ' + root);
  return found;
}
