import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {getScratchpadDir} from '../src/kernel/scratchpad.js';
import {AUTOMA_DESCRIPTION, FORK_DIRECTIVE, FORK_NOT_HERE, FORK_NO_CONTEXT, FORK_REFUSAL, FORK_RESULT_TEXT, FORK_SIBLING_RESULT_TEXT} from '../src/tools/orchestration/AutomaTool/prompt.js';
import {forkBase, type ParentTurn} from '../src/tools/orchestration/AutomaTool/fork.js';
import {automaSchema, normalizeAutomaInput} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import type {ModelMessage, ModelRequest, ModelTurn, ProviderCapabilities, ToolDefinition} from '../src/runtime/messages.js';
import {automaConfigSchema} from '../src/config/config.js';
import {usageRecordSchema} from '../src/context/budget.js';
import {sessionUsageRows} from '../src/context/usage.js';
import {loadConfig} from '../src/config/config.js';
import {rowText} from '../src/commands/tab-rows.js';
import {projectDelegations} from '../src/runtime/delegations.js';
import {statusText} from '../src/commands/tasks-page.js';
import {derivePlan, type Plan} from '../src/runtime/plan.js';
import {buildFlow} from '../src/tui/panels/plan-flow.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

const profile: AutomaProfile = {name: 'work crew', default_style: 'scout', write_style: 'edit', exclusive: [], styles: {scout: {flavor: 'Scout.'}, edit: {flavor: 'Edit.'}}};
const parkedRoot = join(tmpdir(), 'logox-automa-fork-tests-' + process.pid);
let environments = 0;
after(() => rm(parkedRoot, {recursive: true, force: true}));

function principal(overrides: Partial<ActorContext> = {}): ActorContext {
  return {sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal, report() {}, say() {}, async record() {},
    async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}, ...overrides};
}
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-fork-'));
  await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n');
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
  return {cwd, tools, done: async () => {await rm(getScratchpadDir(cwd, 's'), {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}};
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const limit = Date.now() + ms;
  while (!check()) {if (Date.now() > limit) throw new Error('Timed out waiting for ' + what); await sleep(10);}
}

/** A worker provider the forks must never use: a fork runs on its dispatcher's own provider. */
const forbidden = {async respond(): Promise<ModelTurn> {throw new Error('A fork must not use the worker model');}};
function environment(overrides: Partial<AutomaEnvironment> = {}): AutomaEnvironment {
  const id = String(++environments);
  return {resolveModel: () => ({provider: forbidden, model: 'mock/worker'}), profile: () => profile, workerDir: sessionId => join(parkedRoot, id, sessionId), ...overrides};
}
const job = (brief: string, extra: Record<string, unknown> = {}) => ({title: brief, brief, scope: 'bounded', ...extra});
const dispatch = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});

const parentTools: ToolDefinition[] = ['Read', 'Edit', 'Write', 'Shell', 'Actor', 'Automa', 'SendMessage', 'Plan'].map(name => ({name, description: name + ' tool', parameters: {type: 'object', properties: {x: {type: 'string'}}}}));
const parentMessages: ModelMessage[] = [{role: 'user', text: 'Rework the parser and its tests.'}, {role: 'assistant', text: 'Reading first.', toolCalls: [{id: 'r1', name: 'Read', arguments: '{"file_path":"a.txt"}'}]},
  {role: 'tool', callId: 'r1', name: 'Read', text: 'one\ntwo\n', isError: false}];
const turn = (text: string, toolCalls: {id: string; name: string; arguments: string}[], usage?: ModelTurn['usage']): ModelTurn =>
  ({message: {role: 'assistant', text, ...(toolCalls.length ? {toolCalls} : {})}, stop: toolCalls.length ? 'tools' : 'complete', ...(usage ? {usage} : {})});
const finish = (summary = 'fork done', usage?: ModelTurn['usage'], id = 'fin'): ModelTurn => turn('', [{id, name: 'Finish', arguments: JSON.stringify({status: 'done', summary, evidence: ['a.txt:1']})}], usage);

