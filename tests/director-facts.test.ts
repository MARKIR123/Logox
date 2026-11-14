import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../src/runtime/store.js';
import {executeListActors} from '../src/tools/coordination/ListActorsTool/ListActorsTool.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {Resources} from '../src/resources/manager.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {createAgent} from '../src/kernel/agent.js';
import {composeBaseSystemPrompt, PROMPT_CACHE_BOUNDARY} from '../src/prompts/boundary.js';
import {createRuntimeContextMessage} from '../src/runtime/context-updates.js';
import {anthropicSystem, systemText} from '../src/providers/http.js';
import {canonicalJson} from '../src/kernel/execution-recovery.js';
import {resolveProviderCapabilities} from '../src/providers/capabilities.js';
import {Mcp} from '../src/extensions/mcp.js';
import {builtinToolRegistrations} from '../src/tools/catalog.js';
import {canonicalToolName} from '../src/tools/types.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

function activity(store: RuntimeStore, id: string, owner: string, status: 'running' | 'waiting_input' | 'queued' | 'paused' | 'completed', formal = true) {
  store.activities.create({sessionId: 's', activityId: id, ownerId: owner, kind: owner === 'logox' ? 'director' : 'actor',
    title: id, status, stage: 'Current operation', detail: 'Private task instructions',
    inputKind: formal ? 'director' : 'human', rootActivityId: formal ? 'root' : 'direct-root', ...(formal ? {parentActivityId: 'root'} : {})});
}
function context(activityId = 'root', ownerId = 'logox'): ActorContext {
  return {sessionId: 's', activityId, ownerId, rootActivityId: activityId, history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {return false;}};
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-facts-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const store = new RuntimeStore();
  const services = new ActorServices({sessionId: 's', catalog, config, journal: new Journal(join(directory, 'journal')),
    registry: new ProviderRegistry(config, {}), resources: new Resources(directory, {home: directory, boundary: directory}),
    requireIdle() {}, approve: async () => false, enqueue() {throw new Error('Facts must not schedule work');}, getSnapshot: () => store.getSnapshot()});
  const facts = (ctx = context()): string => {
    const project = Reflect.get(services, 'facts');
    assert.equal(typeof project, 'function', 'ActorServices must expose the same resident facts used in requests');
    return Reflect.apply(project, services, [ctx]) as string;
  };
  return {store, services, facts, async close() {await services.flush(); await rm(directory, {recursive: true, force: true});}};
}

test('ListActors discovers dynamic roles and reports waiting, queued and paused work as non-idle', () => {
  const store = new RuntimeStore();
  activity(store, 'waiting', 'scout', 'waiting_input'); activity(store, 'queued', 'techne', 'queued'); activity(store, 'paused', 'kalon', 'paused');
  const data = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => store.getSnapshot(), roles: {scout: {name: 'Scout'}}}).text);
  assert.equal(data.actors.find((item: {id: string}) => item.id === 'scout')?.activityStatus, 'waiting_input');
  assert.equal(data.actors.find((item: {id: string}) => item.id === 'techne')?.activityStatus, 'queued');
  assert.equal(data.actors.find((item: {id: string}) => item.id === 'kalon')?.activityStatus, 'paused');
  assert.ok(data.actors.every((item: {status: string}) => item.status !== 'idle'));
});

