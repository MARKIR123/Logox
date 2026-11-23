import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import stringWidth from 'string-width';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {projectDelegations} from '../src/runtime/delegations.js';
import {teamEvents} from '../src/runtime/team-events.js';
import {stageAt, workerName} from '../src/runtime/team-stage.js';
import {taskGraph} from '../src/runtime/task-graph.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';
import {AUTOMA_DESCRIPTION} from '../src/tools/orchestration/AutomaTool/prompt.js';
import {AUTOMA_RETAINED_INPUT_LIMIT, automaSchema, normalizeAutomaInput, resultBlock, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {NAME_MAX, nameProblem} from '../src/tools/orchestration/AutomaTool/names.js';
import {WorkerShelf, type IdleWorker} from '../src/tools/orchestration/AutomaTool/workers.js';
import {resolveAfter} from '../src/tools/orchestration/AutomaTool/graph.js';
import {getToolUI} from '../src/tools/ui-registry.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelTurn} from '../src/runtime/messages.js';

const profile: AutomaProfile = {name: 'work crew', default_style: 'scout', styles: {scout: {flavor: 'Scout.'}}};
const root = join(tmpdir(), 'logox-automa-names-' + process.pid);
after(() => rm(root, {recursive: true, force: true}));
let environments = 0;

function principal(overrides: Partial<ActorContext> = {}): ActorContext {
  return {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal, report() {}, say() {}, async record() {},
    async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}, ...overrides};
}
const finished = (usage: ModelTurn['usage'] = {input: 10, output: 1}): ModelTurn =>
  ({message: {role: 'assistant', text: '', toolCalls: [{id: 'fin', name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'ok'})}]}, stop: 'tools', usage});
const job = (brief: string, extra: Record<string, unknown> = {}) => ({title: brief, brief, scope: 'bounded', ...extra});
const dispatch = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});
const ids = (text: string) => [...text.matchAll(/<automa-result id="([^"]+)"/g)].map(match => match[1]!);
const provider = (usage?: () => ModelTurn['usage']): AutomaProvider => ({async respond() {return finished(usage?.());}});
const dirOf = () => {const id = String(++environments); return (sessionId: string) => join(root, id, sessionId);};
const environment = (workers: AutomaProvider, overrides: Partial<AutomaEnvironment> = {}): AutomaEnvironment =>
  ({resolveModel: () => ({provider: workers, model: 'mock/worker'}), profile: () => profile, workerDir: dirOf(), ...overrides});
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-names-cwd-'));
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
  return {cwd, tools, done: async () => {await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}};
}
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const limit = Date.now() + ms;
  while (!check()) {if (Date.now() > limit) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10));}
}

// ------------------------------------------------------------------------------------------------------------------------------ schema and validation
test('Schema: name is an optional job field; placeholders are dropped, and the description says what a name is for', () => {
  assert.equal(automaSchema.safeParse({jobs: [{brief: 'x', scope: 'exact', name: 'scout'}]}).success, true);
  assert.equal(automaSchema.safeParse({jobs: [{brief: 'x', scope: 'exact'}]}).success, true, 'unnamed jobs stay valid');
  const normalized = normalizeAutomaInput({jobs: [{brief: 'a', name: ' scout '}, {brief: 'b', name: 'none'}, {brief: 'c', name: ''}, {brief: 'd', name: 7}]}) as {jobs: Record<string, unknown>[]};
  assert.deepEqual(normalized.jobs.map(item => item.name), ['scout', undefined, undefined, '7']);
  assert.ok(AUTOMA_DESCRIPTION.includes('- `name` is an optional short handle for a worker you may continue or refer to later: lowercase kebab-case, at most 24 characters (`scout`, `api-tests`), unique among your workers. Wherever an id is accepted (`continue`, `after`, `wait`, `release`) its name works too; ids still work.'));
});