type Script = (request: ModelRequest, index: number) => ModelTurn | Promise<ModelTurn>;
/** The dispatcher's own provider: records every request, answers by script. */
function recording(script: Script, capabilities?: ProviderCapabilities) {
  const requests: ModelRequest[] = [];
  const provider = {...(capabilities ? {capabilities} : {}), async respond(request: ModelRequest): Promise<ModelTurn> {
    requests.push(structuredClone(request));
    return script(request, requests.length - 1);
  }};
  return {requests, provider};
}
function parentTurn(provider: ParentTurn['provider'], args: unknown, overrides: {tools?: ToolDefinition[]; model?: string} = {}): ParentTurn {
  const request: ModelRequest = {system: 'You are Techne. Work carefully.', messages: parentMessages, tools: overrides.tools ?? parentTools, cacheKey: 'logox-cache-key',
    cacheRetention: {role: 'long'}, supportsVision: true, dumpDir: '/diagnostic', fingerprint: {file: '/f', ownerId: 'techne', purpose: 'task'}};
  return {request, provider, model: overrides.model ?? 'mock/model', message: {role: 'assistant', text: 'Splitting the work.', reasoning: 'thinking it through',
    toolCalls: [{id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)}]}};
}
const cachingCaps: ProviderCapabilities = {toolDiscovery: 'none', runtimeInstructions: 'meta-user', caching: 'anthropic'};
const plainCaps: ProviderCapabilities = {toolDiscovery: 'none', runtimeInstructions: 'meta-user', caching: 'none'};
const opening = (request: ModelRequest) => request.messages.at(-1)!.text;
const resultText = (result: {text: string}) => result.text;