test('ListActors includes recent completed tool outcomes while peer detail remains sanitized', () => {
  const store = new RuntimeStore(); activity(store, 'child', 'techne', 'running');
  store.message('s', 'techne', 'assistant', 'Private output', {activityId: 'child', kind: 'tool',
    step: {title: 'Read', callId: 'read-1', state: 'completed', elapsedMs: 3}});
  const director = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
  assert.equal(director.recentTools?.[0]?.callId, 'read-1');
  assert.equal(director.recentTools?.[0]?.state, 'completed');
  assert.ok(!JSON.stringify(director).includes('Private output'));
  const peer = JSON.parse(executeListActors({}, {caller: 'kalon', getSnapshot: () => store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
  assert.equal(peer.recentTools, undefined); assert.equal(peer.activityId, undefined);
});

test('ListActors retains terminal tool evidence without presenting a completed task as executing', () => {
  const store = new RuntimeStore(); activity(store, 'finished', 'techne', 'completed');
  store.message('s', 'techne', 'assistant', 'Recorded result', {activityId: 'finished', kind: 'tool',
    step: {title: 'Read', callId: 'completed-read', state: 'completed', elapsedMs: 2}});
  store.message('s', 'techne', 'assistant', 'Old incomplete step', {activityId: 'finished', kind: 'tool',
    step: {title: 'Shell', callId: 'stale-shell', state: 'running', elapsedMs: 0}});
  const actor = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
  assert.equal(actor.status, 'idle'); assert.equal(actor.activityStatus, 'completed');
  assert.equal(actor.activityId, 'finished'); assert.equal(actor.currentTool, undefined);
  assert.equal(actor.recentTools[0].callId, 'completed-read');
});

test('solo Director and direct Actor conversations produce no resident roster or empty-section notice', async () => {
  const f = await fixture();
  try {
    assert.equal(f.facts(), '');
    activity(f.store, 'direct', 'techne', 'running', false);
    assert.equal(f.facts(), '');
    activity(f.store, 'closed-old', 'kalon', 'completed');
    assert.equal(f.facts(context('new-human-root')), '');
    assert.equal(f.facts(context('root', 'techne')), '');
  } finally {await f.close();}
});

test('resident facts distinguish self-reported labels and tool completion from task acceptance', async () => {
  const f = await fixture();
  try {
    activity(f.store, 'child', 'techne', 'running');
    f.store.activities.update('s', 'child', {progress: {label: 'Tests passed according to Actor'}});
    for (let index = 0; index < 6; index++) f.store.message('s', 'techne', 'assistant', 'Large private result body', {activityId: 'child', kind: 'tool',
      step: {title: 'Read', callId: 'read-' + index, state: 'completed', elapsedMs: index}});
    const text = f.facts();
    const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
    const child = data.tasks.find((item: {activityId: string}) => item.activityId === 'child');
    assert.deepEqual(Object.keys(child).sort(), ['activityId', 'ownerId', 'status']);
    assert.equal(child.status, 'running');
    assert.ok(!text.includes('Tests passed according to Actor'), 'the live subtitle changes every step and is not part of the stored snapshot');
    f.store.activities.update('s', 'child', {progress: {label: 'A later self-reported label'}});
    assert.equal(f.facts(), text, 'a changed subtitle is not a change in the snapshot');
    assert.ok(!text.includes('Large private result body')); assert.ok(!text.includes('Private task instructions'));
    assert.equal(f.facts(), text, 'an unchanged ensemble produces identical text, so no new record is written');
    f.store.message('s', 'techne', 'assistant', 'More work', {activityId: 'child', kind: 'tool', step: {title: 'Read', callId: 'read-9', state: 'completed', elapsedMs: 1}});
    assert.equal(f.facts(), text, 'tool activity is not a change in who is doing what');
    f.store.activities.update('s', 'child', {status: 'completed'});
    assert.notEqual(f.facts(), text, 'a status change is');
    const roster = JSON.parse(executeListActors({}, {caller: 'logox', getSnapshot: () => f.store.getSnapshot()}).text).actors.find((item: {id: string}) => item.id === 'techne');
    assert.equal(roster.recentTools.at(-1).callId, 'read-9', 'detail is still available through ListActors');
  } finally {await f.close();}
});

test('resident facts bound large ensembles without hiding the count of additional relevant work', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 12; index++) activity(f.store, 'child-' + index, 'dynamic-' + index, 'queued');
    const text = f.facts(); const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
    assert.equal(data.tasks.length, 8); assert.equal(data.additionalTasks, 4);
    assert.equal(data.tasks[0].status, 'queued');
  } finally {await f.close();}
});

