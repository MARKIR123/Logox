import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {automaSchema, automaToolDefinitions, markInterruptedJobs, parseReport, AUTOMA_SYSTEM_PROMPT, AUTOMA_RETAINED_INPUT_LIMIT, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {automaProfileSchema, chooseAutomaModel, type AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import {AUTOMA_ANIMATION_FRAMES, AUTOMA_COLOR_TOKEN, AUTOMA_DESCRIPTION} from '../src/tools/orchestration/AutomaTool/prompt.js';
import {metadata} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {patternsOverlap} from '../src/tools/ownership.js';
import {pathDenial} from '../src/tools/orchestration/AutomaTool/grant.js';
import {getActorScratchpadDir, getScratchpadDir} from '../src/kernel/scratchpad.js';
import {Tools, validateToolCall, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine, type PermissionMode} from '../src/permissions/engine.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {actorDefinitionSchema} from '../src/actors/definitions.js';
import {builtinActors} from '../src/actors/builtins.js';
import {isToolAllowedForActor} from '../src/tools/metadata.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelMessage, ModelTurn} from '../src/runtime/messages.js';

type Step = readonly [string, unknown] | string;
const writer: AutomaProfile = {name: 'work crew', default_preset: 'scout', presets: {
  scout: {tools: 'read'},
  edit: {tools: 'write', commands: ['node --version', 'node -p'], exclusive: ['node -p']},
}};

function principal(signal: AbortSignal = new AbortController().signal, overrides: Partial<ActorContext> = {}): ActorContext {
  return {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};},
    async permission() {throw new Error('Unexpected approval');}, ...overrides};
}

/** Scripted workers keyed by the opening words of their brief; each model turn takes the next step, a string being the final report. */
function workers(script: Readonly<Record<string, readonly Step[]>>, requests: {system: string; messages: readonly ModelMessage[]; tools: readonly string[]}[] = []): AutomaProvider {
  const turns = new Map<string, number>();
  return {
    async respond(request) {
      requests.push({system: request.system, messages: [...request.messages], tools: request.tools.map(tool => tool.name)});
      const first = request.messages[0]?.text ?? '';
      const key = Object.keys(script).find(brief => first.startsWith(brief));
      assert.ok(key, 'No script for brief: ' + first);
      const at = turns.get(key) ?? 0;
      turns.set(key, at + 1);
      const step = script[key]![at] ?? 'summary: ran out of script';
      if (typeof step === 'string') return {message: {role: 'assistant', text: step}, stop: 'complete', usage: {input: 10, output: 5}};
      return {message: {role: 'assistant', text: '', toolCalls: [{id: 'call_' + at, name: step[0], arguments: JSON.stringify(step[1])}]}, stop: 'tools', usage: {input: 10, output: 5}};
    },
  };
}

async function project(mode: PermissionMode = 'creative') {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-'));
  await writeFile(join(cwd, '.env'), 'SECRET=1\n');
  await writeFile(join(cwd, 'plain.txt'), 'hello\n');
  await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n');
  await writeFile(join(cwd, 'b.txt'), 'three\n');
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, mode));
  return {cwd, tools, done: () => rm(cwd, {recursive: true, force: true})};
}
function environment(provider: AutomaProvider, overrides: Partial<AutomaEnvironment> = {}): AutomaEnvironment {
  return {resolveModel: () => ({provider, model: 'mock/worker'}), profile: () => writer, ...overrides};
}
const job = (brief: string, extra: Record<string, unknown> = {}) => ({title: brief, brief, ...extra});
const dispatch = (args: unknown, name = 'Automa') => ({id: 'dispatch', name, arguments: JSON.stringify(args)});
/** Tool results a worker received, in order. */
const toolResults = (requests: readonly {messages: readonly ModelMessage[]}[]) => requests.at(-1)!.messages.flatMap(message => message.role === 'tool' ? [message] : []);

test('Automa is open to every actor and loads eagerly, with no defaulted model-facing field', () => {
  assert.equal(metadata.roles, 'all');
  for (const actor of ['logox', 'techne', 'kalon', 'aletheia']) assert.ok(isToolAllowedForActor('all', actor));
  assert.equal(metadata.loading, 'eager');
  const schema = JSON.stringify(automaSchema.toJSONSchema());
  assert.doesNotMatch(schema, /"default"/);
  assert.equal(automaSchema.safeParse({jobs: []}).success, false);
  assert.equal(automaSchema.safeParse({jobs: Array.from({length: 9}, () => job('x'))}).success, false);
  assert.equal(automaSchema.safeParse({jobs: [job('x', {extra: 1})]}).success, false);
  assert.equal(validateToolCall(dispatch({jobs: [job('scan references')]})).valid, true);
  assert.equal(validateToolCall(dispatch({release: ['w1']})).valid, true);
});

test('A job only ever receives the tools its grant implies', () => {
  const names = (grant: Parameters<typeof automaToolDefinitions>[0]) => automaToolDefinitions(grant).map(tool => tool.name);
  // Edit and Write are always offered; without `files` they are confined to the dispatcher's scratchpad by pathDenial.
  assert.deepEqual(names({files: [], commands: [], exclusive: []}), ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write']);
  assert.deepEqual(names({files: ['a'], commands: [], exclusive: []}), ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write']);
  assert.deepEqual(names({files: [], commands: ['npm test'], exclusive: []}), ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write', 'Shell']);
});

test('Worker reads pass the permission guard: a credential path asks in default mode, labelled with the swarm', async () => {
  const {tools, done} = await project('default');
  try {
    const requests: Parameters<typeof workers>[1] = [], asked: {title: string; tool: string}[] = [];
    tools.setAutomaEnvironment(environment(workers({Inspect: [['Read', {file_path: '.env'}], ['Read', {file_path: 'plain.txt'}], 'summary: looked']}, requests)));
    const result = await tools.execute(dispatch({jobs: [job('Inspect')]}), principal(undefined, {async permission(input) {asked.push(input); return false;}}));
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(asked.map(item => [item.title, item.tool]), [["Techne's work crew: allow read?", 'read']]);
    const [secret, plain] = toolResults(requests);
    assert.equal(secret?.isError, true);
    assert.doesNotMatch(secret!.text, /SECRET/);
    assert.match(plain!.text, /hello/);
    assert.match(result.text, /denied: Read/);
    const record = tools.permissionGuard({sessionId: 's'}).snapshot().find(item => item.decision === 'deny');
    assert.equal(record?.owner, 'techne');
    assert.match(record!.action, /^Techne's work crew · read/);
  } finally {await done();}
});

test('Worker reads obey creative-mode dangers and explicit deny rules', async () => {
  const {tools, done} = await project('creative');
  try {
    await tools.permissions.add({scope: 'session', decision: 'deny', tool: 'read', pattern: 'plain.txt'});
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Inspect: [['Read', {file_path: '.env'}], ['Read', {file_path: 'plain.txt'}], 'summary: refused']}, requests)));
    const result = await tools.execute(dispatch({jobs: [job('Inspect')]}), principal());
    assert.deepEqual(toolResults(requests).map(item => item.isError), [true, true]);
    assert.doesNotMatch(toolResults(requests).map(item => item.text).join(), /SECRET|hello/);
    assert.match(result.text, /job 1\/1 · denied/);
    assert.equal(result.isError, true);
    assert.equal(result.disposition, 'denied');
  } finally {await done();}
});