test('Fork: the first request is the parent request, its assistant turn, the fixed result and the directive', async () => {
  const {tools, done} = await project();
  try {
    const {requests, provider} = recording(() => finish());
    const args = {jobs: [job('Alpha part', {fork: true, writes: ['a.txt'], acceptance: ['a.txt is right']})]};
    const parent = parentTurn(provider, args);
    tools.setAutomaEnvironment(environment());
    const result = await tools.execute(dispatch(args), principal({parentTurn: parent}));
    assert.equal(result.isError, false, resultText(result));
    assert.equal(requests.length, 1);
    const first = requests[0]!, sent = parent.request;
    assert.deepEqual(first.system, sent.system);
    assert.deepEqual(first.tools, sent.tools, 'the same definitions in the same order, Finish not added');
    assert.ok(!first.tools.some(tool => tool.name === 'Finish'));
    assert.deepEqual([first.cacheKey, first.cacheRetention, first.supportsVision], [sent.cacheKey, sent.cacheRetention, sent.supportsVision]);
    assert.equal(first.dumpDir, undefined, 'diagnostic labels of the parent turn are left out');
    assert.equal(first.fingerprint, undefined);
    const prefix = first.messages.slice(0, sent.messages.length);
    assert.deepEqual(prefix, sent.messages, 'the parent messages, untouched');
    assert.deepEqual(first.messages.slice(sent.messages.length, -1), [parent.message,
      {role: 'tool', callId: 'dispatch', name: 'Automa', text: 'Forked. Your part follows.', isError: false}]);
    assert.equal(FORK_RESULT_TEXT, 'Forked. Your part follows.');
    const directive = opening(first);
    assert.equal(first.messages.at(-1)!.role, 'user');
    assert.ok(directive.startsWith(`You are a fork of yourself, running one part of the work in parallel while your original continues. You know everything your original knew up to this point. Do only the part below; leave everything else to your original.
- You cannot dispatch, fork, message teammates or change the plan; those calls are refused. Work with the files and commands you need for your part.
- End by calling Finish exactly once with what you did and the evidence. Your original reads only that.

Title: Alpha part

Alpha part

Scope: bounded: use judgment inside the stated goal.

Acceptance:
- a.txt is right

Grant:
- read: anything your dispatcher can read
- write: a.txt
`), directive);
    assert.match(directive, /- scratchpad: .*\n- commands: allowed, judged by your dispatcher's permission rules$/);
    assert.match(result.text, /<automa-result id="T1" kind="fork" title="Alpha part" status="done" took="\d+:\d\d" model="mock\/model">/);
  } finally {await done();}
});

test('Fork: forks of one dispatch share the identical prefix up to the directive; only the directive differs', async () => {
  const {tools, done} = await project();
  try {
    const {requests, provider} = recording(async () => {await sleep(20); return finish();});
    const args = {jobs: [job('First part', {fork: true}), job('Second part', {fork: true}), job('Third part', {fork: true, writes: ['a.txt']})]};
    const parent = parentTurn(provider, args);
    tools.setAutomaEnvironment(environment());
    const result = await tools.execute(dispatch(args), principal({parentTurn: parent}));
    assert.match(result.text, /3\/3 done/);
    assert.equal(requests.length, 3);
    const stable = requests.map(request => JSON.stringify([request.system, request.tools, request.messages.slice(0, -1), request.cacheKey, request.cacheRetention]));
    assert.equal(new Set(stable).size, 1, 'system, tools, messages and cache fields are the same for every fork');
    assert.equal(new Set(requests.map(opening)).size, 3);
    assert.deepEqual(requests.map(request => /\nTitle: (.*)\n/.exec(opening(request))![1]!).sort(), ['First part', 'Second part', 'Third part']);
    // A pure function of the turn: the same bytes every time.
    assert.deepEqual(forkBase(parent, 'dispatch').prefix, forkBase(parent, 'dispatch').prefix);
  } finally {await done();}
});

test('Fork: another call of the same assistant message stays paired with a fixed result', async () => {
  const {tools, done} = await project();
  try {
    const {requests, provider} = recording(() => finish());
    const args = {jobs: [job('Part', {fork: true})]};
    const parent = parentTurn(provider, args);
    const withSibling: ParentTurn = {...parent, message: {...parent.message, toolCalls: [{id: 'other', name: 'Read', arguments: '{}'}, ...parent.message.toolCalls!]}};
    tools.setAutomaEnvironment(environment());
    await tools.execute(dispatch(args), principal({parentTurn: withSibling}));
    const tail = requests[0]!.messages.slice(parentMessages.length, -1);
    assert.deepEqual(tail.slice(1).map(message => message.role === 'tool' ? [message.callId, message.text] : message.role),
      [['other', FORK_SIBLING_RESULT_TEXT], ['dispatch', FORK_RESULT_TEXT]]);
  } finally {await done();}
});

test('Fork: orchestration tools are refused at execution with the fixed text; the list sent never changes', async () => {
  const {tools, done} = await project();
  try {
    const names = ['Actor', 'Automa', 'SendMessage', 'Plan', 'CraftActor', 'CancelActor', 'AskUserQuestion', 'ReadActor'];
    const {requests, provider} = recording((_request, index) => index === 0
      ? turn('', [...names.map(name => ({id: 'c-' + name, name, arguments: name === 'Automa' ? '{"jobs":[{"brief":"x","scope":"exact","fork":true}]}' : '{}'})),
        {id: 'ok', name: 'Read', arguments: JSON.stringify({file_path: 'a.txt'})}])
      : finish());
    const args = {jobs: [job('Refuse', {fork: true})]};
    tools.setAutomaEnvironment(environment());
    const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args)}));
    assert.match(result.text, /1\/1 done/, result.text);
    const answers = requests[1]!.messages.filter(message => message.role === 'tool' && message.callId.startsWith('c-')) as Extract<ModelMessage, {role: 'tool'}>[];
    assert.equal(answers.length, names.length);
    for (const answer of answers) assert.deepEqual([answer.text, answer.isError], ['Forks cannot dispatch, fork, message teammates or change the plan. Do your part with your other tools.', true], answer.name);
    assert.equal(FORK_REFUSAL, answers[0]!.text);
    assert.deepEqual(requests[1]!.tools, requests[0]!.tools);
  } finally {await done();}
});

test('Fork: a tool the fork cannot run is answered, not thrown, and a read tool still works', async () => {
  const {tools, done} = await project();
  try {
    const {requests, provider} = recording((_request, index) => index === 0
      ? turn('', [{id: 'm', name: 'mcp__server__search', arguments: '{}'}, {id: 'r', name: 'Read', arguments: JSON.stringify({file_path: 'a.txt'})}]) : finish());
    const args = {jobs: [job('Mixed', {fork: true})]};
    tools.setAutomaEnvironment(environment());
    const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args)}));
    assert.match(result.text, /1\/1 done/, result.text);
    const tail = requests[1]!.messages.filter(message => message.role === 'tool') as Extract<ModelMessage, {role: 'tool'}>[];
    assert.match(tail.find(message => message.callId === 'm')!.text, /^Tool `mcp__server__search` is not available to a fork\. Available: Read, Glob/);
    assert.match(tail.find(message => message.callId === 'r')!.text, /one/);
  } finally {await done();}
});

