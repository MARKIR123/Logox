import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {BACKGROUND_COALESCE_MS} from '../src/runtime/background-jobs.js';
import {AUTOMA_DESCRIPTION, BACKGROUND_RECEIPT_SENTENCE} from '../src/tools/orchestration/AutomaTool/prompt.js';
import {automaSchema, normalizeAutomaInput, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {resolveAfter} from '../src/tools/orchestration/AutomaTool/graph.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelMessage, ModelTurn} from '../src/runtime/messages.js';

const profile: AutomaProfile = {name: 'work crew', default_style: 'scout', write_style: 'edit', exclusive: [], styles: {scout: {flavor: 'Scout.'}, edit: {flavor: 'Edit.'}}};
const parkedRoot = join(tmpdir(), 'logox-automa-order-tests-' + process.pid);
let environments = 0;
after(() => rm(parkedRoot, {recursive: true, force: true}));

function principal(signal: AbortSignal = new AbortController().signal, overrides: Partial<ActorContext> = {}): ActorContext {
  return {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal, report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};},
    async permission() {throw new Error('Unexpected approval');}, ...overrides};
}
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-order-'));
  await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n');
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
  return {cwd, tools, done: async () => {await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}};
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const limit = Date.now() + ms;
  while (!check()) {if (Date.now() > limit) throw new Error('Timed out waiting for ' + what); await sleep(10);}
}

interface Plan {readonly delay?: number; readonly gate?: Promise<void>; readonly status?: 'done' | 'blocked' | 'throw'; readonly summary?: string; readonly evidence?: string[]; readonly read?: string;
  /** What the worker does when it is continued (its second run). */
  readonly next?: Plan}
interface Log {readonly events: string[]; readonly first: Map<string, string>; running: number; peak: number}
/** Scripted workers keyed by the opening words of their brief: each waits (delay, gate or the abort), may read a file once, then ends through Finish. */
function workers(script: Readonly<Record<string, Plan>>, log: Log = {events: [], first: new Map(), running: 0, peak: 0}): AutomaProvider {
  const turns = new Map<string, number>();
  return {async respond(request, _delta, signal) {
    const first = request.messages[0]?.text ?? '';
    const key = Object.keys(script).find(brief => first.startsWith(brief));
    assert.ok(key, 'No script for brief: ' + first);
    const at = turns.get(key) ?? 0;
    turns.set(key, at + 1);
    const plan = (at > 0 ? script[key]!.next : undefined) ?? script[key]!;
    if (at === 0 && plan.read) return {message: {role: 'assistant', text: '', toolCalls: [{id: 'r', name: 'Read', arguments: JSON.stringify({file_path: plan.read})}]}, stop: 'tools'} satisfies ModelTurn;
    log.events.push('start ' + key); log.first.set(key, first);
    log.running++; log.peak = Math.max(log.peak, log.running);
    try {
      await Promise.race([plan.gate ?? sleep(plan.delay ?? 15), new Promise((_, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
      })]);
    } finally {log.running--;}
    log.events.push('end ' + key);
    if (plan.status === 'throw') throw new Error('worker exploded');
    const args = plan.status === 'blocked' ? {status: 'blocked', summary: plan.summary ?? 'stuck', question: 'Which one?'}
      : {status: 'done', summary: plan.summary ?? key + ' ok', ...(plan.evidence ? {evidence: plan.evidence} : {})};
    return {message: {role: 'assistant', text: '', toolCalls: [{id: 'fin', name: 'Finish', arguments: JSON.stringify(args)}]}, stop: 'tools', usage: {input: 10, output: 5}};
  }};
}
const newLog = (): Log => ({events: [], first: new Map(), running: 0, peak: 0});
function environment(provider: AutomaProvider, overrides: Partial<AutomaEnvironment> = {}): AutomaEnvironment {
  const id = String(++environments);
  return {resolveModel: () => ({provider, model: 'mock/worker'}), profile: () => profile, workerDir: sessionId => join(parkedRoot, id, sessionId), ...overrides};
}
const job = (brief: string, extra: Record<string, unknown> = {}) => ({title: brief, brief, scope: 'bounded', ...extra});
const dispatch = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});
const position = (log: Log, event: string) => log.events.indexOf(event);