test('Names: lowercase kebab-case, 1 to 24 characters, never shaped like an id; each refusal states its fix', () => {
  for (const good of ['scout', 'palette', 'api-tests', 'a', 'x'.repeat(NAME_MAX), 'step-2']) assert.equal(nameProblem(good), undefined, good);
  for (const bad of ['Scout', 'two words', '-lead', '2fast', 'snake_case', 'x'.repeat(NAME_MAX + 1), 't1', 'k12']) {
    assert.match(nameProblem(bad) ?? '', /^Worker name ".*" .*Fix: /, bad);
  }
});

test('Names: a bad name refuses the whole call with the fix, and nothing runs', async () => {
  const {tools, done} = await project();
  try {
    let runs = 0;
    tools.setAutomaEnvironment(environment({async respond() {runs++; return finished();}}));
    for (const name of ['Scout', 'has space', 'T1', 'y'.repeat(25)]) {
      const refused = await tools.execute(dispatch({jobs: [job('a'), job('b', {name})]}), principal());
      assert.equal(refused.isError, true, name);
      assert.match(refused.text, /Worker name ".*" .*Fix: /, name);
    }
    assert.equal(runs, 0);
  } finally {await done();}
});

test('Names: unique among the dispatcher\'s live and parked workers; another dispatcher may reuse a name; a release frees it', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(provider()));
    const twice = await tools.execute(dispatch({jobs: [job('a', {name: 'scout'}), job('b', {name: 'SCOUT'.toLowerCase()})]}), principal());
    assert.match(twice.text, /^Worker name "scout" is given to two jobs of this call\. Fix: give each job its own name\./);
    const first = await tools.execute(dispatch({jobs: [job('a', {name: 'scout'})]}), principal());
    assert.match(first.text, /<automa-result id="T1" name="scout" title="a" status="done"/);
    const clash = await tools.execute(dispatch({jobs: [job('b', {name: 'scout'})]}), principal());
    assert.equal(clash.isError, true);
    assert.match(clash.text, /Worker name "scout" is already used by T1\. Fix: pick another name, or `continue` "scout" to give that worker its next step\./);
    const other = await tools.execute(dispatch({jobs: [job('b', {name: 'scout'})]}), principal({ownerId: 'kalon'}));
    assert.match(other.text, /<automa-result id="K1" name="scout"/, 'names are per dispatcher');
    const released = await tools.execute(dispatch({release: ['scout'], jobs: [job('c', {name: 'scout'})]}), principal());
    assert.match(released.text, /<automa-result id="T2" name="scout"/, 'a worker released by the same call frees its name');
    // A new task (another activity) closes the old workers, so their names are free again.
    const later = await tools.execute(dispatch({jobs: [job('d', {name: 'scout'})]}), principal({activityId: 'act2'}));
    assert.match(later.text, /name="scout"/);
  } finally {await done();}
});

test('Names: a background job that is still running holds its name', async () => {
  const {tools, done} = await project();
  try {
    let open!: () => void;
    const gate = new Promise<void>(resolve => {open = resolve;});
    tools.setAutomaEnvironment(environment({async respond() {await gate; return finished();}}, {deliver: async () => true, coalesceMs: () => 10}));
    const receipt = await tools.execute(dispatch({mode: 'background', jobs: [job('slow', {name: 'long-run'})]}), principal());
    assert.match(receipt.text, /^T1 \(long-run\) slow · running/);
    const clash = await tools.execute(dispatch({jobs: [job('other', {name: 'long-run'})]}), principal());
    assert.match(clash.text, /Worker name "long-run" is already used by T1\./);
    open();
    await until(() => tools.background.outstanding('act').length === 0 || tools.background.outstanding('act').every(item => item.state === 'ended'));
  } finally {await done();}
});

