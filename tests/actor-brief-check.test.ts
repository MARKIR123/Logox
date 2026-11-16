import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {DeliveryQueue} from '../src/actors/delivery-queue.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {Tools} from '../src/tools/index.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {actorSchema} from '../src/tools/orchestration/ActorTool/ActorTool.js';
import {ACTOR_DESCRIPTION, BRIEF_CHECK_SYSTEM_PROMPT} from '../src/tools/orchestration/ActorTool/prompt.js';
import {briefCheckNeeded, renderBriefCheckInput, type BriefCheckInput, type BriefCheckOutcome} from '../src/tools/orchestration/ActorTool/brief-check.js';
import type {AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const call = (input: Record<string, unknown>) => ({id: 'assign', name: 'Actor', arguments: JSON.stringify(input)});
const short = (ownerId: string, extra: Record<string, unknown> = {}) => ({ownerId, title: 'Task for ' + ownerId, prompt: 'Do the ' + ownerId + ' part.', ...extra});

async function fixture(checker: ((input: BriefCheckInput, context: ActorContext) => Promise<BriefCheckOutcome>) | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-brief-check-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore(), deliveries = new DeliveryQueue('s', journal);
  let services!: ActorServices;
  let run: (context: ActorContext) => Promise<void> = async () => {};
  const ensemble = new DynamicEnsemble('s', store, journal, async (prompt, context) => {
    services.definition(context);
    if (prompt === 'start') await run(context); else context.say('done');
  }, {concurrency: 'actor', deliveries, member: owner => catalog.find(owner), handoff: result => services.handoff(result),
    settled: (activity, status) => services.settled(activity, status)});
  services = new ActorServices({sessionId: 's', catalog, config, journal, deliveries, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), getSnapshot: () => store.getSnapshot(),
    getActiveTask: owner => ensemble.getActiveTask(owner), canReceiveMessage: owner => ensemble.canReceiveMessage(owner),
    requireIdle() {}, approve: async () => false, enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: id => ensemble.pauseBatch(id), resumeBatch: id => ensemble.resumeBatch(id), coordinationPath: join(directory, 'coordination.json')});
  if (checker) services.setBriefCheck(checker);
  await services.recover();
  /** Runs one Director turn that makes the given Actor call and returns the call's result. */
  const dispatch = async (input: Record<string, unknown>) => {
    let result: Awaited<ReturnType<ActorServices['execute']>> | undefined;
    run = async context => {result = await services.execute(call(input), context);};
    await ensemble.dispatch('logox', 'start', 'logox', {inputKind: 'human'}).done;
    return result!;
  };
  const started = () => store.activities.list().filter(activity => activity.ownerId !== 'logox').map(activity => activity.ownerId).sort();
  return {dispatch, started, async close() {await ensemble.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}};
}

test('the check runs for two or more new tasks or one prompt over 1500 characters, never for resumeTask', () => {
  const task = (prompt = 'short', extra: Record<string, unknown> = {}) => ({prompt, ...extra});
  assert.equal(briefCheckNeeded([task()]), false, 'one short task');
  assert.equal(briefCheckNeeded([task(), task()]), true, 'two tasks');
  assert.equal(briefCheckNeeded([task('x'.repeat(1500))]), false, '1500 characters is not longer than 1500');
  assert.equal(briefCheckNeeded([task('x'.repeat(1501))]), true, 'one long prompt');
  assert.equal(briefCheckNeeded([task('x'.repeat(5000), {resumeTask: 'a1'})]), false, 'a resumed task');
  assert.equal(briefCheckNeeded([task('short', {resumeTask: 'a1'}), task('short', {resumeTask: 'a2'})]), false, 'two resumed tasks');
  assert.equal(briefCheckNeeded([task('short', {resumeTask: 'a1'}), task()]), false, 'only one of them is new');
  assert.equal(briefCheckNeeded([]), false);
});