test('Graph: parallel, chain and diamond start in order; jobs without after start at once', async () => {
  const {tools, done} = await project();
  try {
    const log = newLog();
    tools.setAutomaEnvironment(environment(workers({alpha: {delay: 40}, bravo: {}, charlie: {}, delta: {}, echo: {delay: 10}}, log)));
    const result = await tools.execute(dispatch({jobs: [job('alpha'), job('bravo', {after: ['T1']}), job('charlie', {after: ['#1']}), job('delta', {after: ['bravo', 'T3']}), job('echo')]}), principal());
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /5\/5 done/);
    assert.deepEqual(log.events.slice(0, 2).sort(), ['start alpha', 'start echo'], 'only the jobs that follow nothing start first');
    assert.ok(position(log, 'start bravo') > position(log, 'end alpha') && position(log, 'start charlie') > position(log, 'end alpha'), 'the chain starts after its prerequisite is done');
    assert.ok(position(log, 'start delta') > position(log, 'end bravo') && position(log, 'start delta') > position(log, 'end charlie'), 'the join waits for both');
    assert.ok(log.peak >= 2, 'bravo and charlie run side by side');
  } finally {await done();}
});

test('Graph: a job receives the results of the jobs it follows after its brief, never their transcripts', async () => {
  const {tools, done} = await project();
  try {
    const log = newLog();
    tools.setAutomaEnvironment(environment(workers({first: {read: 'a.txt', summary: 'first summary', evidence: ['a.txt:1']}, second: {}}, log)));
    const result = await tools.execute(dispatch({jobs: [job('first'), job('second', {after: ['T1']})]}), principal());
    assert.equal(result.isError, false, result.text);
    const message = log.first.get('second')!;
    assert.ok(message.startsWith('second\n\nResults of the jobs this one follows:\n<automa-result id="T1"'), message);
    assert.match(message, /Summary: first summary\nEvidence:\n- a\.txt:1\n<\/automa-result>/);
    assert.doesNotMatch(message, /Trust:|one\ntwo|Read/, 'the report only, with no Trust line and no transcript');
    assert.doesNotMatch(log.first.get('first')!, /follows/, 'a job that follows nothing gets no such section');
  } finally {await done();}
});

test('Graph: waiting jobs take neither a running slot nor a place, and show as waiting with what they follow', async () => {
  const {tools, done} = await project();
  try {
    const log = newLog(), swarms: AutomaSwarm[] = [];
    tools.setAutomaEnvironment(environment(workers({late: {}, base: {delay: 30}, side: {delay: 30}}, log), {maxRunning: () => 1}));
    // `late` is listed first and follows `base`: if it held the only slot, nothing could ever start.
    const result = await tools.execute(dispatch({jobs: [job('late', {after: ['#2']}), job('base'), job('side')], parallel: 1}), principal(undefined, {reportSwarm: swarm => swarms.push(structuredClone(swarm))}));
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /3\/3 done/);
    assert.equal(log.peak, 1);
    assert.deepEqual(log.events.filter(event => event.startsWith('start ')), ['start base', 'start side', 'start late']);
    const early = swarms[0]!.jobs[0]!;
    assert.deepEqual([early.state, early.after], ['waiting', ['T2']]);
    assert.ok(swarms.some(item => item.jobs[0]!.state === 'queued' || item.jobs[0]!.state === 'running'), 'it leaves waiting once its prerequisite is done');
  } finally {await done();}
});