// ------------------------------------------------------------------------------------------------------------------------------ addressing
test('Addressing: continue, release and after accept a name as well as an id, in any letter case; ids keep working', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(provider()));
    await tools.execute(dispatch({jobs: [job('one', {name: 'scout'}), job('two', {name: 'api-tests'}), job('three')]}), principal());
    const byName = await tools.execute(dispatch({jobs: [{title: 'again', brief: 'next', scope: 'exact', continue: 'Scout'}]}), principal());
    assert.match(byName.text, /<automa-result id="T1" name="scout" title="again" status="done"/, 'a continued worker keeps its id and its name');
    const byId = await tools.execute(dispatch({jobs: [{title: 'again', brief: 'next', scope: 'exact', continue: 't1'}]}), principal());
    assert.match(byId.text, /<automa-result id="T1" name="scout"/, 'ids work in any case too');
    const after = await tools.execute(dispatch({jobs: [job('follow', {after: ['API-TESTS', 'T3']})]}), principal());
    assert.equal(after.isError, false, after.text);
    assert.match(after.text, /<automa-result id="T4" title="follow" status="done"/);
    const renamed = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'y', scope: 'exact', continue: 'scout', name: 'other-name'}]}), principal());
    assert.match(renamed.text, /name="scout"/);
    assert.match(renamed.text, /Worker "T1" keeps its name "scout"; `name` on "x" was ignored\./);
    const released = await tools.execute(dispatch({release: ['api-tests']}), principal());
    assert.equal(released.text.trim(), 'Released T2.');
    const gone = await tools.execute(dispatch({jobs: [{title: 'x', brief: 'y', continue: 'api-tests'}]}), principal());
    assert.equal(gone.isError, true);
    assert.match(gone.text, /Worker api-tests is closed or unknown; dispatch a new job\./);
  } finally {await done();}
});

test('Addressing: a job of the same call can follow another by its name; the graph resolves names of this call before titles', () => {
  const result = resolveAfter([{id: 'T1', title: 'Scan', name: 'scout'}, {id: 'T2', title: 'Report', after: ['SCOUT']}, {id: 'T3', title: 'scout', after: ['T1']}], {live: new Set()});
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.graph.needs, [[], [0], [0]]);
  const shelf = resolveAfter([{id: 'T4', title: 'Next', after: ['palette']}], {live: new Set(['T2']), aliases: new Map([['palette', 'T2']])});
  assert.equal(shelf.ok, true);
  if (shelf.ok) assert.deepEqual(shelf.graph.workers, [['T2']]);
});

test('Addressing: wait accepts the name of a background job, in any letter case', async () => {
  const {tools, done} = await project();
  try {
    const delivered: string[] = [];
    tools.setAutomaEnvironment(environment(provider(), {deliver: async (_scope, text) => {delivered.push(text); return true;}, coalesceMs: () => 2000}));
    await tools.execute(dispatch({mode: 'background', jobs: [job('a', {name: 'scout'}), job('b')]}), principal());
    const waited = await tools.execute(dispatch({wait: ['SCOUT']}), principal());
    assert.equal(waited.isError, false, waited.text);
    assert.deepEqual(ids(waited.text), ['T1']);
    assert.match(waited.text, /id="T1" name="scout"/);
    const unknown = await tools.execute(dispatch({wait: ['nobody']}), principal());
    assert.match(unknown.text, /Unknown background job: nobody\./);
  } finally {await done();}
});

// ------------------------------------------------------------------------------------------------------------------------------ persistence
test('Persistence: a parked worker keeps its name, can be continued by it after a restart, and still holds it against a new job', async () => {
  const {cwd, tools, done} = await project();
  try {
    const dir = dirOf();
    tools.setAutomaEnvironment(environment(provider(() => ({input: AUTOMA_RETAINED_INPUT_LIMIT, output: 1})), {workerDir: dir}));
    const first = await tools.execute(dispatch({jobs: [job('big', {name: 'archivist'})]}), principal());
    assert.match(first.text, /id="T1" name="archivist"/);
    const saved = JSON.parse(await readFile(join(dir('s'), 'act', 'T1.json'), 'utf8')) as {name?: string};
    assert.equal(saved.name, 'archivist', 'the parked file carries the name');
    const restarted = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    restarted.setAutomaEnvironment(environment(provider(), {workerDir: dir}));
    const clash = await restarted.execute(dispatch({jobs: [job('other', {name: 'archivist'})]}), principal());
    assert.match(clash.text, /Worker name "archivist" is already used by T1\./, 'a parked worker still holds its name after a restart');
    const revived = await restarted.execute(dispatch({jobs: [{title: 'more', brief: 'again', scope: 'exact', continue: 'archivist'}]}), principal());
    assert.match(revived.text, /<automa-result id="T1" name="archivist" title="more" status="done"/);
  } finally {await done();}
});