test('Fork: Finish is accepted when the dispatcher\'s list does not declare it; a list that declares it works the same', async () => {
  const {tools, done} = await project();
  try {
    for (const declared of [false, true]) {
      const finishTool: ToolDefinition = {name: 'Finish', description: 'f', parameters: {type: 'object'}};
      const {requests, provider} = recording(() => finish('summary ' + declared));
      const args = {jobs: [job('Close ' + declared, {fork: true})]};
      const parent = parentTurn(provider, args, {tools: declared ? [...parentTools, finishTool] : parentTools});
      tools.setAutomaEnvironment(environment());
      const result = await tools.execute(dispatch(args), principal({parentTurn: parent, activityId: 'act-' + declared}));
      assert.match(result.text, new RegExp(`status="done"[^\\n]*\\nSummary: summary ${declared}`), result.text);
      assert.equal(requests[0]!.tools.some(tool => tool.name === 'Finish'), declared);
    }
  } finally {await done();}
});

test('Fork: a fork that cannot call the undeclared Finish ends with a plain reply, its text as the summary and a note', async () => {
  const {tools, done} = await project();
  try {
    const {requests, provider} = recording(() => turn('I changed a.txt line 1.', []));
    const args = {jobs: [job('Plain', {fork: true})]};
    tools.setAutomaEnvironment(environment());
    const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args)}));
    assert.equal(requests.length, 1, 'no reminder rounds');
    assert.match(result.text, /status="done"/);
    assert.match(result.text, /Summary: I changed a\.txt line 1\./);
    assert.match(result.text, /Note: this fork ended with a plain reply instead of Finish; its last text is the summary\./);
    // Where Finish is declared, a plain reply is only a reminder, as for a worker.
    const declared = recording((_request, index) => index === 0 ? turn('thinking aloud', []) : finish('after the reminder'));
    const again = {jobs: [job('Declared', {fork: true})]};
    const parent = parentTurn(declared.provider, again, {tools: [...parentTools, {name: 'Finish', description: 'f', parameters: {type: 'object'}}]});
    const second = await tools.execute(dispatch(again), principal({parentTurn: parent, activityId: 'act2'}));
    assert.equal(declared.requests.length, 2);
    assert.match(second.text, /Summary: after the reminder/);
    assert.doesNotMatch(second.text, /plain reply/);
  } finally {await done();}
});

test('Fork: not inside a worker or a fork, and not without the request behind the call', async () => {
  const {tools, done} = await project();
  try {
    tools.setAutomaEnvironment(environment());
    const args = {jobs: [job('Nested', {fork: true})]};
    const grant = {writes: [], exclusive: []};
    const inWorker = await tools.execute(dispatch(args), principal({via: {label: 'Techne\'s crew', workerId: 'w', grant}}));
    assert.deepEqual([inWorker.isError, inWorker.text], [true, FORK_NOT_HERE]);
    assert.match(FORK_NOT_HERE, /Fix:/);
    const inFork = await tools.execute(dispatch(args), principal({via: {label: 'Techne\'s fork', workerId: 'f', grant, fork: true}}));
    assert.deepEqual([inFork.isError, inFork.text], [true, FORK_REFUSAL]);
    const bare = await tools.execute(dispatch(args), principal());
    assert.deepEqual([bare.isError, bare.text], [true, FORK_NO_CONTEXT]);
    // Continuing a fork needs no new request; continuing a worker as a fork is refused with the fix.
    const {provider} = recording(() => finish());
    const first = {jobs: [job('Worker job')]};
    tools.setAutomaEnvironment(environment({resolveModel: () => ({provider: {async respond() {return finish('worker');}}, model: 'mock/worker'})}));
    await tools.execute(dispatch(first), principal({activityId: 'act3'}));
    const wrong = await tools.execute(dispatch({jobs: [job('Again', {continue: 'T1', fork: true})]}), principal({activityId: 'act3', parentTurn: parentTurn(provider, {})}));
    assert.deepEqual(wrong.isError, true);
    assert.match(wrong.text, /Worker T1 is a worker, not a fork\. Fix: omit `fork` to continue it/);
  } finally {await done();}
});

