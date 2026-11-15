import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AUTOMA_RETAINED_INPUT_LIMIT, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {Semaphore} from '../src/kernel/semaphore.js';
import {automaConfigSchema} from '../src/config/config.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelMessage, ModelTurn} from '../src/runtime/messages.js';
import {waitFor} from './wait-for.js';

const profile: AutomaProfile = {name: 'work crew', default_style: 'scout', styles: {scout: {flavor: 'Scout style.'}}};
const parkRoot = join(tmpdir(), 'logox-automa-workers-' + process.pid);
after(() => rm(parkRoot, {recursive: true, force: true}));
let environments = 0;
const nextDir = () => {const id = String(++environments); return (sessionId: string) => join(parkRoot, id, sessionId);};

function principal(overrides: Partial<ActorContext> = {}): ActorContext {
  return {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};},
    async permission() {throw new Error('Unexpected approval');}, ...overrides};
}
const finishCall = (summary = 'ok') => ({id: 'fin', name: 'Finish', arguments: JSON.stringify({status: 'done', summary})});
const turn = (calls: ModelTurn['message']['toolCalls'], usage: ModelTurn['usage'] = {input: 10, output: 1}): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: calls}, stop: 'tools', usage});
const finished = (usage?: ModelTurn['usage']) => turn([finishCall()], usage);
const job = (brief: string, extra: Record<string, unknown> = {}) => ({title: brief, brief, scope: 'bounded', ...extra});
const dispatch = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});
const environment = (provider: AutomaProvider, overrides: Partial<AutomaEnvironment> = {}): AutomaEnvironment =>
  ({resolveModel: () => ({provider, model: 'mock/worker'}), profile: () => profile, workerDir: nextDir(), ...overrides});

async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-workers-cwd-'));
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
  return {cwd, tools, done: async () => {await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}};
}
const exists = (path: string) => stat(path).then(() => true, () => false);

test('Job ids are the dispatcher\'s first letter and a per-session counter, shared by letter so they stay unique', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment({async respond() {return finished();}}));
    const idsOf = async (ownerId: string, count = 1, activityId = 'act') =>
      [...(await tools.execute(dispatch({jobs: Array.from({length: count}, (_, index) => job('j' + index))}), principal({ownerId, activityId}))).text.matchAll(/<automa-result id="([A-Z]\d+)"/g)].map(match => match[1]);
    assert.deepEqual(await idsOf('techne', 2), ['T1', 'T2']);
    assert.deepEqual(await idsOf('techne'), ['T3']);
    assert.deepEqual(await idsOf('kalon'), ['K1']);
    assert.deepEqual(await idsOf('logox'), ['L1']);
    assert.deepEqual(await idsOf('aletheia'), ['A1']);
    assert.deepEqual(await idsOf('7-worker'), ['A2'], 'an owner without a letter takes the A series');
  } finally {await done();}
});

test('A finished worker stays idle without keep and a continue brings the next result under the same id; a worker blocked on a question continues with the answer', async () => {
  const {tools, done} = await project();
  try {
    const requests: ModelMessage[][] = [];
    let step = 0;
    tools.setAutomaEnvironment(environment({async respond(request) {
      requests.push([...request.messages]);
      return turn([{id: 'fin' + step, name: 'Finish', arguments: JSON.stringify(step++ === 0
        ? {status: 'blocked', summary: 'Need a port.', question: 'Which port?'} : {status: 'done', summary: 'Used 8080.'})}]);
    }}));
    const first = await tools.execute(dispatch({jobs: [job('Pick a port')]}), principal());
    assert.match(first.text, /<automa-result id="T1" title="Pick a port" status="blocked"/);
    assert.match(first.text, /^Question: Which port\?$/m);
    const second = await tools.execute(dispatch({jobs: [{title: 'Answer', brief: 'Port 8080.', scope: 'exact', continue: 'T1'}]}), principal());
    assert.match(second.text, /<automa-result id="T1" title="Answer" status="done"/);
    const history = requests.at(-1)!;
    assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'tool', 'user'], 'the same history, then the new brief as the next user message');
    assert.match(history.at(-1)!.text, /^Port 8080\./);
  } finally {await done();}
});