test('Graph: a prerequisite that does not end done skips every job after it, transitively, with dependency_unmet; skipped jobs are not shelved', async () => {
  const {tools, done} = await project();
  try {
    const swarms: AutomaSwarm[] = [];
    tools.setAutomaEnvironment(environment(workers({boom: {status: 'throw'}, mid: {}, tail: {}, fine: {}, join: {}})));
    const result = await tools.execute(dispatch({jobs: [job('boom'), job('mid', {after: ['T1']}), job('tail', {after: ['T2']}), job('fine'), job('join', {after: ['T4', 'T3']})]}),
      principal(undefined, {reportSwarm: swarm => swarms.push(structuredClone(swarm))}));
    assert.match(result.text, /^Automa dispatch · work crew · 1\/5 done · 3 skipped/);
    assert.match(result.text, /<automa-result id="T2" title="mid" status="skipped" stop="dependency_unmet"[^\n]*\nSummary: Not started: T1 ended failed\./);
    assert.match(result.text, /<automa-result id="T3" title="tail" status="skipped" stop="dependency_unmet"[^\n]*\nSummary: Not started: T2 ended skipped\./);
    assert.match(result.text, /<automa-result id="T5" title="join" status="skipped" stop="dependency_unmet"[^\n]*\nSummary: Not started: T3 ended skipped\./);
    assert.match(result.text, /<automa-result id="T4" title="fine" status="done"/);
    const last = swarms.at(-1)!.jobs;
    assert.deepEqual(last.map(item => item.state), ['failed', 'skipped', 'skipped', 'done', 'skipped']);
    assert.deepEqual(last.filter(item => item.state === 'skipped').map(item => item.stopReason), ['dependency_unmet', 'dependency_unmet', 'dependency_unmet']);
    const again = await tools.execute(dispatch({jobs: [job('mid', {continue: 'T2'})]}), principal());
    assert.match(again.text, /Worker T2 is closed or unknown/, 'a skipped job has no worker to continue');
  } finally {await done();}
});

test('Graph: a blocked prerequisite skips its dependent; after the dispatcher continues it, the dependent can be dispatched again, after the worker', async () => {
  const {tools, done} = await project();
  try {
    const log = newLog();
    tools.setAutomaEnvironment(environment(workers({ask: {status: 'blocked', next: {summary: 'ask again ok'}}, next: {}}, log)));
    const first = await tools.execute(dispatch({jobs: [job('ask'), job('next', {after: ['T1']})]}), principal());
    assert.match(first.text, /id="T1" title="ask" status="blocked"/);
    assert.match(first.text, /id="T2" title="next" status="skipped" stop="dependency_unmet"[^\n]*\nSummary: Not started: T1 ended blocked\./);
    assert.equal(log.events.includes('start next'), false);
    // Answer and continue the prerequisite, and send the dependent again after it: one call.
    const second = await tools.execute(dispatch({jobs: [job('ask again', {continue: 'T1'}), job('next', {after: ['T1']})]}), principal());
    assert.equal(second.isError, false, second.text);
    assert.match(second.text, /2\/2 done/);
    assert.ok(log.first.get('next')!.includes('Results of the jobs this one follows:\n<automa-result id="T1"'), 'the dependent starts from the continued worker\'s new result');
    // A finished worker can also be followed by a later call.
    const third = await tools.execute(dispatch({jobs: [job('next', {after: ['T1']})]}), principal());
    assert.match(third.text, /1\/1 done/);
    assert.match(log.first.get('next')!, /Summary: ask again ok/);
  } finally {await done();}
});

test('Graph: a shelved prerequisite that ended blocked or failed keeps the new job from starting', async () => {
  const {tools, done} = await project();
  try {
    const log = newLog();
    tools.setAutomaEnvironment(environment(workers({ask: {status: 'blocked'}, next: {}}, log)));
    await tools.execute(dispatch({jobs: [job('ask')]}), principal());
    const second = await tools.execute(dispatch({jobs: [job('next', {after: ['T1']})]}), principal());
    assert.match(second.text, /0\/1 done · 1 skipped/);
    assert.match(second.text, /Summary: Not started: T1 ended blocked\./);
    assert.equal(log.events.includes('start next'), false);
  } finally {await done();}
});