test('Persistence: a record parked without a name loads, and a named one round-trips through the shelf', async () => {
  const base: Omit<IdleWorker, 'id' | 'name'> = {sessionId: 's', ownerId: 'techne', activityId: 'act', workerId: 'w', grant: {writes: [], exclusive: []}, system: 'sys', preferred: undefined, vision: false,
    resolved: undefined, messages: [{role: 'user', text: 'hi'}], lastInput: 1, idleSince: 0, busy: false};
  const shelf = new WorkerShelf();
  shelf.configure({dir: sessionId => join(root, 'round-trip', sessionId)});
  await shelf.retain({...base, id: 'T1', name: 'scout'});
  await shelf.retain({...base, id: 'T2'});
  await shelf.park({...base, id: 'T1', name: 'scout'});
  const entry = (await shelf.names('s', 'techne', 'act'));
  assert.deepEqual([...entry], [['scout', 'T1']], 'only named workers are in the name index');
  const fresh = new WorkerShelf();
  fresh.configure({dir: sessionId => join(root, 'round-trip', sessionId)});
  assert.equal((await fresh.find('s', 'techne', 'act', 'T1'))?.name, 'scout');
  // A file written before names existed has no `name` field.
  const old = join(root, 'round-trip', 's', 'act', 'T9.json');
  await writeFile(old, JSON.stringify({id: 'T9', sessionId: 's', ownerId: 'techne', activityId: 'act', workerId: 'w9', grant: {writes: [], exclusive: []}, system: 'sys', vision: false, lastInput: 1, messages: []}));
  const loaded = await fresh.find('s', 'techne', 'act', 'T9');
  assert.equal(loaded?.id, 'T9'); assert.equal(loaded?.name, undefined);
  assert.deepEqual([...(await fresh.names('s', 'techne', 'act'))], [['scout', 'T1']]);
  assert.deepEqual([...(await fresh.names('s', 'kalon', 'act'))], [], 'another dispatcher sees none of them');
});

// ------------------------------------------------------------------------------------------------------------------------------ surfaces
test('Result block: the name follows the id; an unnamed worker\'s block is unchanged', () => {
  const head = {id: 'T1', title: 'Scan', status: 'done' as const, elapsedMs: 1000, model: 'mock/worker'};
  assert.match(resultBlock({...head, name: 'scout'}, {summary: 's'}), /^<automa-result id="T1" name="scout" title="Scan" status="done" took="0:01" model="mock\/worker">/);
  assert.match(resultBlock({...head, name: 'scout', kind: 'fork'}, {summary: 's'}), /^<automa-result id="T1" name="scout" kind="fork" title="Scan"/);
  assert.match(resultBlock(head, {summary: 's'}), /^<automa-result id="T1" title="Scan" status="done"/);
});

const text = (row: SceneRow) => row.displayText ?? row.text;
function cardRows(swarm: AutomaSwarm, args: unknown, folds: Record<string, boolean> = {}, width = 100) {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Swarm', taskTitle: 'Swarm', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'go', {activityId: 'a', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'});
  const id = steps.tool({id: 'automa1', name: 'Automa', arguments: JSON.stringify(args)});
  steps.start(id);
  steps.swarm(id, swarm);
  return buildStageRows(store.getSnapshot(), 's', 'logox', width, {...folds, [id]: folds.open ?? false}, null).map(text);
}