test('activeEnsembleRoster returns empty string when solo and formats peer mainTitle · subTitle, files, and running tool when active', async () => {
  const f = await fixture();
  try {
    activity(f.store, 'techne-1', 'techne', 'running');
    assert.equal(f.facts(context('techne-1', 'techne')), '');

    activity(f.store, 'kalon-idle', 'kalon', 'completed');
    assert.equal(f.facts(context('techne-1', 'techne')), '');

    f.store.activities.create({
      sessionId: 's',
      activityId: 'kalon-active',
      ownerId: 'kalon',
      kind: 'actor',
      title: 'Kalon · 审美官',
      taskTitle: 'Refine palette tokens',
      progress: {label: 'Auditing contrast'},
      status: 'running',
      stage: '处理中',
      detail: 'Check contrast ratios',
      inputKind: 'director',
      rootActivityId: 'root',
      parentActivityId: 'root',
    });
    f.store.message('s', 'kalon', 'assistant', '', {
      activityId: 'kalon-active',
      kind: 'tool',
      step: {
        title: 'Edit · src/tui/theme.ts',
        callId: 'edit-1',
        state: 'completed',
        elapsedMs: 12,
        call: {id: 'edit-1', name: 'Edit', arguments: JSON.stringify({file_path: 'src\\tui\\theme.ts', old_string: 'a', new_string: 'b'})},
      },
    });
    f.store.message('s', 'kalon', 'assistant', '', {
      activityId: 'kalon-active',
      kind: 'tool',
      step: {
        title: 'Read · docs/design.md',
        callId: 'read-1',
        state: 'completed',
        elapsedMs: 5,
        call: {id: 'read-1', name: 'Read', arguments: JSON.stringify({file_path: 'docs/design.md'})},
      },
    });
    f.store.message('s', 'kalon', 'assistant', '', {
      activityId: 'kalon-active',
      kind: 'tool',
      step: {
        title: 'Shell · npm test',
        callId: 'shell-1',
        state: 'running',
        elapsedMs: 200,
      },
    });

    const roster = f.facts(context('techne-1', 'techne'));
    assert.match(roster, /^Active ensemble roster \(Logox is always reachable as Director; idle roles omitted\):/);
    assert.match(roster, /- kalon \(running\): Refine palette tokens$/m);
    assert.ok(!/Auditing contrast|theme\.ts|npm test/.test(roster), 'subtitles, recent files and the running tool are not stored');
    f.store.activities.update('s', 'kalon-active', {progress: {label: 'Checking another thing'}});
    f.store.message('s', 'kalon', 'assistant', '', {activityId: 'kalon-active', kind: 'tool', step: {title: 'Shell · other', callId: 'shell-2', state: 'running', elapsedMs: 1}});
    assert.equal(f.facts(context('techne-1', 'techne')), roster, 'live progress does not change the roster');

    f.store.activities.update('s', 'kalon-active', {status: 'completed'});
    assert.equal(f.facts(context('techne-1', 'techne')), '');
  } finally {await f.close();}
});