test('A tool the principal cannot use stays unavailable however the grant reads', async () => {
  const {tools, done} = await project();
  try {
    tools.setRegistry({getToolsForActor: () => [{name: 'Automa'}, {name: 'Grep'}]} as never);
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Inspect: [['Read', {file_path: 'plain.txt'}], 'summary: no read']}, requests)));
    await tools.execute(dispatch({jobs: [job('Inspect')]}), principal());
    assert.match(toolResults(requests)[0]!.text, /unavailable for this actor/);
  } finally {await done();}
});

test('Workers never reach orchestration tools, questions or tools outside their grant', async () => {
  const {cwd, tools, done} = await project();
  try {
    const requests: Parameters<typeof workers>[1] = [];
    const script: Step[] = [['Automa', {jobs: [job('nested')]}], ['Actor', {tasks: []}], ['AskUserQuestion', {questions: []}], ['SendMessage', {to: 'kalon', message: 'x'}],
      ['Write', {file_path: 'plain.txt', content: 'hacked'}], ['Edit', {file_path: 'plain.txt', old_string: 'hello', new_string: 'x'}], ['Shell', {command: 'node --version'}], 'summary: all refused'];
    tools.setAutomaEnvironment(environment(workers({Inspect: script}, requests)));
    await tools.execute(dispatch({jobs: [job('Inspect')]}), principal());
    const results = toolResults(requests);
    assert.equal(results.length, 7);
    assert.ok(results.every(item => item.isError), JSON.stringify(results));
    assert.deepEqual(requests.at(-1)!.tools, ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write']);
    assert.equal(await readFile(join(cwd, 'plain.txt'), 'utf8'), 'hello\n');
  } finally {await done();}
});

test('The read grant narrows reads and searches, refusing without an approval', async () => {
  const {tools, done} = await project('default');
  try {
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Inspect: [['Read', {file_path: 'a.txt'}], ['Read', {file_path: 'plain.txt'}], ['Grep', {pattern: 'hello'}], ['Read', {file_path: '../outside.txt'}], 'summary: scoped']}, requests)));
    await tools.execute(dispatch({jobs: [job('Inspect', {read: ['a.txt']})]}), principal());
    const results = toolResults(requests);
    assert.equal(results[0]!.isError, false, results[0]!.text);
    assert.match(results[1]!.text, /outside this job's read scope/);
    assert.match(results[2]!.text, /outside this job's read scope/);
    assert.match(results[3]!.text, /outside the workspace|read scope/);
  } finally {await done();}
});

test('Worker reads never satisfy the principal read guard, and workers stay silent on the stage', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-observe-'));
  try {
    const reports: string[] = [], tools = new Tools(cwd, (_context, text) => reports.push(text), new PermissionEngine(cwd, 'creative'));
    const file = join(cwd, 'shared.txt');
    await writeFile(file, 'old\n');
    const kalon = principal(undefined, {ownerId: 'kalon'});
    let started = 0;
    await tools.execute({id: 'r', name: 'Read', arguments: JSON.stringify({file_path: file})}, kalon);
    await tools.execute({id: 'w', name: 'Write', arguments: JSON.stringify({file_path: file, content: 'peer\n'})}, kalon);
    reports.length = 0;
    tools.setAutomaEnvironment(environment(workers({Read: [['Read', {file_path: file}], 'summary: read']})));
    await tools.execute(dispatch({jobs: [job('Read it')]}), principal(undefined, {startTool() {started++;}}));
    assert.equal(started, 1);
    assert.deepEqual(reports, []);
    const write = await tools.execute({id: 'p', name: 'Write', arguments: JSON.stringify({file_path: file, content: 'mine\n'})}, principal());
    assert.equal(write.isError, true, write.text);
    assert.match(write.text, /modified by kalon/);
    assert.equal(await readFile(file, 'utf8'), 'peer\n');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('A missing environment is reported, and a real delta sink reaches the provider', async () => {
  const {tools, done} = await project();
  try {
    const missing = await tools.execute(dispatch({jobs: [job('x')]}), principal());
    assert.equal(missing.isError, true);
    assert.match(missing.text, /requires a model provider/);
    tools.setAutomaEnvironment(environment({async respond(_request, onDelta) {
      onDelta({kind: 'text', text: 'streamed'});
      return {message: {role: 'assistant', text: 'summary: streamed'}, stop: 'complete'};
    }}));
    const result = await tools.execute(dispatch({jobs: [job('x')]}, 'automa'), principal());
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /summary: streamed/);
  } finally {await done();}
});

test('Jobs run in parallel up to the limit; one failure leaves the others alone', async () => {
  const {tools, done} = await project();
  try {
    let running = 0, peak = 0;
    const provider: AutomaProvider = {async respond({messages}) {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setImmediate(resolve));
      running--;
      if (messages[0]!.text.startsWith('bad')) throw new Error('worker exploded');
      return {message: {role: 'assistant', text: 'summary: ok'}, stop: 'complete'};
    }};
    tools.setAutomaEnvironment(environment(provider));
    const jobs = ['good1', 'bad', 'good2', 'good3', 'good4', 'good5'].map(brief => job(brief));
    const result = await tools.execute(dispatch({jobs}), principal());
    assert.equal(peak, 4, 'default limit');
    assert.match(result.text, /5\/6 done/);
    assert.match(result.text, /job 2\/6 · failed[^\n]*\nsummary: worker exploded/);
    assert.equal(result.isError, false);
    peak = 0;
    await tools.execute(dispatch({jobs: jobs.filter(item => item.brief !== 'bad'), parallel: 2}), principal());
    assert.equal(peak, 2, 'explicit parallel');
    peak = 0;
    tools.setAutomaEnvironment(environment(provider, {maxParallel: () => 3}));
    await tools.execute(dispatch({jobs}), principal());
    assert.equal(peak, 3, 'configured default');
  } finally {await done();}
});