test('Graph: a cycle, an unknown reference, another dispatcher\'s worker and too many jobs are refused whole, with the exact fix', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(workers({one: {}, two: {}, three: {}}), {maxPerDispatch: () => 2}));
    const cycle = await tools.execute(dispatch({jobs: [job('one', {after: ['T2']}), job('two', {after: ['T1']})]}), principal());
    assert.equal(cycle.disposition, 'denied');
    assert.match(cycle.text, /wait on each other: T1 → T2 → T1\. Fix: remove one `after` entry/);
    const self = await tools.execute(dispatch({jobs: [job('one', {after: ['#1']})]}), principal());
    assert.match(self.text, /wait on each other: T1 → T1\./);
    const unknown = await tools.execute(dispatch({jobs: [job('one', {after: ['T9']})]}), principal());
    assert.match(unknown.text, /lists after "T9", which is not a job of this call or a live worker of yours; this call has T1 \(#1\)\. Fix: name a job by its id/);
    const badPosition = await tools.execute(dispatch({jobs: [job('one', {after: ['#4']})]}), principal());
    assert.match(badPosition.text, /Fix: use "#1" to "#1"/);
    const many = await tools.execute(dispatch({jobs: [job('one'), job('two'), job('three')]}), principal());
    assert.match(many.text, /Too many jobs: 3\. This setup allows 2 per call .* Send the first 2 now/);
    // Kalon's finished worker belongs to Kalon.
    const theirs = await tools.execute(dispatch({jobs: [job('three')]}), principal(undefined, {ownerId: 'kalon', activityId: 'k'}));
    assert.match(theirs.text, /id="K1"/);
    const foreign = await tools.execute(dispatch({jobs: [job('one', {after: ['K1']})]}), principal());
    assert.match(foreign.text, /lists after "K1", which is a worker of Kalon, not yours\. Fix: follow only jobs of this call or your own finished workers/);
    // The refused calls took no ids: the first job that ran got T1.
    const ok = await tools.execute(dispatch({jobs: [job('one'), job('two', {after: ['T1']})]}), principal());
    assert.match(ok.text, /id="T1" title="one" status="done"/);
    assert.match(ok.text, /id="T2" title="two" status="done"/);
  } finally {await done();}
});

test('Graph: writes must be disjoint only between jobs that can run at the same time', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(workers({one: {}, two: {}, three: {}})));
    const ordered = await tools.execute(dispatch({jobs: [job('one', {writes: ['a.txt']}), job('two', {writes: ['a.txt'], after: ['#1']})]}), principal());
    assert.equal(ordered.isError, false, ordered.text);
    assert.match(ordered.text, /2\/2 done/);
    const concurrent = await tools.execute(dispatch({jobs: [job('one', {writes: ['a.txt']}), job('two', {writes: ['a.txt']})]}), principal());
    assert.match(concurrent.text, /have overlapping writes: a\.txt and a\.txt/);
    // one -> two, but three follows neither: three overlaps with both.
    const partly = await tools.execute(dispatch({jobs: [job('one', {writes: ['a.txt']}), job('two', {writes: ['a.txt'], after: ['#1']}), job('three', {writes: ['a.txt']})]}), principal());
    assert.match(partly.text, /Jobs "one" and "three" have overlapping writes/);
    // A transitive order counts: one -> two -> three.
    const chain = await tools.execute(dispatch({jobs: [job('one', {writes: ['a.txt']}), job('two', {after: ['#1']}), job('three', {writes: ['a.txt'], after: ['#2']})]}), principal());
    assert.equal(chain.isError, false, chain.text);
    const direct = resolveAfter([{id: 'T1', title: 'a'}, {id: 'T2', title: 'b', after: ['a']}, {id: 'T3', title: 'c'}], {live: new Set()});
    assert.ok(direct.ok && direct.graph.ordered(0, 1) && direct.graph.ordered(1, 0) && !direct.graph.ordered(0, 2));
  } finally {await done();}
});