test('briefCheck accepts only "skip", and the parameter is described on itself, not in the main description', () => {
  assert.ok(actorSchema.safeParse({tasks: [short('techne')], briefCheck: 'skip'}).success);
  assert.ok(!actorSchema.safeParse({tasks: [short('techne')], briefCheck: 'run'}).success);
  assert.doesNotMatch(ACTOR_DESCRIPTION, /briefCheck/);
  const schema = JSON.stringify(actorSchema.toJSONSchema());
  assert.match(schema, /"briefCheck":\{[^}]*"description":"Set to \\"skip\\"/);
});

test('the check input carries every field of every task and the companions', () => {
  const text = renderBriefCheckInput({companions: ['Techne', 'Kalon'], tasks: [
    {ownerId: 'techne', title: 'Build', prompt: 'Build it.', owns: ['src/a.ts'], acceptance: ['it builds'], after: []},
    {ownerId: 'kalon', title: 'Style', prompt: 'Style it.', owns: [], acceptance: [], after: ['techne']}]});
  for (const part of ['Techne, Kalon', 'Task 1: Build', 'Build it.', '- src/a.ts', '- it builds', 'Task 2: Style', 'Style it.', '- techne']) assert.ok(text.includes(part), part);
});

test('one short task starts at once and nothing is checked', {timeout: 10000}, async () => {
  const seen: BriefCheckInput[] = [];
  const f = await fixture(async input => {seen.push(input); return {status: 'clear'};});
  try {
    const result = await f.dispatch({tasks: [short('techne')]});
    assert.equal(seen.length, 0);
    assert.doesNotMatch(result.text, /Brief check/);
    assert.deepEqual(f.started(), ['techne']);
  } finally {await f.close();}
});

test('two tasks are checked once with all fields; clear dispatches them and the receipt says so', {timeout: 10000}, async () => {
  const seen: BriefCheckInput[] = [];
  const f = await fixture(async input => {seen.push(input); return {status: 'clear'};});
  try {
    const result = await f.dispatch({tasks: [short('techne', {owns: ['src/a.ts'], acceptance: ['it builds']}), short('kalon', {after: ['techne']})]});
    assert.equal(result.isError, false);
    assert.equal(seen.length, 1);
    assert.deepEqual([...seen[0]!.companions].sort(), ['Kalon', 'Techne']);
    const techne = seen[0]!.tasks.find(task => task.ownerId === 'techne')!;
    assert.deepEqual([techne.title, techne.prompt, techne.owns, techne.acceptance, techne.after], ['Task for techne', 'Do the techne part.', ['src/a.ts'], ['it builds'], []]);
    assert.deepEqual(seen[0]!.tasks.find(task => task.ownerId === 'kalon')!.after, ['techne']);
    assert.match(result.text, /^Brief check: clear\.$/m);
    assert.deepEqual(f.started(), ['kalon', 'techne']);
  } finally {await f.close();}
});

test('one prompt over 1500 characters is checked', {timeout: 10000}, async () => {
  let calls = 0;
  const f = await fixture(async () => {calls++; return {status: 'clear'};});
  try {
    const result = await f.dispatch({tasks: [short('techne', {prompt: 'x'.repeat(1501)})]});
    assert.equal(calls, 1);
    assert.match(result.text, /^Brief check: clear\.$/m);
  } finally {await f.close();}
});

test('blocked: nothing starts and the result (not an error) is the fixed text followed by the numbered gaps', {timeout: 10000}, async () => {
  const gaps = '1. Task "Build": the file format "the spec" is never defined.\n2. Tasks "Build" and "Style" both expect the other to create src/theme.ts.';
  const f = await fixture(async () => ({status: 'blocked', gaps}));
  try {
    const result = await f.dispatch({tasks: [short('techne'), short('kalon')]});
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Brief check found gaps; nothing was dispatched. Fix the briefs and call Actor again, or add "briefCheck": "skip" to dispatch them as they are.\n' + gaps);
    assert.deepEqual(f.started(), []);
  } finally {await f.close();}
});

test('briefCheck "skip" runs no check, says so, and dispatches', {timeout: 10000}, async () => {
  let calls = 0;
  const f = await fixture(async () => {calls++; return {status: 'blocked', gaps: '1. x'};});
  try {
    const result = await f.dispatch({tasks: [short('techne'), short('kalon')], briefCheck: 'skip'});
    assert.equal(calls, 0);
    assert.match(result.text, /^Brief check: skipped\.$/m);
    assert.deepEqual(f.started(), ['kalon', 'techne']);
  } finally {await f.close();}
});

test('a failed check never blocks: a failed outcome or a throw dispatches with the failure line', {timeout: 10000}, async () => {
  for (const checker of [async (): Promise<BriefCheckOutcome> => ({status: 'failed', reason: 'provider unavailable'}), async (): Promise<BriefCheckOutcome> => {throw new Error('boom');}]) {
    const f = await fixture(checker);
    try {
      const result = await f.dispatch({tasks: [short('techne'), short('kalon')]});
      assert.equal(result.isError, false);
      assert.match(result.text, /^Brief check: failed \((?:provider unavailable|boom)\); dispatched without it\.$/m);
      assert.deepEqual(f.started(), ['kalon', 'techne']);
    } finally {await f.close();}
  }
});

test('without a checker (minimal setups) nothing is checked and no line is added', {timeout: 10000}, async () => {
  const f = await fixture(undefined);
  try {
    const result = await f.dispatch({tasks: [short('techne'), short('kalon')]});
    assert.doesNotMatch(result.text, /Brief check/);
    assert.deepEqual(f.started(), ['kalon', 'techne']);
  } finally {await f.close();}
});

/** The Tools side: a real read-only worker run against a scripted provider. */
async function checkRun(script: (request: {system: string; tools: readonly string[]; messages: readonly ModelMessage[]}, turn: number) => {name: string; args: unknown}) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-brief-check-'));
  await writeFile(join(cwd, 'spec.md'), 'The spec.\n');
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
  const requests: {system: string; tools: readonly string[]; messages: readonly ModelMessage[]}[] = [];
  const provider: AutomaProvider = {async respond(request) {
    const shown = {system: request.system, tools: request.tools.map(tool => tool.name), messages: [...request.messages]};
    requests.push(shown);
    const step = script(shown, requests.length - 1);
    return {message: {role: 'assistant', text: '', toolCalls: [{id: 'call_' + requests.length, name: step.name, arguments: JSON.stringify(step.args)}]}, stop: 'tools', usage: {input: 7, output: 3}};
  }};
  const asked: (boolean | undefined)[] = [], charged: [string, string][] = [];
  tools.setAutomaEnvironment({retries: () => 0, resolveModel: (_preferred, _vision, writes) => {asked.push(writes); return {provider, model: 'mock/' + (writes ? 'code' : 'read'), route: writes ? 'code' : 'read'};},
    charge: (context, _usage, model) => {charged.push([context.ownerId, model]);}});
  const context: ActorContext = {sessionId: 's', activityId: 'act', ownerId: 'logox', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}};
  const input: BriefCheckInput = {companions: ['Techne'], tasks: [{ownerId: 'techne', title: 'Build', prompt: 'Build it per spec.md.', owns: [], acceptance: [], after: []}]};
  return {cwd, tools, requests, asked, charged, context, input, async done() {await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}};
}