test('Jobs share nothing with each other or across dispatches, and the worker prompt is identical', async () => {
  const {tools, done} = await project();
  try {
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({one: ['summary: 1'], two: ['summary: 2'], three: ['summary: 3']}, requests)));
    await tools.execute(dispatch({jobs: [job('one'), job('two')]}), principal());
    await tools.execute(dispatch({jobs: [job('three')]}), principal());
    assert.ok(requests.every(request => request.messages.length === 1 && request.system === AUTOMA_SYSTEM_PROMPT));
    assert.doesNotMatch(requests.at(-1)!.messages[0]!.text!, /one|two/);
  } finally {await done();}
});

test('Cancelling the principal stops every job; finished writes stay and can be undone', async () => {
  const {cwd, tools, done} = await project();
  try {
    const controller = new AbortController();
    const provider: AutomaProvider = {async respond({messages}) {
      const wrote = messages.some(message => message.role === 'tool');
      if (wrote) controller.abort();
      return wrote ? {message: {role: 'assistant', text: 'summary: never read'}, stop: 'complete'}
        : {message: {role: 'assistant', text: '', toolCalls: [{id: 'w', name: 'Write', arguments: JSON.stringify({file_path: 'a.txt', content: 'written\n'})}]}, stop: 'tools'};
    }};
    tools.setAutomaEnvironment(environment(provider));
    const result = await tools.execute(dispatch({preset: 'edit', jobs: [job('Write', {files: ['a.txt']})], parallel: 1}), principal(controller.signal));
    assert.equal(result.isError, true);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'written\n');
    const undone = await tools.snapshots.undo(['act']);
    assert.equal(undone.length, 1);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally {await done();}
});

test('Retryable provider failures back off and retry; others fail the job at once', async () => {
  const {tools, done} = await project();
  try {
    let calls = 0;
    tools.setAutomaEnvironment(environment({async respond() {
      if (++calls === 1) throw Object.assign(new Error('Model service temporarily unavailable'), {retryable: true});
      return {message: {role: 'assistant', text: 'summary: recovered'}, stop: 'complete'};
    }}));
    const ok = await tools.execute(dispatch({jobs: [job('x')]}), principal());
    assert.equal(calls, 2);
    assert.match(ok.text, /recovered/);
    calls = 0;
    tools.setAutomaEnvironment(environment({async respond() {calls++; throw new Error('Authentication failed');}}));
    const bad = await tools.execute(dispatch({jobs: [job('x')]}), principal());
    assert.equal(calls, 1);
    assert.match(bad.text, /failed[^\n]*\nsummary: Authentication failed/);
  } finally {await done();}
});

test('One dispatch at a time per actor; peers are independent', async () => {
  const {tools, done} = await project();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    tools.setAutomaEnvironment(environment({async respond() {await gate; return {message: {role: 'assistant', text: 'summary: ok'}, stop: 'complete'};}}));
    const first = tools.execute(dispatch({jobs: [job('x')]}), principal());
    const second = await tools.execute(dispatch({jobs: [job('y')]}), principal());
    assert.equal(second.disposition, 'denied');
    assert.match(second.text, /already have an Automa dispatch/);
    const peer = tools.execute(dispatch({jobs: [job('z')]}), principal(undefined, {ownerId: 'kalon', activityId: 'k'}));
    release();
    assert.equal((await first).isError, false);
    assert.equal((await peer).isError, false);
  } finally {await done();}
});

test('Receipts: changed comes from real writes, whatever the worker claims', async () => {
  const {cwd, tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(workers({Rename: [
      ['Read', {file_path: 'a.txt'}], ['Edit', {file_path: 'a.txt', old_string: 'two', new_string: 'TWO'}],
      ['Write', {file_path: 'new.txt', content: 'x\ny\n'}],
      'summary: renamed everything, including README.md\nevidence: a.txt:2\nnotes: b.txt also mentions it; left unchanged',
    ], Claim: ['summary: I edited a.txt and b.txt']})));
    const result = await tools.execute(dispatch({preset: 'edit', parallel: 1, jobs: [job('Rename', {files: ['a.txt', 'new.txt']}), job('Claim')]}), principal());
    assert.match(result.text, /^\[job 1\/2 · done · \d+\.\ds\] Rename$/m);
    assert.match(result.text, /^changed: a\.txt \(\+1 −1\), new\.txt \(\+2 −0\)$/m);
    assert.match(result.text, /^evidence: a\.txt:2$/m);
    assert.match(result.text, /^notes: b\.txt also mentions it; left unchanged$/m);
    const claim = result.text.slice(result.text.indexOf('[job 2/2'));
    assert.doesNotMatch(claim, /changed:/);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one\nTWO\n');
    assert.deepEqual(await tools.snapshots.undo(['act']).then(paths => paths.length), 2);
  } finally {await done();}
});

test('Writes outside files are refused with no approval, even through a link-free relative path', async () => {
  const {cwd, tools, done} = await project('default');
  try {
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Fix: [['Write', {file_path: 'b.txt', content: 'x'}], ['Write', {file_path: '../escape.txt', content: 'x'}], 'summary: refused']}, requests)));
    await tools.execute(dispatch({preset: 'edit', jobs: [job('Fix', {files: ['a.txt']})]}), principal());
    assert.ok(toolResults(requests).every(item => /outside this job's write grant/.test(item.text)));
    assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'three\n');
  } finally {await done();}
});