test('Actor dispatch with title preserves natural prompt without task-book headers, sets taskTitle, and renders Main Title · SubTitle while running and Main Title on completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-actor-title-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const store = new RuntimeStore();
  const journal = new Journal(join(directory, 'journal'));
  const {EnsembleRuntime} = await import('../src/actors/ensemble.js');
  const {buildStageRows} = await import('../src/tui/timeline/stage.js');

  let receivedPrompt = '';
  let runningContext!: ActorContext;
  let startedResolve!: () => void;
  const started = new Promise<void>(resolve => {startedResolve = resolve;});
  let finishResolve!: () => void;
  const finishGate = new Promise<void>(resolve => {finishResolve = resolve;});

  const ensemble = new EnsembleRuntime('s', store, journal, async (prompt, ctx) => {
    receivedPrompt = prompt;
    runningContext = ctx;
    startedResolve();
    await finishGate;
    ctx.say('Completed token audit.');
  });

  let dispatchedHandle!: import('../src/actors/ensemble.js').TaskHandle;
  const services = new ActorServices({
    sessionId: 's',
    catalog,
    config,
    journal,
    registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}),
    requireIdle() {},
    approve: async () => false,
    enqueue: (owner, prompt, source, origin) => {
      dispatchedHandle = ensemble.dispatch(owner as 'techne', prompt, source, origin);
      return dispatchedHandle;
    },
    getSnapshot: () => store.getSnapshot(),
  });

  try {
    const dispatchRes = await services.execute({
      id: 'call-actor-1',
      name: 'Actor',
      arguments: JSON.stringify({
        tasks: [{
          ownerId: 'techne',
          title: 'Audit theme contrast',
          prompt: 'Verify header and statusbar contrast ratios against WCAG AA.',
        }],
      }),
    }, context('root', 'logox'));

    assert.equal(dispatchRes.isError, false, dispatchRes.text);
    await started;

    assert.equal(receivedPrompt, 'Verify header and statusbar contrast ratios against WCAG AA.');
    assert.doesNotMatch(receivedPrompt, /【User Goal|用户目标|Task Card Main Title|任务卡主标题/);

    const act = store.activities.get('s', runningContext.activityId);
    assert.ok(act);
    assert.equal(act.taskTitle, 'Audit theme contrast');

    store.message('s', 'techne', 'assistant', '', {activityId: runningContext.activityId, kind: 'thinking', step: {title: 'Thinking', state: 'completed', elapsedMs: 10, groupId: 'g1'}});
    store.message('s', 'techne', 'assistant', '⏵ Checking statusbar tokens\nWorking.', {activityId: runningContext.activityId});

    const runningRows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[runningContext.activityId]: false}, null)
      .map(row => row.text).join('\n');
    assert.match(runningRows, /Audit theme contrast · Checking statusbar tokens/);

    finishResolve();
    await dispatchedHandle.done;

    const completedAct = store.activities.get('s', runningContext.activityId);
    assert.equal(completedAct?.status, 'completed');
    const completedRows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[runningContext.activityId]: false}, null)
      .map(row => row.text).join('\n');
    assert.match(completedRows, /Audit theme contrast/);
    assert.doesNotMatch(completedRows, /Audit theme contrast · Checking statusbar tokens/);
  } finally {
    finishResolve();
    await ensemble.close();
    await services.flush();
    await rm(directory, {recursive: true, force: true});
  }
});