test('Parking: by size at once, by idle time with the injected clock; continue revives from the file; the file is atomic and named by task and id', async () => {
  const {tools, done} = await project();
  try {
    let now = 1_000_000, input = 10;
    const requests: ModelMessage[][] = [];
    const root = join(parkRoot, 'parking');
    tools.setAutomaEnvironment(environment({async respond(request) {requests.push([...request.messages]); return finished({input, output: 1});}},
      {workerDir: session => join(root, session), clock: () => now}));
    const file = (id: string, activity = 'act') => join(root, 's', activity, id + '.json');
    await tools.execute(dispatch({jobs: [job('small')]}), principal());
    assert.equal(await exists(file('T1')), false, 'a small, fresh history stays in memory');
    now += 9 * 60_000; await tools.sweepWorkers();
    assert.equal(await exists(file('T1')), false, 'idle for nine minutes is not enough');
    now += 60_000; await tools.sweepWorkers();
    assert.equal(await exists(file('T1')), true, 'idle for ten minutes parks it');
    const saved = JSON.parse(await readFile(file('T1'), 'utf8')) as {id: string; messages: unknown[]; ownerId: string};
    assert.equal(saved.id, 'T1'); assert.equal(saved.ownerId, 'techne'); assert.equal(saved.messages.length, 3);
    const revived = await tools.execute(dispatch({jobs: [{title: 'again', brief: 'next brief', scope: 'exact', continue: 'T1'}]}), principal());
    assert.match(revived.text, /<automa-result id="T1" title="again" status="done"/);
    assert.equal(requests.at(-1)!.length, 4, 'the parked history came back from disk');
    input = AUTOMA_RETAINED_INPUT_LIMIT;
    const large = await tools.execute(dispatch({jobs: [job('big')]}), principal());
    assert.match(large.text, /id="T2"/);
    assert.equal(await exists(file('T2')), true, 'a history at the limit is parked as soon as the worker is idle');
    assert.doesNotMatch(large.text, /^Note:/m, 'the large-context note belongs to a continued job');
    const again = await tools.execute(dispatch({jobs: [{title: 'more', brief: 'continue it', scope: 'exact', continue: 'T2'}]}), principal());
    assert.match(again.text, /status="done"/, 'a history over the limit is still revivable');
    assert.match(again.text, /^Note: this worker's context is large; a fresh job with a short brief is cheaper\.$/m);
    // After a restart: a new process holds nothing, but a parked worker of a still-open task revives from its file; anything else is closed.
    const restarted = new Tools(tools.cwd, undefined, new PermissionEngine(tools.cwd, 'creative'), {home: tools.cwd});
    restarted.setAutomaEnvironment(environment({async respond() {return finished();}}, {workerDir: session => join(root, session), clock: () => now}));
    const after = await restarted.execute(dispatch({jobs: [{title: 'after restart', brief: 'hello again', scope: 'exact', continue: 'T1'}]}), principal());
    assert.match(after.text, /<automa-result id="T1" title="after restart" status="done"/);
    const fresh = await restarted.execute(dispatch({jobs: [job('new work')]}), principal());
    assert.match(fresh.text, /id="T3"/, 'ids never repeat one a parked file still carries');
    const gone = await restarted.execute(dispatch({jobs: [{title: 'x', brief: 'y', continue: 'T9'}]}), principal());
    assert.equal(gone.text, 'Worker T9 is closed or unknown; dispatch a new job.');
  } finally {await done();}
});

test('Closing: a settled task ends its idle and parked workers and deletes their files; release does it now', async () => {
  const {tools, done} = await project();
  try {
    const root = join(parkRoot, 'closing');
    tools.setAutomaEnvironment(environment({async respond() {return finished({input: AUTOMA_RETAINED_INPUT_LIMIT, output: 1});}}, {workerDir: session => join(root, session)}));
    await tools.execute(dispatch({jobs: [job('one'), job('two')]}), principal());
    const file = (id: string) => join(root, 's', 'act', id + '.json');
    assert.deepEqual([await exists(file('T1')), await exists(file('T2'))], [true, true]);
    const released = await tools.execute(dispatch({release: ['T2']}), principal());
    assert.match(released.text, /Released T2\./);
    assert.deepEqual([await exists(file('T1')), await exists(file('T2'))], [true, false], 'release deletes the file');
    let status = 'running';
    tools.setActivityProbe(() => [{sessionId: 's', activityId: 'act', status}] as never);
    await tools.sweepWorkers();
    assert.equal(await exists(file('T1')), true, 'a running task keeps its workers');
    status = 'completed';
    await tools.sweepWorkers();
    assert.equal(await exists(file('T1')), false, 'the settled task closed it');
    assert.equal(await exists(join(root, 's', 'act')), false, 'and removed the task folder');
    const closed = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'y', continue: 'T1'}]}), principal());
    assert.equal(closed.text, 'Worker T1 is closed or unknown; dispatch a new job.');
  } finally {await done();}
});