test('Writes inside files still pass the permission engine', async () => {
  const {cwd, tools, done} = await project('default');
  try {
    const asked: string[] = [];
    tools.setAutomaEnvironment(environment(workers({Fix: [['Write', {file_path: 'a.txt', content: 'x'}], 'summary: tried']})));
    await tools.execute(dispatch({preset: 'edit', jobs: [job('Fix', {files: ['a.txt']})]}), principal(undefined, {async permission(input) {asked.push(input.title); return false;}}));
    assert.deepEqual(asked, ["Techne's work crew: allow write?"]);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally {await done();}
});

test('A dispatch is refused whole for overlaps, read-only presets, wide grants and unknown presets', async () => {
  const {tools, done} = await project();
  try {
    let started = 0;
    tools.setAutomaEnvironment(environment({async respond() {started++; return {message: {role: 'assistant', text: 'summary: x'}, stop: 'complete'};}}));
    const refused = async (args: unknown, pattern: RegExp) => {
      const result = await tools.execute(dispatch(args), principal());
      assert.equal(result.disposition, 'denied', result.text);
      assert.match(result.text, pattern);
    };
    await refused({preset: 'edit', jobs: [job('p', {files: ['src/a.css']}), job('q', {files: ['src/*.css']})]}, /overlapping files: src\/a\.css and src\/\*\.css/);
    await refused({preset: 'edit', jobs: [job('p', {files: ['**/*']})]}, /not the whole workspace/);
    await refused({preset: 'edit', jobs: [job('p', {files: ['.']})]}, /not the whole workspace/);
    await refused({preset: 'edit', jobs: [job('p', {files: ['../x']})]}, /inside the workspace/);
    await refused({preset: 'scout', jobs: [job('p', {files: ['a.txt']})]}, /read-only.*Writable presets: edit/);
    await refused({preset: 'edit', jobs: [job('p', {commands: ['rm -rf']})]}, /does not allow the command prefix: rm -rf/);
    await refused({jobs: [job('p', {files: ['/tmp/scratch/x.py']})]}, /inside the workspace/);
    await refused({}, /needs `jobs`/);
    assert.equal(started, 0);
  } finally {await done();}
});

test('patternsOverlap errs toward conflict but separates clearly disjoint sets', () => {
  const cwd = tmpdir();
  for (const [a, b] of [['a.css', 'a.css'], ['src', 'src/a.ts'], ['src/*.css', 'src/a.css'], ['src/**', 'src/x/*.ts'], ['*.css', 'x/y.css'], ['src/*', 'src/*.ts']] as const) assert.ok(patternsOverlap(a, b, cwd), a + ' / ' + b);
  for (const [a, b] of [['a.css', 'b.css'], ['src/a', 'src/ab'], ['src/*.css', 'src/*.ts'], ['src/*.ts', 'lib/*.ts'], ['src/a.ts', 'lib/*.ts']] as const) assert.ok(!patternsOverlap(a, b, cwd), a + ' / ' + b);
});

test("Files in another actor's active work are denied per job, naming the holder; the rest of the batch runs", async () => {
  const {tools, done} = await project();
  try {
    const store = new RuntimeStore();
    tools.setActivityProbe(() => store.getSnapshot().activities);
    store.activities.create({sessionId: 's', activityId: 'kalon-act', ownerId: 'kalon', kind: 'actor', title: 'Restyle', taskTitle: 'Restyle page', status: 'running', stage: 'x', detail: 'x', ownedFiles: ['a.txt']});
    tools.setAutomaEnvironment(environment(workers({Free: ['summary: free ok'], Taken: ['summary: should not run']})));
    const result = await tools.execute(dispatch({preset: 'edit', jobs: [job('Taken', {files: ['a.txt']}), job('Free', {files: ['b.txt']})]}), principal());
    assert.match(result.text, /job 1\/2 · denied[^\n]*\nsummary: a\.txt is held by Kalon's active assignment "Restyle page"/);
    assert.match(result.text, /job 2\/2 · done/);
    assert.doesNotMatch(result.text, /should not run/);
  } finally {await done();}
});

test('Ownership taken during a job blocks the write at write time', async () => {
  const {cwd, tools, done} = await project();
  try {
    const store = new RuntimeStore(), requests: Parameters<typeof workers>[1] = [];
    tools.setActivityProbe(() => store.getSnapshot().activities);
    const provider = workers({Fix: [['Write', {file_path: 'a.txt', content: 'x'}], 'summary: tried']}, requests);
    tools.setAutomaEnvironment(environment({respond(request, onDelta, signal) {
      if (!store.activities.get('s', 'late')) store.activities.create({sessionId: 's', activityId: 'late', ownerId: 'kalon', kind: 'actor', title: 'Late', status: 'running', stage: 'x', detail: 'x', ownedFiles: ['a.txt']});
      return provider.respond(request, onDelta, signal);
    }}));
    await tools.execute(dispatch({preset: 'edit', jobs: [job('Fix', {files: ['a.txt']})]}), principal());
    assert.match(toolResults(requests)[0]!.text, /belongs to Kalon's active assignment/);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one\ntwo\n');
  } finally {await done();}
});

test("Two actors' running jobs cannot be granted the same files", async () => {
  const {tools, done} = await project();
  try {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    tools.setAutomaEnvironment(environment({async respond() {await gate; return {message: {role: 'assistant', text: 'summary: ok'}, stop: 'complete'};}}));
    const first = tools.execute(dispatch({preset: 'edit', jobs: [job('x', {files: ['a.txt']})]}), principal());
    const second = await tools.execute(dispatch({preset: 'edit', jobs: [job('y', {files: ['a.txt']})]}), principal(undefined, {ownerId: 'kalon', activityId: 'k'}));
    assert.match(second.text, /held by a running Automa job of Techne/);
    release();
    await first;
  } finally {await done();}
});

test('Commands must match a granted prefix; compound commands never do; read-only commands need the whole workspace', async () => {
  const {tools, done} = await project();
  try {
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Run: [['Shell', {command: 'node --version'}], ['Shell', {command: 'node --version && echo pwned'}], ['Shell', {command: 'node -e 1'}], 'summary: ran'],
      Scoped: [['Shell', {command: 'cat plain.txt'}], 'summary: scoped']}, requests)));
    const result = await tools.execute(dispatch({preset: 'edit', jobs: [job('Run', {commands: ['node --version']})]}), principal());
    const [ok, compound, other] = toolResults(requests);
    assert.equal(ok!.isError, false, ok!.text);
    assert.match(compound!.text, /outside this job's grant/);
    assert.match(other!.text, /outside this job's grant/);
    assert.match(result.text, /^ran: node --version \(passed\)$/m);
    await tools.execute(dispatch({preset: 'edit', jobs: [job('Scoped', {read: ['a.txt'], commands: ['node --version']})]}), principal());
    assert.match(toolResults(requests)[0]!.text, /outside this job's grant/);
  } finally {await done();}
});

test('Exclusive commands run one at a time across jobs', async () => {
  const {tools, done} = await project();
  try {
    const original = tools.snapshots.withLock.bind(tools.snapshots), keys: string[] = [];
    tools.snapshots.withLock = (key, operation) => {keys.push(key); return original(key, operation);};
    tools.setAutomaEnvironment(environment(workers({One: [['Shell', {command: 'node -p 1'}], 'summary: 1'], Two: [['Shell', {command: 'node -p 2'}], 'summary: 2'], Three: [['Shell', {command: 'node --version'}], 'summary: 3']})));
    await tools.execute(dispatch({preset: 'edit', jobs: [job('One'), job('Two'), job('Three')]}), principal());
    assert.deepEqual(keys.filter(key => key === 'automa-exclusive-command').length, 2);
  } finally {await done();}
});

test('Keeping: single use by default; keep returns a real id, continue resumes with context and the original grant, release ends it', async () => {
  const {cwd, tools, done} = await project();
  try {
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Once: ['summary: once'], More: ['summary: fresh'], Loop: [['Read', {file_path: 'a.txt'}], 'summary: first pass', ['Write', {file_path: 'a.txt', content: 'fixed\n'}], ['Write', {file_path: 'b.txt', content: 'no\n'}], 'summary: second pass', 'summary: third']}, requests)));
    const single = await tools.execute(dispatch({jobs: [job('Once')]}), principal());
    assert.doesNotMatch(single.text, /^kept:/m);
    const first = await tools.execute(dispatch({preset: 'edit', jobs: [job('Loop', {files: ['a.txt'], keep: true})]}), principal());
    const id = /^kept: (w[0-9a-f]+) /m.exec(first.text)?.[1];
    assert.ok(id, first.text);
    assert.ok(first.text.includes(`{"continue": "${id}"}`) && first.text.includes(`{"release": ["${id}"]}`), 'the receipt says how to continue and release');
    const second = await tools.execute(dispatch({jobs: [{title: 'Next', brief: 'Apply the fix now', continue: id}]}), principal());
    assert.match(second.text, /^changed: a\.txt \(\+1 −2\)$/m);
    assert.match(second.text, new RegExp('^kept: ' + id, 'm'));
    const resumed = requests.at(-1)!;
    assert.equal(resumed.messages.filter(message => message.role === 'user').length, 2);
    assert.ok(resumed.messages.some(message => message.role === 'tool' && /one/.test(message.text)), 'keeps what it read');
    assert.ok(resumed.tools.includes('Write'), 'keeps its grant without a preset');
    assert.match(resumed.messages.at(-1)!.text ?? toolResults([resumed]).at(-1)!.text, /outside this job's write grant/);
    assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'three\n');
    const released = await tools.execute(dispatch({release: [id]}), principal());
    assert.equal(released.isError, false);
    assert.match(released.text, new RegExp('Released ' + id));
    // A released id is simply not live any more: the job runs fresh, with a note, and is never an error.
    const gone = await tools.execute(dispatch({jobs: [{title: 'Again', brief: 'More', continue: id}]}), principal());
    assert.equal(gone.isError, false, gone.text);
    assert.match(gone.text, /summary: fresh/);
    assert.match(gone.text, /is not a live kept worker of yours.*fresh single-use job/);
    assert.doesNotMatch(gone.text, /^kept:/m);
  } finally {await done();}
});

