import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskModels, TaskModelLedger, type TaskModelSelection} from '../src/actors/task-models.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import {actorModelSchema, parseActor, parseActorProfile, serializeActor} from '../src/actors/definitions.js';
import {ActorModelStorage} from '../src/actors/actor-models-storage.js';
import {ToolModelStorage, toolModelSchema} from '../src/tools/tool-models.js';
import {chooseAutomaModel} from '../src/tools/orchestration/AutomaTool/preset.js';
import {bindingChoices} from '../src/commands/model-choices.js';
import {ProviderError} from '../src/providers/http.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';
import {loadConfig} from '../src/config/config.js';

/** Every provider is local to the test: a fake fetch records request bodies, nothing touches the network or the real home. */
async function fixture(binding: () => TaskModelSelection | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-thinking-effort-'));
  const bodies: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(String(url).includes('/claude')
      ? 'data: ' + JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn'}}) + '\n\n'
      : 'data: ' + JSON.stringify({choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}]}) + '\n\n');
  };
  const levels = ['auto', 'low', 'high'];
  const declared = (protocol: string) => ({context_window: 8192, thinking_protocol: protocol, thinking_levels: levels});
  const config = await loadConfig(directory, {permissions: {mode: 'default'}, provider: {name: 'main', model: 'same', max_tokens: 3000, thinking_effort: 'low'},
    providers: {main: {base_url: 'http://127.0.0.1:1/main', default_model: 'same', kind: 'openai_compat'},
      oa: {base_url: 'http://127.0.0.1:1/oa', default_model: 'reason', kind: 'openai_compat'},
      claude: {base_url: 'http://127.0.0.1:1/claude', default_model: 'adaptive', kind: 'anthropic'}},
    models: {'main/same': declared('reasoning-effort'), 'oa/reason': declared('reasoning-effort'), 'oa/reason-high': declared('reasoning-effort'),
      'claude/adaptive': declared('anthropic-adaptive')}} as never, {}, directory, directory);
  const registry = new ProviderRegistry(config, {}, fetcher, new AuthStorage(join(directory, 'auth.json')));
  const ledger = new TaskModelLedger(join(directory, 'models'));
  const models = new TaskModels({registry, defaultModel: owner => owner === 'techne' ? binding() : undefined, ledger});
  const context = (ownerId: string, activityId: string, extra: object = {}) =>
    ({sessionId: 's', ownerId, activityId, signal: new AbortController().signal, report() {}, ...extra}) as unknown as ActorContext;
  const send = (provider: {respond: unknown}) =>
    (provider.respond as (request: unknown, delta: () => void, signal: AbortSignal) => Promise<unknown>)({system: '', messages: [], tools: []}, () => {}, new AbortController().signal);
  return {directory, registry, ledger, models, bodies, context, send, cleanup: () => rm(directory, {recursive: true, force: true})};
}

const profile = 'id: test\nname: T\ntitle: E\ndescription: D\ncolor: "#112233"\nsymbol: ◈\nskills: []\n';
const identity = {sessionId: 's', ownerId: 'techne'};