test('The input accepts after and mode and wait forms models write, and the contract names them', () => {
  const notes: string[] = [];
  const normalized = normalizeAutomaInput({jobs: [{brief: 'a'}, {brief: 'b', after: 'T1'}, {brief: 'c', depends_on: ['#1', 2, 'none']}], mode: 'Background', wait: 'T1'}, notes) as Record<string, unknown>;
  const jobs = normalized.jobs as {after?: string[]}[];
  assert.deepEqual([jobs[0]!.after, jobs[1]!.after, jobs[2]!.after], [undefined, ['T1'], ['#1', '#2']]);
  assert.equal(normalized.mode, 'background');
  assert.deepEqual(normalized.wait, ['T1']);
  assert.equal(automaSchema.safeParse(normalized).success, true);
  assert.equal(automaSchema.safeParse({jobs: [{brief: 'a', scope: 'exact', after: Array.from({length: 9}, (_, i) => 'T' + i)}]}).success, false, 'at most 8 entries');
  assert.equal(automaSchema.safeParse({wait: ['T1']}).success, true);
  assert.equal(automaSchema.safeParse({mode: 'later', jobs: [{brief: 'a', scope: 'exact'}]}).success, false);
  assert.equal((normalizeAutomaInput({jobs: [{brief: 'a'}], mode: 'later'}) as Record<string, unknown>).mode, undefined);
  assert.ok(AUTOMA_DESCRIPTION.includes('- `after` orders jobs: a job starts when the jobs it names (by id `T1`…, `#n` or title) are done, and receives their results. Jobs without `after` run in parallel; a job whose prerequisite does not finish is skipped. Ordered jobs may write the same files.'));
  assert.ok(AUTOMA_DESCRIPTION.includes('- `mode: "background"` returns at once and delivers each result as a message when it is ready, so you can act on the first findings while the rest run. Use it when early results let you move on; use the default when you need all results together. `{"wait": ["T3"]}` waits for specific background jobs.'));
  const lines = AUTOMA_DESCRIPTION.split('\n'), routing = lines.findIndex(line => line.startsWith('- Jobs without `writes`'));
  assert.ok(lines[routing + 1]!.startsWith('- `after` orders jobs') && lines[routing + 2]!.startsWith('- `mode: "background"`'), 'two bullets after the writes bullets');
});

/** Where background results go: a message into the dispatcher's running task. */
function inbox() {
  const deliveries: {text: string; summary: string; at: number}[] = [];
  return {deliveries, deliver: async (_target: unknown, text: string, summary: string) => {deliveries.push({text, summary, at: Date.now()}); return true;}};
}
const ids = (text: string) => [...text.matchAll(/<automa-result id="([^"]+)"/g)].map(match => match[1]!);

test('Background: the call returns at once with a receipt, one line per job, and the results arrive as messages', async () => {
  const {tools, done} = await project();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const mailbox = inbox();
    tools.setAutomaEnvironment(environment(workers({slow: {gate}, later: {delay: 250}, hold: {gate}, queued: {delay: 200}}), {deliver: mailbox.deliver, coalesceMs: () => 60}));
    const started = Date.now();
    const result = await tools.execute(dispatch({mode: 'background', jobs: [job('slow'), job('later', {after: ['T1']}), job('hold'), job('queued', {after: ['T1', 'T2']})], parallel: 2}), principal());
    assert.equal(result.isError, false, result.text);
    assert.ok(Date.now() - started < 1000, 'it did not wait for the jobs');
    assert.equal(result.text, ['T1 slow · running', 'T2 later · waiting on T1', 'T3 hold · running', 'T4 queued · waiting on T1, T2', BACKGROUND_RECEIPT_SENTENCE].join('\n'));
    assert.equal(tools.background.outstanding('act').length, 4, 'the task has four results to receive');
    assert.equal(tools.background.open('s'), true);
    assert.equal(mailbox.deliveries.length, 0);
    release();
    await until(() => ids(mailbox.deliveries.map(item => item.text).join('\n')).length === 4, 8000, 'four results');
    assert.deepEqual(mailbox.deliveries.map(item => ids(item.text)), [['T1', 'T3'], ['T2'], ['T4']], 'T1 and T3 ended together; the others each after the window of the one before');
    assert.match(mailbox.deliveries[0]!.summary, /^Automa results T1, T3$/);
    assert.match(mailbox.deliveries[0]!.text, /Trust: /);
    assert.equal(tools.background.outstanding('act').length, 0);
    assert.equal(tools.background.open('s'), false);
    // A job beyond the dispatch's limit is queued, not running.
    const limited = await tools.execute(dispatch({mode: 'background', jobs: [job('slow'), job('later')], parallel: 1}), principal(undefined, {activityId: 'act2'}));
    assert.match(limited.text, /^T5 slow · running\nT6 later · queued\n/);
  } finally {await done();}
});