test('Keeping boundaries: fixed grant, cap, owner only, one per task, junk ids ignored with a note', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(workers({K: ['summary: k', 'summary: k2', 'summary: k3'], L: ['summary: l'], M: ['summary: m'], N: ['summary: n1', 'summary: n2', 'summary: n3', 'summary: n4', 'summary: n5', 'summary: n6']})));
    const run = (args: unknown, context = principal()) => tools.execute(dispatch(args), context);
    const keep = async (brief: string, context = principal()) => /^kept: (w[0-9a-f]+) /m.exec((await run({jobs: [job(brief, {keep: true})]}, context)).text)?.[1];
    const k = await keep('K'), l = await keep('L');
    assert.ok(k && l);
    const capped = await run({jobs: [job('M', {keep: true})]});
    assert.equal(capped.isError, false, capped.text);
    assert.match(capped.text, /was not kept: at most 2 workers/);
    assert.doesNotMatch(capped.text, /^kept:/m);
    const widened = await run({jobs: [{title: 'x', brief: 'y', continue: k, files: ['a.txt']}]});
    assert.equal(widened.isError, false, widened.text);
    assert.match(widened.text, /keeps the grant it was created with/);
    const twice = await run({jobs: [{title: 'x', brief: 'next', continue: k}, {title: 'z', brief: 'N second', continue: k}]});
    assert.match(twice.text, /already continued by an earlier job/);
    assert.match(twice.text, /2\/2 done/);
    const both = await run({release: [k], jobs: [{title: 'x', brief: 'next', continue: k}]});
    assert.match(both.text, /Release of "[^"]+" ignored: it is continued/);
    assert.match(both.text, new RegExp('^kept: ' + k, 'm'));
    const stolen = await run({jobs: [{title: 'x', brief: 'N third', continue: k}]}, principal(undefined, {ownerId: 'kalon', activityId: 'k'}));
    assert.equal(stolen.isError, false, stolen.text);
    assert.match(stolen.text, /not a live kept worker of yours/);
    const stolenRelease = await run({release: [k]}, principal(undefined, {ownerId: 'kalon', activityId: 'k'}));
    assert.equal(stolenRelease.isError, false);
    assert.match(stolenRelease.text, /Release ignored.*not a live kept worker/);
    const junk = await run({release: ['banana', 'none', 'n/a']});
    assert.equal(junk.isError, false);
    assert.match(junk.text, /Released nothing\./);
    assert.match(junk.text, /"banana" is not a live kept worker/);
    assert.doesNotMatch(junk.text, /"none"|"n\/a"/);
    const junkContinue = await run({jobs: [{brief: 'N fourth', continue: 'wdeadbeef'}, {brief: 'N fifth', continue: 'new'}]});
    assert.equal(junkContinue.isError, false, junkContinue.text);
    assert.match(junkContinue.text, /"wdeadbeef" is not a live kept worker/);
    // A release in the same dispatch frees the slot.
    const swap = await run({release: [l], jobs: [job('M', {keep: true})]});
    assert.match(swap.text, /released/);
    assert.match(swap.text, /^kept: w/m);
    // The next task of the same actor finds nothing: kept workers end with their task.
    const next = principal(undefined, {activityId: 'next-task'});
    const later = await run({jobs: [{title: 'x', brief: 'N sixth', continue: k}]}, next);
    assert.match(later.text, /not a live kept worker/);
    assert.ok(await keep('N', next));
  } finally {await done();}
});