test('max_per_dispatch refuses a call with too many jobs and names the fix; the schema allows up to 32', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment({async respond() {return finished();}}, {maxPerDispatch: () => 2}));
    const refused = await tools.execute(dispatch({jobs: [job('a'), job('b'), job('c')]}), principal());
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Too many jobs: 3\. This setup allows 2 per call \(`\[automa\] max_per_dispatch`\)\. Send the first 2 now/);
    assert.match((await tools.execute(dispatch({jobs: [job('a'), job('b')]}), principal())).text, /2\/2 done/);
    assert.deepEqual([automaConfigSchema.parse({}).max_per_dispatch, automaConfigSchema.parse({}).max_running, automaConfigSchema.parse({max_parallel: 6}).max_parallel], [16, 24, 6]);
    assert.equal(automaConfigSchema.safeParse({max_per_dispatch: 33}).success, false);
    assert.equal(automaConfigSchema.safeParse({max_running: 65}).success, false);
  } finally {await done();}
});

test('max_running is one limit across dispatchers: jobs beyond it queue in order and show as queued', async () => {
  const {tools, done} = await project();
  try {
    let running = 0, peak = 0;
    const order: string[] = [];
    tools.setAutomaEnvironment(environment({async respond({messages}) {
      order.push(messages[0]!.text.split('\n')[0]!);
      running++; peak = Math.max(peak, running);
      await delay(25);
      running--;
      return finished();
    }}, {maxRunning: () => 2}));
    const swarms: AutomaSwarm[] = [];
    const reporter = (name: string) => (swarm: AutomaSwarm) => {swarms.push({name: name + ':' + swarm.name, jobs: swarm.jobs});};
    const [first, second] = await Promise.all([
      tools.execute(dispatch({jobs: [job('t1'), job('t2'), job('t3')]}), principal({ownerId: 'techne', activityId: 'a1', reportSwarm: reporter('techne')} as never)),
      tools.execute(dispatch({jobs: [job('k1'), job('k2')]}), principal({ownerId: 'kalon', activityId: 'a2', reportSwarm: reporter('kalon')} as never)),
    ]);
    assert.match(first.text, /3\/3 done/); assert.match(second.text, /2\/2 done/);
    assert.equal(peak, 2, 'never more than two workers running, whoever dispatched them');
    assert.equal(order.length, 5);
    assert.ok(order.indexOf('t1') < order.indexOf('t2') && order.indexOf('t2') < order.indexOf('t3') && order.indexOf('k1') < order.indexOf('k2'), 'each dispatcher\'s jobs start in order: ' + order.join(','));
    assert.deepEqual(order.slice(0, 2), ['t1', 't2'], 'the first to ask take the free slots; the rest wait in line');
    assert.ok(swarms.some(swarm => swarm.jobs.some(item => item.state === 'queued') && swarm.jobs.some(item => item.state === 'running')), 'a queued job is shown beside a running one');
    assert.ok(swarms.every(swarm => swarm.jobs.filter(item => item.state === 'running').length <= 2));
    assert.ok(swarms.at(-1)!.jobs.every(item => /^[TK]\d$/.test(item.id ?? '')), 'the card carries the ids');
  } finally {await done();}
});

test('The semaphore is first-in-first-out and leaves its queue when the waiter aborts', async () => {
  const semaphore = new Semaphore(() => 1);
  const first = await semaphore.acquire();
  const controller = new AbortController();
  const order: string[] = [];
  const second = semaphore.acquire().then(release => {order.push('second'); return release;});
  const aborted = semaphore.acquire(controller.signal).then(() => order.push('aborted'), () => order.push('rejected'));
  const third = semaphore.acquire().then(release => {order.push('third'); return release;});
  assert.equal(semaphore.waiting, 3);
  controller.abort();
  await aborted;
  first();
  (await second)();
  (await third)();
  assert.deepEqual(order, ['rejected', 'second', 'third']);
  assert.equal(semaphore.running, 0);
});