test('Background: results that end within the window go out as one delivery (3 seconds by default)', async () => {
  assert.equal(BACKGROUND_COALESCE_MS, 3000);
  const {tools, done} = await project();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const mailbox = inbox();
    tools.setAutomaEnvironment(environment(workers({fast: {delay: 20}, quick: {delay: 120}, long: {gate}}), {deliver: mailbox.deliver}));
    const started = Date.now();
    await tools.execute(dispatch({mode: 'background', jobs: [job('fast'), job('quick'), job('long')]}), principal());
    await sleep(1200);
    assert.equal(mailbox.deliveries.length, 0, 'the first result waits for others that may follow');
    await until(() => mailbox.deliveries.length === 1, 6000, 'the window to close');
    assert.deepEqual(ids(mailbox.deliveries[0]!.text), ['T1', 'T2'], 'both results in one message');
    assert.ok(mailbox.deliveries[0]!.at - started >= 2800, 'the window is counted from the first result: ' + (mailbox.deliveries[0]!.at - started));
    release();
    await until(() => mailbox.deliveries.length === 2, 5000, 'the last result');
    assert.deepEqual(ids(mailbox.deliveries[1]!.text), ['T3'], 'when nothing of the dispatch is open the last result goes at once');
  } finally {await done();}
});

test('Background: a blocked result is delivered at once, together with the jobs it kept from starting', async () => {
  const {tools, done} = await project();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const mailbox = inbox();
    tools.setAutomaEnvironment(environment(workers({stuck: {status: 'blocked', delay: 20}, dependent: {}, long: {gate}}), {deliver: mailbox.deliver}));
    await tools.execute(dispatch({mode: 'background', jobs: [job('stuck'), job('dependent', {after: ['T1']}), job('long')]}), principal());
    await until(() => mailbox.deliveries.length === 1, 1500, 'the blocked result');
    assert.deepEqual(ids(mailbox.deliveries[0]!.text), ['T1', 'T2']);
    assert.match(mailbox.deliveries[0]!.text, /id="T1" title="stuck" status="blocked"/);
    assert.match(mailbox.deliveries[0]!.text, /id="T2" title="dependent" status="skipped" stop="dependency_unmet"[^\n]*\nSummary: Not started: T1 ended blocked\./);
    assert.equal(tools.background.outstanding('act').length, 1, 'the long job is still open');
    release();
    await until(() => mailbox.deliveries.length === 2, 5000, 'the long job');
  } finally {await done();}
});