test('Keeping: keep false on continue, failure and oversized context all end the worker; the old field names still work', async () => {
  const {tools, done} = await project();
  try {
    let input = 10, fail = false;
    tools.setAutomaEnvironment(environment({async respond() {
      if (fail) throw new Error('boom');
      return {message: {role: 'assistant', text: 'summary: ok'}, stop: 'complete', usage: {input, output: 1}} satisfies ModelTurn;
    }}));
    const keep = async () => /^kept: (w[0-9a-f]+) /m.exec((await tools.execute(dispatch({jobs: [job('K', {keep: true})]}), principal())).text)![1]!;
    const resume = (id: string, extra = {}) => tools.execute(dispatch({jobs: [{title: 'x', brief: 'next', continue: id, ...extra}]}), principal());
    const live = (text: string) => !/not a live kept worker/.test(text);
    const closing = await keep();
    assert.doesNotMatch((await resume(closing, {keep: false})).text, /^kept:/m);
    assert.ok(!live((await resume(closing)).text));
    const failing = await keep();
    fail = true;
    assert.match((await resume(failing)).text, /· failed/);
    fail = false;
    assert.ok(!live((await resume(failing)).text));
    const large = await keep();
    input = AUTOMA_RETAINED_INPUT_LIMIT;
    const closed = await resume(large);
    assert.match(closed.text, /Instance closed: its context reached/);
    assert.doesNotMatch(closed.text, /^kept:/m);
    input = 10;
    assert.ok(!live((await resume(large)).text));
    // Old names: persistence -> keep, instance -> continue, release stays.
    const old = await tools.execute(dispatch({jobs: [{brief: 'K', persistence: true}]}), principal());
    const oldId = /^kept: (w[0-9a-f]+) /m.exec(old.text)?.[1];
    assert.ok(oldId, old.text);
    const viaAlias = await tools.execute(dispatch({jobs: [{brief: 'next', instance: oldId, persistence: false}]}), principal());
    assert.ok(live(viaAlias.text), viaAlias.text);
    assert.doesNotMatch(viaAlias.text, /^kept:/m);
  } finally {await done();}
});

test('The tool contract states keep and continue concisely', () => {
  assert.match(AUTOMA_DESCRIPTION, /`keep: true`/);
  assert.match(AUTOMA_DESCRIPTION, /continue: "<id from the receipt>"/);
  assert.match(AUTOMA_DESCRIPTION, /ends with your task/);
  assert.match(AUTOMA_DESCRIPTION, /Example: \{"jobs"/);
  assert.ok(AUTOMA_DESCRIPTION.length < 2200);
  const keys = Object.keys((automaSchema.toJSONSchema() as unknown as {properties: {jobs: {items: {properties: object}}}}).properties.jobs.items.properties);
  assert.ok(keys.includes('keep') && keys.includes('continue') && !keys.includes('persistence') && !keys.includes('instance'));
});

test('Scratchpad: a worker writes only inside its dispatcher\'s own scratchpad subdirectory, never the workspace or another actor\'s', async () => {
  // The permission engine compares canonical paths with the scratchpad string, so the temp root must be in canonical form (Windows 8.3 names differ).
  const saved = {TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR};
  const canonicalTemp = await realpath(tmpdir());
  Object.assign(process.env, {TEMP: canonicalTemp, TMP: canonicalTemp, TMPDIR: canonicalTemp});
  const {cwd, tools, done} = await project('default');
  const mine = getActorScratchpadDir(cwd, 's', 'techne'), theirs = getActorScratchpadDir(cwd, 's', 'kalon');
  try {
    tools.permissions.setScratchpadDir(getScratchpadDir(cwd, 's'));
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Scratch: [
      ['Write', {file_path: join(mine, 'probe.py'), content: 'print(1)\n'}],
      ['Edit', {file_path: join(mine, 'probe.py'), old_string: '1', new_string: '2'}],
      ['Write', {file_path: join(theirs, 'x.py'), content: 'x'}],
      ['Write', {file_path: join(mine, '..', 'kalon', 'y.py'), content: 'y'}],
      ['Write', {file_path: 'plain.txt', content: 'hacked'}],
      ['Write', {file_path: join(cwd, 'b.txt'), content: 'hacked'}],
      'summary: done']}, requests)));
    // A read-only dispatch (no files, no commands) still gets scratch writes, and nothing else.
    const result = await tools.execute(dispatch({jobs: [job('Scratch')]}), principal());
    const early = toolResults(requests).slice(0, 2).map(item => item.text).join(" / ");
    assert.equal(result.isError, false, early);
    const [write, edit, other, dotdot, workspace, absolute] = toolResults(requests);
    assert.equal(write?.isError, false, write?.text);
    assert.equal(edit?.isError, false, edit?.text);
    assert.equal(await readFile(join(mine, 'probe.py'), 'utf8'), 'print(2)\n');
    for (const refused of [other, dotdot, workspace, absolute]) {
      assert.equal(refused?.isError, true);
      assert.match(refused!.text, /outside this job's write grant.*No workspace files are writable and your scratchpad/);
    }
    await assert.rejects(readFile(join(theirs, 'x.py')));
    await assert.rejects(readFile(join(theirs, 'y.py')));
    assert.equal(await readFile(join(cwd, 'plain.txt'), 'utf8'), 'hello\n');
    assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'three\n');
    assert.ok(requests[0]!.messages[0]!.text.includes(mine), 'the brief names the worker\'s scratchpad');
    // The workspace grant is unchanged: `files` still limits workspace writes even while the scratchpad is open.
    assert.match(pathDenial('Write', {files: ['a.txt'], commands: [], exclusive: []}, {lexical: join(cwd, 'b.txt'), cwd, canonical: join(cwd, 'b.txt'), root: cwd, scratch: {lexical: mine, canonical: mine}})!, /Writable: a\.txt/);
  } finally {
    await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true});
    for (const [key, value] of Object.entries(saved)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
    await done();
  }
});