test('Fork: max_forks_running holds the extra forks back; they queue and all finish', async () => {
  const {tools, done} = await project();
  try {
    let running = 0, peak = 0;
    const {provider} = recording(async () => {running++; peak = Math.max(peak, running); await sleep(40); running--; return finish();});
    const args = {jobs: [job('F1', {fork: true}), job('F2', {fork: true}), job('F3', {fork: true}), job('F4', {fork: true}), job('Worker')]};
    const swarms: AutomaSwarm[] = [];
    tools.setAutomaEnvironment(environment({maxForks: () => 2, resolveModel: () => ({provider: {async respond() {return finish('worker');}}, model: 'mock/worker'})}));
    const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args), reportSwarm: swarm => swarms.push(structuredClone(swarm))}));
    assert.match(result.text, /5\/5 done/, result.text);
    assert.equal(peak, 2, 'at most two forks at once');
    assert.match(result.text, /Queued 2 of 4 forks: you run at most 2 forks at once\./);
    assert.deepEqual(swarms.at(-1)!.jobs.map(item => item.kind), ['fork', 'fork', 'fork', 'fork', undefined]);
    assert.ok(swarms.some(item => item.jobs.filter(entry => entry.kind === 'fork' && entry.state === 'running').length === 2));
    // The default is three.
    assert.equal(automaConfigSchema.parse({}).max_forks_running, 3);
    assert.equal(automaConfigSchema.safeParse({max_forks_running: 0}).success, false);
    assert.equal(automaConfigSchema.safeParse({max_forks_running: 9}).success, false);
    assert.equal(automaConfigSchema.safeParse({max_forks_running: 8}).success, true);
  } finally {await done();}
});

test('Fork: the result reports the cache share of the first response, and says when the prefix was not served from cache', async () => {
  const {tools, done} = await project();
  try {
    for (const [cacheRead, expected] of [[940, 94], [100, 10]] as const) {
      const {provider} = recording(() => finish('ok', {input: 1000, output: 5, cacheRead}), cachingCaps);
      const args = {jobs: [job('Cache ' + cacheRead, {fork: true})]};
      tools.setAutomaEnvironment(environment());
      const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args), activityId: 'act-' + cacheRead}));
      assert.match(result.text, new RegExp(`model="mock/model" cache="${expected}%">`), result.text);
      const note = `Note: this fork's prefix was not served from cache (${expected}%); a fresh worker with a short brief is cheaper.`;
      assert.equal(result.text.includes(note), expected < 50, result.text);
    }
  } finally {await done();}
});

test('Fork: a provider without prefix caching is said once in the receipt, and its forks carry no cache share', async () => {
  const {tools, done} = await project();
  try {
    const {provider} = recording(() => finish('ok', {input: 1000, output: 5, cacheRead: 0}), plainCaps);
    const args = {jobs: [job('A', {fork: true}), job('B', {fork: true})]};
    tools.setAutomaEnvironment(environment());
    const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args)}));
    const line = 'Forks on mock are not cached; each costs a full read of your context. Prefer workers with a brief.';
    assert.equal(result.text.split(line).length - 1, 1, 'once');
    assert.doesNotMatch(result.text, /cache="/);
    assert.doesNotMatch(result.text, /not served from cache/);
    assert.match(result.text, /2\/2 done/, 'still allowed');
    // In the background receipt too.
    const delivered: string[] = [];
    tools.setAutomaEnvironment(environment({deliver: async (_target, text) => {delivered.push(text); return true;}, coalesceMs: () => 20}));
    const receipt = await tools.execute(dispatch({mode: 'background', jobs: [job('C', {fork: true})]}), principal({parentTurn: parentTurn(provider, args), activityId: 'act-bg'}));
    assert.ok(receipt.text.includes(line), receipt.text);
    await until(() => delivered.length > 0, 8000, 'delivery');
  } finally {await done();}
});