test('Background: wait parks until the named jobs ended, returns their blocks, and they are not delivered again', async () => {
  const {tools, done} = await project();
  try {
    const mailbox = inbox();
    tools.setAutomaEnvironment(environment(workers({fast: {delay: 10}, slow: {delay: 120}, other: {delay: 10}}), {deliver: mailbox.deliver, coalesceMs: () => 2000}));
    await tools.execute(dispatch({mode: 'background', jobs: [job('fast'), job('slow'), job('other')]}), principal());
    const unknown = await tools.execute(dispatch({wait: ['T1', 'T7']}), principal());
    assert.equal(unknown.disposition, 'denied');
    assert.match(unknown.text, /Unknown background job: T7\. Your background jobs are T1, T2, T3\. Fix: wait only for ids a background receipt listed\./);
    assert.equal((await tools.execute(dispatch({wait: ['T1'], jobs: [job('x')]}), principal())).disposition, 'denied');
    const waited = await tools.execute(dispatch({wait: ['T1', 'T2']}), principal());
    assert.equal(waited.isError, false, waited.text);
    assert.deepEqual(ids(waited.text), ['T1', 'T2']);
    assert.match(waited.text, /status="done"/);
    // Another task of the same actor cannot wait for them.
    assert.match((await tools.execute(dispatch({wait: ['T3']}), principal(undefined, {activityId: 'other-task'}))).text, /Unknown background job: T3/);
    await until(() => mailbox.deliveries.length === 1, 3000, 'the result nobody waited for');
    await sleep(100);
    assert.deepEqual(mailbox.deliveries.map(item => ids(item.text)), [['T3']], 'what wait returned is not delivered as a message, even though its job ended last');
    assert.equal(tools.background.outstanding('act').length, 0);
  } finally {await done();}
});

test('Background: a delivery nobody could receive is offered again; cancelling the dispatcher cancels its jobs and delivers nothing', async () => {
  const {tools, done} = await project();
  try {
    let accept = false;
    const attempts: string[] = [];
    const controller = new AbortController();
    const swarms: AutomaSwarm[] = [];
    const aborted: boolean[] = [];
    const provider: AutomaProvider = {async respond(request, _delta, signal) {
      if ((request.messages[0]?.text ?? '').startsWith('hang')) {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => {aborted.push(true); reject(signal.reason);}, {once: true}));
      }
      return {message: {role: 'assistant', text: '', toolCalls: [{id: 'f', name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'quick done'})}]}, stop: 'tools'};
    }};
    tools.setAutomaEnvironment(environment(provider, {coalesceMs: () => 10, deliver: async (_target, text) => {attempts.push(text); return accept;}}));
    await tools.execute(dispatch({mode: 'background', jobs: [job('quick'), job('hang')]}), principal(controller.signal, {reportSwarm: swarm => swarms.push(structuredClone(swarm))}));
    await until(() => attempts.length >= 2, 4000, 'a second attempt');
    assert.equal(tools.background.outstanding('act').length, 2, 'nothing counts as delivered while nobody received it');
    controller.abort(new Error('cancelled'));
    await until(() => aborted.length === 1 && swarms.at(-1)!.jobs[1]!.state === 'cancelled', 4000, 'the hanging job to be cancelled');
    assert.equal(tools.background.outstanding('act').length, 0, 'the task is gone: nothing is left to deliver');
    accept = true;
    const before = attempts.length;
    await sleep(700);
    assert.equal(attempts.length, before, 'no further delivery after the cancel');
    assert.equal(swarms.at(-1)!.background, true);
    assert.equal(swarms.at(-1)!.jobs[1]!.stopReason, 'interrupted');
  } finally {await done();}
});

test('Background needs somewhere to deliver, and release still ends shelved workers', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(workers({one: {}})));
    const refused = await tools.execute(dispatch({mode: 'background', jobs: [job('one')]}), principal());
    assert.equal(refused.disposition, 'denied');
    assert.match(refused.text, /Background mode is not available here\. Fix: omit `mode`/);
    const mailbox = inbox();
    tools.setAutomaEnvironment(environment(workers({one: {}}), {deliver: mailbox.deliver, coalesceMs: () => 10}));
    await tools.execute(dispatch({jobs: [job('one')]}), principal());
    const released = await tools.execute(dispatch({release: ['T1']}), principal());
    assert.match(released.text, /Released T1/);
  } finally {await done();}
});