test('a binding with or without effort round-trips through the actor file, actor-models.json and tool-models.json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-binding-'));
  try {
    for (const defaultModel of [{provider: 'p', model: 'm'}, {provider: 'p', model: 'm', effort: 'high' as const}]) {
      const yaml = profile + 'defaultModel:\n  provider: p\n  model: m\n' + (defaultModel.effort ? '  effort: high\n' : '');
      const actor = parseActorProfile({config: yaml, persona: 'persona', compression: 'c'});
      assert.deepEqual(actor.defaultModel, defaultModel);
      assert.deepEqual(parseActor(serializeActor(actor)).defaultModel, defaultModel);
      const actors = new ActorModelStorage(join(directory, 'actor-models.json'));
      await actors.save('techne', defaultModel);
      assert.deepEqual(new ActorModelStorage(join(directory, 'actor-models.json')).get('techne'), defaultModel);
      const tools = new ToolModelStorage(join(directory, 'tool-models.json'));
      await tools.save('automa', defaultModel);
      assert.deepEqual(new ToolModelStorage(join(directory, 'tool-models.json')).get('automa'), defaultModel);
    }
    assert.match(await readFile(join(directory, 'actor-models.json'), 'utf8'), /"effort": "high"/);
    assert.throws(() => actorModelSchema.parse({provider: 'p', model: 'm', effort: 'turbo'}));
    assert.throws(() => actorModelSchema.parse({provider: 'p', model: 'm', extra: 1}));
    assert.throws(() => toolModelSchema.parse({provider: 'p', model: 'm', effort: 'turbo'}));
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('a bound effort reaches the request body for both protocols and ignores later session changes; an inheriting actor follows the session', async () => {
  for (const [provider, model, field] of [['oa', 'reason', 'reasoning_effort'], ['claude', 'adaptive', 'output_config']] as const) {
    const f = await fixture(() => ({provider, model, effort: 'high'}));
    try {
      const scope = await f.models.begin(f.context('techne', 'a1'));
      assert.equal(scope.thinking().effort, 'high');
      await f.send(scope.provider());
      assert.ok(JSON.stringify(f.bodies[0]![field]).includes('high'), field + ' carries the bound effort, not the session low');
      f.registry.selectEffort('auto');
      assert.equal(f.models.thinking(identity).effort, 'high', 'a session change does not move the actor');
      assert.equal(f.models.thinkingOf(f.models.idleSelection('techne')).effort, 'high');
      // The inheriting actor keeps following the session model and effort.
      const kalon = await f.models.begin(f.context('kalon', 'a2'));
      assert.equal(kalon.thinking().effort, 'auto');
      f.registry.selectEffort('low');
      assert.equal(f.models.thinkingOf(f.models.idleSelection('kalon')).effort, 'low');
      await f.send(f.registry.candidate('main', 'same').provider());
      assert.equal(f.bodies.at(-1)!.reasoning_effort, 'low');
    } finally {await f.cleanup();}
  }
});

test('an effort the model does not declare falls back to auto without failing; a model naming its level ignores the stored effort', async () => {
  const f = await fixture(() => ({provider: 'oa', model: 'reason', effort: 'max'}));
  try {
    const scope = await f.models.begin(f.context('techne', 'a1'));
    assert.equal(scope.thinking().effort, 'auto');
    await f.send(scope.provider());
    assert.ok(!Object.hasOwn(f.bodies[0]!, 'reasoning_effort'));
  } finally {await f.cleanup();}
  const named = await fixture(() => ({provider: 'oa', model: 'reason-high', effort: 'low'}));
  try {
    assert.equal(named.models.idleSelection('techne').effort, undefined, 'the name is the level');
    const scope = await named.models.begin(named.context('techne', 'a1'));
    assert.equal(scope.thinking().effort, 'high');
    await named.send(scope.provider());
    assert.equal(named.bodies[0]!.reasoning_effort, 'high');
  } finally {await named.cleanup();}
});

test('a started task keeps its effort across a checkpoint restore, old checkpoints load, and a fallback model drops the bound effort', async () => {
  let binding: TaskModelSelection = {provider: 'oa', model: 'reason', effort: 'high'};
  const f = await fixture(() => binding);
  try {
    await f.models.begin(f.context('techne', 'a1'));
    const saved = await f.ledger.load('s', new Set(['a1']));
    assert.equal(saved[0]!.actual.effort, 'high');
    binding = {provider: 'oa', model: 'reason', effort: 'low'};
    f.models.restore(saved);
    assert.equal(f.models.selection(identity).effort, 'high');
    assert.equal(f.models.thinking(identity).effort, 'high', 'the started task is not moved by a new binding');
    // A checkpoint written before the field existed loads and runs with the session effort.
    const old = structuredClone(saved[0]!); delete old.initial.effort; delete old.actual.effort;
    f.models.restore([old]);
    assert.equal(f.models.thinking(identity).effort, 'low');

    binding = {provider: 'oa', model: 'reason', effort: 'high'};
    const ask = async () => ({status: 'answered', response: {kind: 'question', answers: {task_model: {type: 'option', optionId: 'switch'}}}});
    const scope = await f.models.begin(f.context('techne', 'a2', {ask}));
    assert.equal(scope.thinking().effort, 'high');
    assert.equal(await scope.fallback(new ProviderError('gone', false, 'model_missing')), true);
    assert.equal(scope.selection().effort, undefined, 'the session model runs with the session effort');
    assert.equal(scope.thinking().effort, 'low');
  } finally {await f.cleanup();}
});

test('Automa: a dedicated binding carries its effort into the worker provider request', async () => {
  const f = await fixture(() => undefined);
  try {
    const expand = () => {throw new Error('unused');};
    const chosen = chooseAutomaModel({dedicated: {provider: 'oa', model: 'reason', effort: 'high'}, preferred: undefined,
      session: {provider: 'main', model: 'same'}, pool: [], expand});
    assert.equal(chosen.effort, 'high');
    await f.send(f.registry.candidate(chosen.provider, chosen.model, chosen.effort).provider());
    assert.equal(f.bodies[0]!.reasoning_effort, 'high');
    const inherited = chooseAutomaModel({dedicated: undefined, preferred: undefined, session: {provider: 'oa', model: 'reason'}, pool: [], expand});
    await f.send(f.registry.candidate(inherited.provider, inherited.model, inherited.effort).provider());
    assert.equal(f.bodies[1]!.reasoning_effort, 'low', 'no binding effort: the session effort');
  } finally {await f.cleanup();}
});

const pool = [{provider: 'g', id: 'alpha-low'}, {provider: 'g', id: 'alpha-high'}, {provider: 'g', id: 'beta'},
  {provider: 'g', id: 'omega', thinkingLevels: ['auto', 'low', 'high']}, {provider: 'g', id: 'named-high', thinkingLevels: ['auto', 'low', 'high']}];

test('the picker stores the chosen effort for a single model only, never beside a variant or a named level, and preselects the bound one', () => {
  const choices = bindingChoices(undefined), items = choices.items(pool);
  const row = (label: string) => items.find(item => item.label === label)!;
  assert.deepEqual(choices.resolve(row('alpha').id, 'high'), {provider: 'g', model: 'alpha-high'}, 'variant family: the level picks the variant');
  assert.deepEqual(choices.resolve(row('omega').id, 'low'), {provider: 'g', model: 'omega', effort: 'low'});
  assert.deepEqual(choices.resolve(row('omega').id, 'max'), {provider: 'g', model: 'omega'}, 'an undeclared level is not stored');
  assert.deepEqual(choices.resolve(row('beta').id, 'high'), {provider: 'g', model: 'beta'}, 'no levels, no effort');
  assert.deepEqual(choices.resolve(row('named-high').id, 'low'), {provider: 'g', model: 'named-high'}, 'the name is the level');
  const bound = bindingChoices({provider: 'g', model: 'omega', effort: 'low'});
  assert.equal(bound.items(pool).find(item => item.label === 'omega')!.effort, 'low');
  assert.equal(bindingChoices({provider: 'g', model: 'omega'}).items(pool).find(item => item.label === 'omega')!.effort, 'auto', 'an unbound row opens on the picker default');
});