test('Fork: usage is charged under the dispatcher with the category fork; a worker keeps its own', async () => {
  const {tools, done} = await project();
  try {
    const charges: {model: string; category: string | undefined}[] = [];
    tools.setAutomaEnvironment(environment({charge: (_context, _usage, model, category) => {charges.push({model, category});},
      resolveModel: () => ({provider: {async respond() {return finish('worker', {input: 10, output: 1});}}, model: 'mock/worker'})}));
    const {provider} = recording(() => finish('fork', {input: 100, output: 2}));
    const args = {jobs: [job('Forked', {fork: true}), job('Plain')]};
    await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args)}));
    assert.deepEqual(charges.sort((a, b) => a.model.localeCompare(b.model)), [{model: 'mock/model', category: 'fork'}, {model: 'mock/worker', category: undefined}]);
    const record = {id: 'r', model: 'mock/model', category: 'fork', input: 100, output: 2, cacheRead: 90, cacheWrite: 0};
    assert.equal(usageRecordSchema.safeParse(record).success, true);
    const config = await loadConfig(process.cwd(), {}, {}, process.cwd(), process.cwd());
    const rows = sessionUsageRows({owners: [{id: 'techne', name: 'Techne', records: [{...record, category: 'task'} as never, record as never]}], config, now: Date.now()}).map(rowText).join('\n');
    assert.match(rows, /Forks/);
    assert.match(rows, /Forked by Techne: .*100 in \/ 2 out · cache hit 90%/);
    assert.match(rows, /Fork: .*100 in \/ 2 out/, 'by category');
  } finally {await done();}
});

test('Fork: after, a plan node and the swarm kind work as they do for workers', async () => {
  const {tools, done} = await project();
  try {
    const linked: [string, string][] = [];
    const swarms: AutomaSwarm[] = [];
    const {requests, provider} = recording(request => finish('result of ' + /\nTitle: (.*)\n/.exec(opening(request))![1]));
    const args = {jobs: [job('Base', {fork: true, node: '1.1'}), job('Next', {fork: true, after: ['T1']})]};
    tools.setAutomaEnvironment(environment({plans: {check: () => undefined, link: (node, link) => {linked.push([node, link.automaJob]);}}}));
    const result = await tools.execute(dispatch(args), principal({parentTurn: parentTurn(provider, args), reportSwarm: swarm => swarms.push(structuredClone(swarm))}));
    assert.match(result.text, /2\/2 done/, result.text);
    assert.deepEqual(linked, [['1.1', 'act/T1']]);
    const next = requests.find(request => opening(request).includes('Title: Next'))!;
    assert.match(opening(next), /Results of the jobs this one follows:\n<automa-result id="T1" kind="fork" title="Base"/);
    assert.equal(requests.findIndex(request => opening(request).includes('Title: Base')), 0, 'the prerequisite ran first');
    assert.deepEqual(swarms[0]!.jobs.map(item => [item.kind, item.node, item.after]), [['fork', '1.1', undefined], ['fork', undefined, ['T1']]]);
  } finally {await done();}
});

test('Fork: a finished fork is continued from its own history, behind the same request prefix', async () => {
  const {tools, done} = await project();
  try {
    const {requests, provider} = recording((_request, index) => finish('step ' + (index + 1)));
    const args = {jobs: [job('Long part', {fork: true})]};
    const parent = parentTurn(provider, args);
    tools.setAutomaEnvironment(environment());
    const first = await tools.execute(dispatch(args), principal({parentTurn: parent}));
    assert.match(first.text, /id="T1" kind="fork"/);
    // The next call of the dispatcher carries no `fork` and no request of its own: the fork keeps its first one.
    const second = await tools.execute(dispatch({jobs: [job('Now the tests', {continue: 'T1', scope: 'exact'})]}), principal());
    assert.match(second.text, /<automa-result id="T1" kind="fork" title="Now the tests" status="done"/, second.text);
    assert.equal(requests.length, 2);
    const [one, two] = requests as [ModelRequest, ModelRequest];
    assert.deepEqual(two.messages.slice(0, one.messages.length), one.messages, 'the first request is a prefix of the second');
    assert.deepEqual([two.system, two.tools, two.cacheKey], [one.system, one.tools, one.cacheKey]);
    assert.equal(two.messages.at(-1)!.text.startsWith('Now the tests'), true);
    assert.doesNotMatch(opening(two), /You are a fork of yourself/, 'the directive is not repeated');
    // A continued fork runs under the fork limit as well, and on its own model.
    assert.equal(two.messages.some(message => message.role === 'tool' && message.text === 'Result delivered to your dispatcher.'), true);
  } finally {await done();}
});