test('the check worker is read-only on the code model: it offers Read, Glob and Grep, refuses a Write call, and charges the dispatcher', {timeout: 10000}, async () => {
  const f = await checkRun((_request, turn) => turn === 0 ? {name: 'Write', args: {file_path: 'spec.md', content: 'overwritten'}}
    : turn === 1 ? {name: 'Read', args: {file_path: 'spec.md'}}
    : {name: 'Finish', args: {status: 'done', summary: 'Techne builds it per spec.md.'}});
  try {
    const outcome = await f.tools.runBriefCheck(f.input, f.context);
    assert.deepEqual(outcome, {status: 'clear'});
    assert.deepEqual(f.requests[0]!.tools, ['Read', 'Glob', 'Grep', 'Finish']);
    assert.equal(f.requests[0]!.system, BRIEF_CHECK_SYSTEM_PROMPT);
    assert.match(String(f.requests[0]!.messages[0]!.text), /Build it per spec\.md\./);
    assert.deepEqual([...new Set(f.asked)], [true], 'the code model is asked for');
    const refused = f.requests[1]!.messages.flatMap(message => message.role === 'tool' ? [message] : [])[0]!;
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Tool `Write` is not available to a worker\. Available: Read, Glob, Grep\./);
    assert.equal(await readFile(join(f.cwd, 'spec.md'), 'utf8'), 'The spec.\n', 'nothing was written');
    assert.ok(f.charged.length >= 3 && f.charged.every(entry => entry[0] === 'logox' && entry[1] === 'mock/code'), 'usage is charged to the dispatcher on the code model');
  } finally {await f.done();}
});

test('the check worker reports gaps through Finish blocked, and a failed worker is a failed outcome that never throws', {timeout: 10000}, async () => {
  const blocked = await checkRun(() => ({name: 'Finish', args: {status: 'blocked', summary: 'gaps', question: '1. Task "Build": "the format" is undefined.'}}));
  try {
    assert.deepEqual(await blocked.tools.runBriefCheck(blocked.input, blocked.context), {status: 'blocked', gaps: '1. Task "Build": "the format" is undefined.'});
  } finally {await blocked.done();}
  const failed = await checkRun(() => ({name: 'Finish', args: {status: 'failed', summary: 'could not read the repository'}}));
  try {
    assert.deepEqual(await failed.tools.runBriefCheck(failed.input, failed.context), {status: 'failed', reason: 'could not read the repository'});
  } finally {await failed.done();}
  const crashed = await checkRun(() => {throw new Error('provider exploded');});
  try {
    const outcome = await crashed.tools.runBriefCheck(crashed.input, crashed.context);
    assert.equal(outcome.status, 'failed');
  } finally {await crashed.done();}
});