test('UI: a named job shows its name before its title in the card rows; an unnamed job shows its title as before', () => {
  const swarm: AutomaSwarm = {name: 'work crew', jobs: [
    {id: 'T1', name: 'scout', title: 'Trace the resume path through the delivery queue', state: 'running', elapsedMs: 0, startedAt: Date.now() - 3000, calls: []},
    {id: 'T2', title: 'Map the retry handlers', state: 'done', elapsedMs: 4000, calls: []}]};
  const collapsed = cardRows(swarm, {jobs: [{title: 'x', brief: 'x', name: 'scout'}, {title: 'y', brief: 'y'}]});
  assert.ok(collapsed.some(line => /└/.test(line) || /◜|◠|◝|◞|◡|◟/.test(line)) && collapsed.some(line => line.includes('scout · Trace the resume path')), collapsed.join('\n'));
  const open = cardRows(swarm, {jobs: [{title: 'x', brief: 'x'}, {title: 'y', brief: 'y'}]}, {open: true});
  assert.ok(open.some(line => /▸ T1 · scout · Trace the resume path/.test(line)), open.join('\n'));
  assert.ok(open.some(line => /▸ T2 · Map the retry handlers · done/.test(line)), 'unnamed: id, title and state');
  const narrow = cardRows(swarm, {jobs: [{title: 'x', brief: 'x'}]}, {open: true}, 44);
  assert.ok(narrow.some(line => /T1 · scout/.test(line)), 'the name survives clipping before the title does');
  assert.ok(narrow.every(line => stringWidth(line) <= 44));
  const ui = getToolUI('Automa')!;
  assert.equal(ui.title?.({id: 'c', name: 'Automa', arguments: JSON.stringify({jobs: [{title: 'Find callers', brief: 'x', name: 'scout'}]})}), 'Automa · scout · Find callers');
});

const base = {sessionId: 's', stage: '', detail: ''};
function named() {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Fix', status: 'running', rootActivityId: 'root', inputKind: 'human'});
  store.message('s', 'logox', 'user', 'Fix it', {activityId: 'root', inputKind: 'human', source: 'direct', time: 1000});
  store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne', taskTitle: 'Build', status: 'running', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director'});
  store.message('s', 'techne', 'user', 'Build', {activityId: 'tech', inputKind: 'director', source: 'logox', time: 2000});
  const swarm: AutomaSwarm = {name: 'crew', jobs: [
    {id: 'T1', name: 'scout', title: 'Find the callers', state: 'done', elapsedMs: 100, calls: [], stopReason: 'completed', summary: 'three callers'},
    {id: 'T2', title: 'Plain job', state: 'running', elapsedMs: 0, calls: []},
    {id: 'T3', name: 'writer', title: 'Write it', state: 'waiting', elapsedMs: 0, calls: [], after: ['T1']}]};
  store.message('s', 'techne', 'assistant', '', {activityId: 'tech', kind: 'tool', time: 3000, step: {title: 'Automa', state: 'running', elapsedMs: 0, swarm}});
  return store;
}

test('Delegations, team stream, stage and task graph carry the worker name where they show workers', () => {
  const store = named();
  const delegations = projectDelegations({snapshot: store.getSnapshot(), sessionId: 's'});
  const worker = (id: string) => delegations.find(item => item.id === 'tech/' + id)!;
  assert.deepEqual([worker('T1').workerName, worker('T2').workerName, worker('T3').workerName], ['scout', undefined, 'writer']);
  const events = teamEvents({snapshot: store.getSnapshot(), sessionId: 's'});
  const workers = events.find(event => event.kind === 'workers')!;
  assert.deepEqual(workers.items?.map(item => item.name), ['scout', undefined, 'writer']);
  assert.equal(events.find(event => event.kind === 'result')?.workerName, 'scout');
  assert.match(events.find(event => event.kind === 'waiting' && event.from === 'automa')?.text ?? '', /waiting on scout/, 'a wait names the worker it follows by its name');
  const stage = stageAt(events, events.length - 1);
  const jobs = stage.actors.find(actor => actor.id === 'techne')!.jobs;
  assert.deepEqual(jobs.map(item => item.name), ['scout', 'Plain job', 'writer'], 'the stage shows the name, else the title');
  assert.equal(workerName({title: 'T', name: ' x '}), 'x');
  const graph = taskGraph(undefined, delegations, 's')!;
  const titles = graph.plan.nodes.map(node => node.title);
  assert.ok(titles.some(title => title.startsWith('scout · Find the callers')), titles.join(' | '));
  assert.ok(titles.some(title => title.startsWith('Plain job')) && !titles.some(title => title.includes('undefined')));
});