test('Shipped Aletheia probe: read-only workspace plus python and node commands, still gated by the dispatcher', async () => {
  const aletheia = builtinActors.find(actor => actor.id === 'aletheia')!.automa!;
  const probe = aletheia.presets.probe!;
  assert.equal(probe.tools, 'read');
  for (const command of ['python', 'python3', 'py', 'node']) assert.ok(probe.commands!.includes(command), command);
  const {cwd, tools, done} = await project('default');
  try {
    const requests: Parameters<typeof workers>[1] = [];
    const asked: string[] = [];
    tools.setAutomaEnvironment(environment(workers({Check: [['Shell', {command: 'python -c "print(1)"'}], ['Write', {file_path: 'a.txt', content: 'x'}], 'summary: tried']}, requests), {profile: () => aletheia}));
    // The preset is chosen from the requested command; no preset name is given.
    const result = await tools.execute(dispatch({jobs: [job('Check', {commands: ['python -c']})]}), principal(undefined, {ownerId: 'aletheia', async permission(input) {asked.push(input.title); return false;}}));
    assert.doesNotMatch(result.text, /does not allow the command prefix/);
    const [shell, write] = toolResults(requests);
    assert.ok(asked.some(title => /allow/.test(title)), 'the dispatcher\'s permission engine is still consulted: ' + JSON.stringify(asked));
    assert.equal(shell?.isError, true);
    assert.equal(write?.isError, true);
    assert.match(write!.text, /outside this job's write grant/);
    assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'one\ntwo\n');
    // A dispatcher without the Shell tool cannot hand it to a worker through any preset.
    tools.setRegistry({getToolsForActor: () => [{name: 'Automa'}, {name: 'Read'}]} as never);
    const blocked: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Check: [['Shell', {command: 'node --version'}], 'summary: no']}, blocked), {profile: () => aletheia}));
    await tools.execute(dispatch({jobs: [job('Check', {commands: ['node']})]}), principal(undefined, {ownerId: 'aletheia'}));
    assert.match(toolResults(blocked)[0]!.text, /unavailable for this actor/);
  } finally {await done();}
});

test('Models write the minimum: tasks, bare strings, task for brief, no title, and placeholders in optional fields all work', async () => {
  const {tools, done} = await project();
  try {
    const requests: Parameters<typeof workers>[1] = [];
    tools.setAutomaEnvironment(environment(workers({Alpha: ['summary: a'], Beta: ['summary: b'], Gamma: ['summary: c'], Delta: ['summary: d']}, requests)));
    const alias = await tools.execute(dispatch({tasks: ['Alpha one', {task: 'Beta two'}]}), principal());
    assert.equal(alias.isError, false, alias.text);
    assert.match(alias.text, /\[job 1\/2 · done · [\d.]+s\] Alpha one/);
    assert.match(alias.text, /\[job 2\/2 · done · [\d.]+s\] Beta two/);
    // The exact junk a strong model produced in a real session: every optional field filled with a placeholder.
    const junk = await tools.execute(dispatch({jobs: [{brief: 'Gamma scan', files: ['__no_writes_allowed__'], commands: ['n/a'], read: ['.'], output: 'text', persistence: false, instance: 'n/a'}], preset: 'default', parallel: 1, release: ['none']}), principal());
    assert.equal(junk.isError, false, junk.text);
    assert.match(junk.text, /summary: c/);
    assert.deepEqual(requests.at(-1)!.tools, ['Read', 'Glob', 'Grep', 'WebFetch', 'Edit', 'Write']);
    // Files without a preset pick the writable one; an unknown preset falls back with a note instead of failing.
    const picked = await tools.execute(dispatch({preset: 'nope', jobs: [{brief: 'Delta edit', files: ['a.txt']}]}), principal());
    assert.equal(picked.isError, false, picked.text);
    assert.ok(requests.at(-1)!.tools.includes('Write'));
    assert.match(picked.text, /Preset "nope" does not exist \(available: scout, edit\); used "edit"/);
    assert.equal(validateToolCall(dispatch({jobs: ['just a string']})).valid, true);
    assert.equal(validateToolCall(dispatch({jobs: [{brief: 'x', files: ['__none__']}]})).valid, true);
  } finally {await done();}
});

test('A missing dispatch explains the minimal shape', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment(workers({})));
    const result = await tools.execute(dispatch({}), principal());
    assert.equal(result.disposition, 'denied');
    assert.match(result.text, /needs `jobs`, for example \{"jobs": \[\{"brief"/);
  } finally {await done();}
});