test('A dispatch of more than three jobs with one system prompt starts the first alone, the rest once its first response is back', async () => {
  const {tools, done} = await project();
  try {
    for (const failFirst of [false, true]) {
      const log: string[] = [];
      tools.setAutomaEnvironment(environment({async respond({messages}) {
        const brief = messages[0]!.text.split('\n')[0]!;
        log.push('start ' + brief);
        await delay(brief === 'j0' ? 40 : 5);
        if (brief === 'j0' && failFirst) {log.push('fail ' + brief); throw new Error('first job exploded');}
        log.push('end ' + brief);
        return finished();
      }}, {maxParallel: () => 8}));
      const result = await tools.execute(dispatch({jobs: ['j0', 'j1', 'j2', 'j3', 'j4'].map(brief => job(brief))}), principal({activityId: 'stagger' + failFirst}));
      assert.deepEqual(log.slice(0, 2), ['start j0', failFirst ? 'fail j0' : 'end j0'], 'nothing else starts before the first job has answered or failed');
      assert.equal(log.filter(entry => entry.startsWith('start')).length, 5);
      assert.match(result.text, failFirst ? /4\/5 done/ : /5\/5 done/);
      // Three jobs or fewer start together.
      log.length = 0;
      await tools.execute(dispatch({jobs: ['j0', 'j1', 'j2'].map(brief => job(brief))}), principal({activityId: 'together' + failFirst}));
      assert.deepEqual(log.slice(0, 3), ['start j0', 'start j1', 'start j2']);
    }
  } finally {await done();}
});

test('Read-only calls of one worker turn run in parallel groups; writes stay in order between them', async () => {
  const {cwd, tools, done} = await project();
  try {
    let active = 0, peak = 0;
    const finishes: string[] = [];
    const original = tools.execute.bind(tools);
    (tools as unknown as {execute: Tools['execute']}).execute = async (call, context) => {
      if (!context.via) return original(call, context);
      active++; peak = Math.max(peak, active);
      await delay(25);
      try {return await original(call, context);} finally {active--; finishes.push(call.name);}
    };
    const read = (id: string, file_path: string) => ({id, name: 'Read', arguments: JSON.stringify({file_path})});
    const write = (id: string) => ({id, name: 'Write', arguments: JSON.stringify({file_path: 'out.txt', content: 'x\n'})});
    const plans: Record<string, ModelTurn['message']['toolCalls']> = {
      reads: [read('r1', 'a.txt'), read('r2', 'b.txt'), read('r3', 'c.txt')],
      mixed: [read('m1', 'a.txt'), write('m2'), read('m3', 'b.txt'), read('m4', 'c.txt')],
    };
    const turns = new Map<string, number>();
    await Promise.all(['a', 'b', 'c'].map(name => import('node:fs/promises').then(fs => fs.writeFile(join(cwd, name + '.txt'), name + '\n'))));
    tools.setAutomaEnvironment(environment({async respond({messages}) {
      const key = messages[0]!.text.split('\n')[0]!;
      const at = turns.get(key) ?? 0;
      turns.set(key, at + 1);
      return at === 0 ? turn(plans[key]!) : finished();
    }}, {readonlyConcurrency: () => 4}));
    const result = await tools.execute(dispatch({jobs: [job('reads')]}), principal());
    assert.match(result.text, /1\/1 done/);
    assert.equal(peak, 3, 'three reads at once');
    peak = 0; finishes.length = 0;
    const mixed = await tools.execute(dispatch({jobs: [job('mixed', {writes: ['out.txt']})]}), principal({activityId: 'second'}));
    assert.match(mixed.text, /1\/1 done/);
    assert.equal(peak, 2, 'the two reads after the write run together; the first read and the write do not overlap');
    assert.equal(finishes[0], 'Read'); assert.equal(finishes[1], 'Write');
    tools.setAutomaEnvironment(environment({async respond({messages}) {
      const key = messages[0]!.text.split('\n')[0]!;
      const at = turns.get(key) ?? 0;
      turns.set(key, at + 1);
      return at < 2 ? turn(plans.reads) : finished();
    }}, {readonlyConcurrency: () => 1}));
    peak = 0; turns.clear();
    await tools.execute(dispatch({jobs: [job('reads')]}), principal({activityId: 'third'}));
    assert.equal(peak, 1, 'permissions.readonly_concurrency = 1 keeps them in order');
  } finally {await done();}
});

test('Dispatches in progress are never idle: a sweep leaves a continued worker alone', async () => {
  const {tools, done} = await project();
  try {
    let now = 0;
    const gate = new Promise<void>(resolve => {setTimeout(resolve, 60);});
    let calls = 0;
    tools.setAutomaEnvironment(environment({async respond() {if (++calls > 1) await gate; return finished();}}, {clock: () => now, idleParkMs: () => 1000}));
    await tools.execute(dispatch({jobs: [job('first')]}), principal());
    const running = tools.execute(dispatch({jobs: [{title: 'next', brief: 'go on', scope: 'exact', continue: 'T1'}]}), principal());
    await waitFor(() => calls, value => value >= 2);
    now += 5000;
    await tools.sweepWorkers();
    assert.match((await running).text, /<automa-result id="T1"[^>]*status="done"/);
  } finally {await done();}
});