test('Fork: the field is normalised, and named in the description right after the mode bullet', () => {
  assert.equal(automaSchema.safeParse({jobs: [{brief: 'x', scope: 'exact', fork: true}]}).success, true);
  const notes: string[] = [];
  const normalized = normalizeAutomaInput({jobs: [{brief: 'x', fork: 'true'}, {brief: 'y', fork: 'false'}, {brief: 'z', fork: 'maybe'}]}, notes) as {jobs: {fork?: boolean}[]};
  assert.deepEqual(normalized.jobs.map(item => item.fork), [true, undefined, undefined]);
  const lines = AUTOMA_DESCRIPTION.split('\n'), mode = lines.findIndex(line => line.startsWith('- `mode: "background"`'));
  assert.equal(lines[mode + 1], '- `fork: true` runs the job as a copy of yourself that starts with your full context instead of a brief: use it for a part that needs your understanding, not for searches or mechanical edits. It costs far more than a worker; at most a few run at once.');
  assert.equal(FORK_DIRECTIVE.split('\n').length, 3);
});

test('Fork: forks are marked in the delegation record, /tasks, the plan and the Automa card, and are never actors', async () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'Parser', taskTitle: 'Parser', status: 'running', stage: 'x', detail: ''});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'techne'});
  const id = steps.tool({id: 'automa1', name: 'Automa', arguments: JSON.stringify({jobs: [{brief: 'x'}]})});
  steps.start(id);
  const swarm: AutomaSwarm = {name: 'work crew', jobs: [
    {id: 'T1', title: 'Forked slice', kind: 'fork', state: 'running', elapsedMs: 0, startedAt: Date.now() - 3000, calls: []},
    {id: 'T2', title: 'Worker slice', state: 'done', elapsedMs: 900, calls: [], route: 'read', summary: 'ok'}]};
  steps.swarm(id, swarm);
  const snapshot = store.getSnapshot();
  const records = projectDelegations({snapshot, sessionId: 's'});
  const forked = records.find(record => record.id === 'a/T1')!, worker = records.find(record => record.id === 'a/T2')!;
  assert.deepEqual([forked.kind, forked.fork, worker.kind, worker.fork], ['automa', true, 'automa', undefined]);
  assert.match(statusText(forked, undefined), /^kind: fork · running/);
  assert.doesNotMatch(statusText(worker, undefined), /kind: fork/);
  assert.equal(records.filter(record => record.kind === 'actor').length, 1, 'only the real actor');
  assert.equal(snapshot.activities.length, 1, 'a fork is no activity');

  const plan: Plan = {id: 'p1', title: 'Plan', status: 'active', createdAt: 1, updatedAt: 1, sessionId: 's', nodes: [
    {id: '1', title: 'Phase', owner: 'techne', after: [], acceptance: [], links: []},
    {id: '1.1', title: 'Forked step', owner: 'techne', after: [], acceptance: [], links: [{automaJob: 'a/T1'}]},
    {id: '1.2', title: 'Worker step', owner: 'techne', after: [], acceptance: [], links: [{automaJob: 'a/T2'}]}]};
  const derived = derivePlan(plan, records);
  assert.deepEqual(derived.nodes.map(node => node.forked), [undefined, true, undefined]);
  const flow = buildFlow(derived, {width: 40, perRow: 1, expanded: new Map([['1', true]]), owners: owner => ({symbol: '◆', name: owner})});
  const flowText = JSON.stringify(flow.rows.map(row => row.map(cell => cell.text).join('')));
  assert.match(flowText, /▌ techne ⑂/, 'a fork shows its owner as the actor and ⑂ on the second row of its card');
  assert.equal((flowText.match(/⑂/g) ?? []).length, 1, 'only the forked node carries the mark');

  const rows = (folds: Record<string, boolean> = {}) => buildStageRows(snapshot, 's', 'techne', 100, folds, null);
  const text = (row: SceneRow) => row.displayText ?? row.text;
  const live = rows().find(row => /Forked slice/.test(text(row)))!;
  assert.match(text(live), /◇⑂ Forked slice|⑂ Forked slice/, 'the dispatcher\'s symbol and ⑂ replace the worker dot');
  assert.ok(!text(live).includes('◜'));
});