test('on any protocol the snapshot is stored once while unchanged, again on change, and requests only ever append', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-snapshot-'));
  const store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const stored: unknown[] = [];
  const turns: ModelTurn[] = [
    {message: {role: 'assistant', text: '', toolCalls: [{id: 'g1', name: 'Glob', arguments: '{"pattern":"a*"}'}]}, stop: 'tools'},
    {message: {role: 'assistant', text: '', toolCalls: [{id: 'g2', name: 'Glob', arguments: '{"pattern":"b*"}'}]}, stop: 'tools'},
    {message: {role: 'assistant', text: 'Done.', toolCalls: [{id: 'f', name: '_FinishRound', arguments: JSON.stringify({title: 'Done', summary: 'Round outcome.'})}]}, stop: 'tools'},
  ];
  const provider: Provider = {async respond(request, delta) {
    requests.push(structuredClone(request));
    const turn = turns[requests.length - 1]!;
    if (turn.message.text) delta({kind: 'text', text: turn.message.text});
    return turn;
  }};
  const execute = createAgent({cwd: directory, store, tools: new Tools(directory), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd: directory, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions, snapshot: requests.length < 2 ? 'state 1' : 'state 2'})});
  const journal = new Journal(join(directory, 'sessions'));
  const old = createRuntimeContextMessage('task-state', 'stale facts', {slot: 'director-facts', activityId: 'a'});
  const savedFacts = {role: 'context', text: old.text, message: old} as unknown as ActorContext['history'][number];
  const ensemble = new EnsembleRuntime<string>('s', store, journal, async (prompt, context) => execute(prompt, {...context, history: [...context.history, savedFacts], record: async (message, step) => { stored.push(message); await context.record(message, step); }}), {handoff: async () => {}});
  try {
    await ensemble.dispatch('logox', 'Go', 'direct').done;
    assert.equal(requests.length, 3);
    const copies = (request: ModelRequest) => request.messages.filter(message => message.role === 'context' && message.kind === 'task-state' && message.data?.slot === 'ensemble').map(message => message.text);
    for (const request of requests) {
      assert.ok(!request.messages.some(message => message.role === 'context' && message.kind === 'snapshot'), 'no per-request tail snapshot');
      assert.ok(!JSON.stringify(request.messages).includes('stale facts'), 'copies stored by older sessions are not replayed');
    }
    assert.deepEqual(copies(requests[0]!), ['state 1']);
    assert.deepEqual(copies(requests[1]!), ['state 1'], 'an unchanged ensemble is not stored again');
    assert.deepEqual(copies(requests[2]!), ['state 1', 'state 2'], 'a change is stored once');
    assert.equal(stored.filter(message => JSON.stringify(message).includes('state ')).length, 2);
    for (let index = 1; index < requests.length; index++) {
      const before = requests[index - 1]!.messages, after = requests[index]!.messages;
      const same = (a: unknown, b: unknown) => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
      const diverged = before.findIndex((message, at) => !same(message, after[at]));
      assert.equal(diverged, -1, `request ${index} rewrote message ${diverged}`);
    }
    assert.ok(stored.length > 0);
  } finally { await ensemble.close(); await rm(directory, {recursive: true, force: true}); }
});

test('where the API binds thinking to history, the snapshot is appended only on change and nothing is ever removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-append-'));
  const store = new RuntimeStore();
  const requests: ModelRequest[] = [];
  const turn = (id: string): ModelTurn => ({message: {role: 'assistant', text: '', toolCalls: [{id, name: 'Glob', arguments: JSON.stringify({pattern: id})}]}, stop: 'tools'});
  const turns = [turn('g1'), turn('g2'), turn('g3'),
    {message: {role: 'assistant' as const, text: 'Done.', toolCalls: [{id: 'f', name: '_FinishRound', arguments: JSON.stringify({title: 'Done', summary: 'Round outcome.'})}]}, stop: 'tools' as const},
    {message: {role: 'assistant' as const, text: 'Again.', toolCalls: [{id: 'f2', name: '_FinishRound', arguments: JSON.stringify({title: 'Again', summary: 'Round outcome.'})}]}, stop: 'tools' as const}];
  const provider: Provider = {capabilities: {toolDiscovery: 'none', runtimeInstructions: 'meta-user', caching: 'anthropic', appendOnlyHistory: true},
    async respond(request, delta) {
      requests.push(structuredClone(request));
      const value = turns[requests.length - 1]!;
      if (value.message.text) delta({kind: 'text', text: value.message.text});
      return value;
    }};
  const execute = createAgent({cwd: directory, store, tools: new Tools(directory), provider: () => provider, iterations: 0, retries: 0,
    requestBase: async () => ({...composeBaseSystemPrompt({cwd: directory, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions, snapshot: requests.length < 2 ? 'techne running' : 'techne completed'})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(directory, 'sessions')), execute, {handoff: async () => {}});
  try {
    await ensemble.dispatch('logox', 'Go', 'direct').done;
    assert.equal(requests.length, 4);
    const copies = (request: ModelRequest) => request.messages.filter(message => message.role === 'context' && message.kind === 'task-state' && message.data?.slot === 'ensemble').map(message => message.text);
    assert.deepEqual(copies(requests[0]!), ['techne running']);
    assert.deepEqual(copies(requests.at(-1)!), ['techne running', 'techne completed'], 'one record per change, and the earlier one stays');
    assert.ok(!requests.some(request => request.messages.some(message => message.role === 'context' && message.kind === 'snapshot')));
    await ensemble.dispatch('logox', 'Again', 'direct').done;
    assert.equal(requests.length, 5);
    assert.ok(requests[4]!.messages.some(message => message.role === 'assistant' && message.toolCalls?.some(call => call.name === '_FinishRound')),
      'the closed round keeps its _FinishRound call when the next round starts');
    for (let index = 1; index < requests.length; index++) {
      const before = requests[index - 1]!.messages, after = requests[index]!.messages;
      // Key order inside a stored record is not part of the wire format; the provider rebuilds each block in a fixed shape.
      const same = (a: unknown, b: unknown) => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
      const diverged = before.findIndex((message, at) => !same(message, after[at]));
      assert.equal(diverged, -1, `request ${index} rewrote message ${diverged}: ${JSON.stringify(before[diverged])} became ${JSON.stringify(after[diverged])}`);
    }
  } finally { await ensemble.close(); await rm(directory, {recursive: true, force: true}); }
});