test('The journal records the whole process under the principal; usage is charged to it; progress is live', async () => {
  const {cwd, tools, done} = await project();
  try {
    const journalPath = join(cwd, 'sessions', 's', 'subagents', 'automa.jsonl');
    const charged: [string, string, number][] = [], frames: AutomaSwarm[] = [];
    tools.setAutomaEnvironment(environment(workers({Scan: [['Read', {file_path: 'plain.txt'}], 'summary: found\nevidence: plain.txt:1']}), {
      journalPath: () => journalPath, charge: (context, usage, model) => {charged.push([context.ownerId, model, usage?.input ?? 0]);},
    }));
    const result = await tools.execute(dispatch({jobs: [job('Scan')]}), principal(undefined, {reportSwarm: swarm => frames.push(swarm)}));
    assert.equal(result.isError, false);
    const entries = (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(entries.map(entry => entry.event), ['start', 'message', 'tool', 'message', 'end']);
    assert.ok(entries.every(entry => entry.principal === 'techne' && entry.parentActivityId === 'act' && entry.jobIndex === 0));
    assert.deepEqual(charged, [['techne', 'mock/worker', 10], ['techne', 'mock/worker', 10]]);
    assert.equal(frames[0]!.name, 'work crew');
    assert.equal(frames[0]!.jobs[0]!.state, 'queued');
    assert.ok(frames.some(frame => frame.jobs[0]!.state === 'running' && frame.jobs[0]!.tool?.includes('plain.txt')));
    const last = frames.at(-1)!.jobs[0]!;
    assert.equal(last.state, 'done');
    assert.equal(last.calls[0]!.state, 'completed');
    assert.match(last.receipt!, /evidence: plain\.txt:1/);
  } finally {await done();}
});

test('Unfinished jobs are marked interrupted on restart and never replayed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-int-'));
  try {
    const file = join(cwd, 'automa.jsonl');
    assert.equal(await markInterruptedJobs(file), 0);
    const line = (jobIndex: number, event: string) => JSON.stringify({parentActivityId: 'a', principal: 'techne', jobIndex, event}) + '\n';
    await writeFile(file, line(0, 'start') + line(1, 'start') + line(0, 'end'));
    assert.equal(await markInterruptedJobs(file), 1);
    assert.match((await readFile(file, 'utf8')).trim().split('\n').at(-1)!, /"jobIndex":1,"event":"interrupted"/);
    assert.equal(await markInterruptedJobs(file), 0);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('Report parsing keeps unlabelled text and tolerates light formatting', () => {
  assert.deepEqual(parseReport('NO_MATCHES'), {summary: 'NO_MATCHES', evidence: '', notes: ''});
  assert.deepEqual(parseReport('Preface\n**Summary:** one\ntwo\n- evidence: a.ts:1\nnotes: left'), {summary: 'Preface\none\ntwo', evidence: 'a.ts:1', notes: 'left'});
});

test('Profiles: schema validates presets and every shipped actor has its swarm', () => {
  assert.equal(automaProfileSchema.safeParse({name: 'x', default_preset: 'missing', presets: {scout: {tools: 'read'}}}).success, false);
  assert.equal(automaProfileSchema.safeParse({name: 'x', default_preset: 's', presets: {s: {tools: 'all'}}}).success, false);
  assert.equal(automaProfileSchema.safeParse({name: 'x', default_preset: 's', presets: {s: {tools: 'read', exclusive: ['npm test']}}}).success, false);
  const expected: Record<string, [string, string[]]> = {aletheia: ['drone swarm', ['scout', 'probe']], techne: ['work crew', ['scout', 'edit']], kalon: ['atelier hands', ['scout', 'variant']], logox: ['runners', ['scout']]};
  for (const actor of builtinActors) {
    const [name, presets] = expected[actor.id]!;
    assert.equal(actor.automa?.name, name);
    assert.equal(actor.automa?.default_preset, 'scout');
    assert.deepEqual(Object.keys(actor.automa!.presets), presets);
    assert.equal(actor.automa!.presets.scout!.tools, 'read');
    assert.match(actor.execution ?? '', /\*\*Automa\*\*/);
    assert.ok(actorDefinitionSchema.safeParse(actor).success);
  }
  assert.ok(Object.values(builtinActors.find(actor => actor.id === 'logox')!.automa!.presets).every(preset => preset.tools === 'read'));
});

test('An actor with no automa block falls back to a read-only default', async () => {
  const {tools, done} = await project();
  try {
    const seen: string[] = [];
    tools.setAutomaEnvironment(environment(workers({x: ['summary: ok']}), {profile: () => undefined, resolveModel: preferred => {seen.push(String(preferred)); return {provider: workers({x: ['summary: ok']}), model: 'm'};}}));
    const ok = await tools.execute(dispatch({jobs: [job('x')]}), principal());
    assert.match(ok.text, /Automa dispatch · automa · 1\/1 done/);
    assert.deepEqual(seen, ['undefined']);
    const refused = await tools.execute(dispatch({jobs: [job('x', {files: ['a.txt']})]}), principal());
    assert.match(refused.text, /no writable preset/);
  } finally {await done();}
});

test('Model priority: preset over role, passed to the resolver', async () => {
  const {tools, done} = await project();
  try {
    const seen: string[] = [];
    const profile: AutomaProfile = {name: 'p', default_preset: 'a', model: 'role-model', presets: {a: {tools: 'read'}, b: {tools: 'read', model: 'preset-model'}}};
    tools.setAutomaEnvironment(environment(workers({x: ['summary: 1', 'summary: 2']}), {profile: () => profile, resolveModel: preferred => {seen.push(String(preferred)); return {provider: workers({x: ['summary: ok']}), model: 'm'};}}));
    await tools.execute(dispatch({jobs: [job('x')]}), principal());
    await tools.execute(dispatch({preset: 'b', jobs: [job('x')]}), principal());
    assert.deepEqual(seen, ['role-model', 'preset-model']);
  } finally {await done();}
});

test('Automa animation frames and color token stay stable', () => {
  assert.deepEqual(AUTOMA_ANIMATION_FRAMES, ['◜', '◠', '◝', '◞', '◡', '◟']);
  assert.equal(AUTOMA_COLOR_TOKEN, 'automa');
});

test("The user's /model automa choice outranks presets and roles; otherwise preset names resolve or fall through", () => {
  const session = {provider: 'alpha', model: 'session-model'};
  const pool = [{provider: 'alpha', id: 'claude-haiku-4'}, {provider: 'alpha', id: 'claude-haiku-5'}, {provider: 'alpha', id: 'exact'}, {provider: 'beta', id: 'fast'}];
  const expand = (name: string) => {
    if (name === 'ambiguous') throw new Error('Ambiguous');
    const slash = name.indexOf('/');
    return slash > 0 ? {provider: name.slice(0, slash), model: name.slice(slash + 1)} : {provider: 'alpha', model: name};
  };
  const choose = (preferred: string | undefined, dedicated?: {provider: string; model: string}) => chooseAutomaModel({dedicated, preferred, session, pool, expand});
  const mine = {provider: 'beta', model: 'mine-not-in-pool'};
  assert.deepEqual(choose('haiku', mine), mine);
  assert.deepEqual(choose('exact', mine), mine);
  assert.deepEqual(choose(undefined, mine), mine);
  assert.deepEqual(choose('exact'), {provider: 'alpha', model: 'exact'});
  assert.deepEqual(choose('beta/fast'), {provider: 'beta', model: 'fast'});
  assert.deepEqual(choose('haiku'), {provider: 'alpha', model: 'claude-haiku-5'});
  assert.deepEqual(choose('sonnet'), session);
  assert.deepEqual(choose('ambiguous'), session);
  assert.deepEqual(choose(undefined), session);
});