test('only the Anthropic protocol is append-only', () => {
  const settings = {kind: 'anthropic', baseUrl: 'https://proxy.example/v1', model: 'm', key: '', temperature: 0, maxTokens: 1, timeoutMs: 1} as const;
  assert.equal(resolveProviderCapabilities(settings as never).appendOnlyHistory, true);
  assert.equal(resolveProviderCapabilities({...settings, kind: 'openai_compat'} as never).appendOnlyHistory, undefined);
});

test('the system prompt is two cached parts for Anthropic and plain text everywhere else', () => {
  const {system} = composeBaseSystemPrompt({cwd: '/w', ownerId: 'techne', builtinPrompt: 'Persona', rulesContext: 'Project rule'});
  const parts = anthropicSystem(system) as readonly {text: string; cache_control: unknown}[];
  assert.equal(parts.length, 2);
  assert.ok(parts.every(part => part.cache_control));
  assert.ok(parts[0]!.text.includes('# Team Collaboration') && !parts[0]!.text.includes('Project rule'));
  assert.ok(parts[1]!.text.startsWith('# Project Guidelines'));
  assert.ok(!systemText(system).includes(PROMPT_CACHE_BOUNDARY));
  assert.ok(!parts.some(part => part.text.includes(PROMPT_CACHE_BOUNDARY)));
  const changed = anthropicSystem(composeBaseSystemPrompt({cwd: '/elsewhere', ownerId: 'techne', builtinPrompt: 'Persona', rulesContext: 'Another rule'}).system) as readonly {text: string}[];
  assert.equal(changed[0]!.text, parts[0]!.text, 'a new project or rule leaves the fixed part byte-identical');
});

test('an actor getting its own browser client does not change the tool list', () => {
  const mcp = new Mcp(tmpdir(), {playwright: {transport: 'stdio', command: 'node', args: ['-v'], env: {}, enabled: true, description: '', timeout: 1, startup_timeout_s: 1}});
  const before = JSON.stringify(mcp.definitions());
  assert.match(before, /Servers: playwright"/);
  const client = Reflect.get(mcp, 'clientFor') as (server: string, owner: string) => unknown;
  assert.ok(Reflect.apply(client, mcp, ['playwright', 'techne']));
  assert.equal(JSON.stringify(mcp.definitions()), before);
});

test('BorrowSkill is gone', () => {
  assert.ok(!builtinToolRegistrations().some(item => item.metadata.name === 'BorrowSkill'));
  assert.equal(canonicalToolName('borrow_skill'), undefined);
});
