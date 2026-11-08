import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {loadConfig, modelSettings, type ModelSettings} from '../src/config/config.js';
import {createProvider} from '../src/providers/http.js';
import {anthropicRetention, openAiRetentionFields, roleCacheRetention} from '../src/providers/cache.js';
import {costOf, turnUsageOf} from '../src/context/cost.js';
import {CacheKeeper, MAX_WARM_MS, warmDelayMs, warmSavings, type KeepAliveWho} from '../src/kernel/cache-keepalive.js';
import {parseActor} from '../src/actors/definitions.js';
import {usageRows} from '../src/context/usage.js';
import {TokenMeter} from '../src/context/budget.js';
import type {CacheProfile, ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({system: 'Stable rules\n\nvolatile part', tools: [{name: 'Read', description: 'Read', parameters: {type: 'object'}}],
  messages: [{role: 'user', text: 'hello'}], ...overrides});
const anthropic = (overrides: Partial<ModelSettings> = {}): ModelSettings => ({kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', key: 'sk-ant-secret',
  temperature: 0.2, maxTokens: 4096, timeoutMs: 5000, ...overrides});
function anthropicReply(usage: Record<string, unknown> = {input_tokens: 5, output_tokens: 1}): Response {
  return new Response(JSON.stringify({content: [{type: 'text', text: 'ok'}], stop_reason: 'end_turn', usage}), {status: 200, headers: {'content-type': 'application/json'}});
}
async function bodyOf(settings: ModelSettings, req: ModelRequest, reply: () => Response = anthropicReply): Promise<{body: Record<string, unknown>; turn: ModelTurn}> {
  let sent: Record<string, unknown> | undefined;
  const provider = createProvider(settings, (async (_url: unknown, init: {body?: unknown}) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>; return reply();
  }) as unknown as typeof fetch);
  const turn = await provider.respond({...req, stream: false}, () => {}, new AbortController().signal);
  return {body: sent!, turn};
}
const controls = (body: Record<string, unknown>): unknown[] => {
  const found: unknown[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (key === 'cache_control') found.push(item); else walk(item);
  };
  walk(body); return found;
};

test('TTL selection: actor override beats model setting beats role default; Director defaults long, others short', () => {
  assert.equal(roleCacheRetention('logox'), 'long');
  assert.equal(roleCacheRetention('techne'), 'short');
  assert.equal(anthropicRetention({}, {cacheRetention: {role: 'long'}}), 'long');
  assert.equal(anthropicRetention({}, {cacheRetention: {role: 'short'}}), 'short');
  assert.equal(anthropicRetention({cacheRetention: 'short'}, {cacheRetention: {role: 'long'}}), 'short');
  assert.equal(anthropicRetention({cacheRetention: 'long'}, {cacheRetention: {role: 'short'}}), 'long');
  assert.equal(anthropicRetention({cacheRetention: 'short'}, {cacheRetention: {role: 'long', actor: 'long'}}), 'long');
  assert.equal(anthropicRetention({}, {}), 'short');
});

test('cache_retention follows model > provider > named provider precedence and actors can override it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-retention-'));
  try {
    const load = (raw: Record<string, unknown>) => loadConfig(root, {permissions: {mode: 'default'}, ...raw}, {}, root, root);
    const base = {provider: {name: 'local', model: 'fixture'}, providers: {local: {kind: 'anthropic', base_url: 'http://127.0.0.1:9999/v1', cache_retention: 'short'}}};
    assert.equal(modelSettings(await load(base), {}).cacheRetention, 'short');
    assert.equal(modelSettings(await load({...base, provider: {...base.provider, cache_retention: 'long'}}), {}).cacheRetention, 'long');
    assert.equal(modelSettings(await load({...base, provider: {...base.provider, cache_retention: 'long'}, models: {'local/fixture': {cache_retention: 'short'}}}), {}).cacheRetention, 'short');
    assert.equal(modelSettings(await load({provider: {name: 'local', model: 'fixture', base_url: 'http://127.0.0.1:9999/v1'}}), {}).cacheRetention, undefined);
    assert.equal((await load({})).kernel.cache_keepalive, true);
    await assert.rejects(load({provider: {cache_retention: 'forever'}}));
    const actor = parseActor('---\nid: techne\nname: T\ntitle: T\ndescription: d\ncolor: "#aabbcc"\nsymbol: "T"\ncompression: c\ncache_retention: long\n---\nPersona');
    assert.equal(actor.cacheRetention, 'long');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('Anthropic breakpoints carry one 1h ttl per request for long, and no ttl for short', async () => {
  const long = await bodyOf(anthropic(), request({cacheRetention: {role: 'long'}}));
  const marks = controls(long.body);
  assert.ok(marks.length >= 3, 'system parts, tools and the last message are marked');
  assert.ok(marks.every(mark => JSON.stringify(mark) === JSON.stringify({type: 'ephemeral', ttl: '1h'})), 'every breakpoint uses the same ttl');
  const short = await bodyOf(anthropic(), request({cacheRetention: {role: 'short'}}));
  assert.ok(controls(short.body).length >= 3);
  assert.ok(controls(short.body).every(mark => JSON.stringify(mark) === JSON.stringify({type: 'ephemeral'})), 'short is unchanged (5m default)');
  const override = await bodyOf(anthropic({cacheRetention: 'long'}), request({cacheRetention: {role: 'short'}}));
  assert.ok(controls(override.body).every(mark => (mark as {ttl?: string}).ttl === '1h'), 'the model setting beats the role default');
});

test('OpenAI retention fields are absent by default and appear only with cache_retention = long on the provider or model', async () => {
  const openai = (overrides: Partial<ModelSettings> = {}): ModelSettings => ({kind: 'openai_compat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', key: 'sk-openai-secret',
    temperature: 0.2, maxTokens: 1000, timeoutMs: 5000, ...overrides});
  const chat = () => new Response(JSON.stringify({choices: [{message: {content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}}), {status: 200, headers: {'content-type': 'application/json'}});
  const responses = () => new Response(JSON.stringify({status: 'completed', output: [], usage: {input_tokens: 1, output_tokens: 1}}), {status: 200, headers: {'content-type': 'application/json'}});
  // The Director's long role default never reaches OpenAI.
  const byDefault = await bodyOf(openai(), request({cacheRetention: {role: 'long'}, cacheKey: 'k'}), chat);
  assert.equal(byDefault.body.prompt_cache_key, 'k');
  assert.ok(!('prompt_cache_retention' in byDefault.body) && !('prompt_cache_options' in byDefault.body));
  const defaultResponses = await bodyOf(openai({api: 'responses'}), request({cacheRetention: {role: 'long', actor: 'long'}}), responses);
  assert.ok(!('prompt_cache_retention' in defaultResponses.body) && !('prompt_cache_options' in defaultResponses.body));
  const optedOld = await bodyOf(openai({cacheRetention: 'long'}), request(), chat);
  assert.equal(optedOld.body.prompt_cache_retention, '24h');
  const optedShort = await bodyOf(openai({cacheRetention: 'short'}), request(), chat);
  assert.ok(!('prompt_cache_retention' in optedShort.body));
  const optedNew = await bodyOf(openai({cacheRetention: 'long', model: 'gpt-5.6', api: 'responses'}), request(), responses);
  assert.deepEqual(optedNew.body.prompt_cache_options, {ttl: '12h'});
  assert.ok(!('prompt_cache_retention' in optedNew.body));
  assert.deepEqual(openAiRetentionFields({cacheRetention: 'long', model: 'gpt-5.6'}, false), {}, 'the 12h option is a Responses feature');
  assert.deepEqual(openAiRetentionFields({cacheRetention: 'long', model: 'some-gateway-model'}, false), {});
  assert.deepEqual(openAiRetentionFields({cacheRetention: 'long', model: 'gpt-6.1-sol'}, true), {prompt_cache_options: {ttl: '12h'}});
  // Other providers: no effect.
  const gateway = await bodyOf({...openai({cacheRetention: 'long'}), baseUrl: 'https://gateway.example/v1', model: 'deepseek-chat'}, request({cacheRetention: {role: 'long'}}), chat);
  assert.ok(!('prompt_cache_retention' in gateway.body));
});

test('Anthropic cache_creation breakdown is read from usage', async () => {
  const {turn} = await bodyOf(anthropic(), request(), () => anthropicReply({input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 600,
    cache_creation: {ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 500}}));
  assert.deepEqual(turn.usage, {input: 710, output: 2, cacheRead: 100, cacheWrite: 600, cacheWrite1h: 500});
});

const price = {currency: 'USD', input: 3, output: 15, cache_read: 0.3, cache_write: 3.75};
const pricing = {models: {'anthropic/claude-test': {prices: price}}};
const record = {id: 'r', category: 'task' as const, model: 'anthropic/claude-test', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 1_000_000};
test('cost charges 1h writes at 2x input and 5m writes at the cache_write rate', () => {
  assert.equal(costOf([record], pricing)?.amount, 3.75);
  assert.equal(costOf([{...record, cacheWrite1h: 1_000_000}], pricing)?.amount, 6);
  assert.ok(Math.abs(costOf([{...record, cacheWrite1h: 400_000}], pricing)!.amount - (0.6 * 3.75 + 0.4 * 6)) < 1e-9);
  const explicit = {models: {'anthropic/claude-test': {prices: {...price, cache_write_1h: 7}}}};
  assert.equal(costOf([{...record, cacheWrite1h: 1_000_000}], explicit)?.amount, 7);
  const turn = turnUsageOf({input: 1_000_000, output: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000}, 'anthropic/claude-test', pricing);
  assert.equal(turn?.cost, 6);
  assert.equal(turn?.cacheWrite1h, 1_000_000);
});

test('keepalive usage is its own category in the meter and the usage page', () => {
  const meter = new TokenMeter();
  meter.configureUsage(() => 'anthropic/claude-test', () => {});
  meter.chargeUsage({input: 100, output: 1, cacheRead: 100}, 'anthropic/claude-test', 'keepalive');
  assert.equal(meter.usageRecords()[0]?.category, 'keepalive');
  const rows = usageRows(meter.usageRecords(), pricing as never).map(item => JSON.stringify(item)).join('\n');
  assert.match(rows, /keepalive/);
});

// ---- keep-alive ----
const who: KeepAliveWho = {sessionId: 's', ownerId: 'logox', activityId: 'a', rootActivityId: 'a'};
const MODEL = JSON.stringify(['anthropic', 'claude-test']);
function fixture(profile: CacheProfile | undefined = {ttlMs: 300_000, replayable: true}, usage: ModelTurn['usage'] = {input: 100_000, output: 1, cacheRead: 100_000}) {
  const calls: ModelRequest[] = [];
  const charges: unknown[] = [];
  const provider: Provider = {
    async cacheProfile() {return profile;},
    async respond(req) {calls.push(req); return {message: {role: 'assistant', text: ''}, stop: 'length', ...(usage ? {usage} : {})};},
  };
  const state = {certain: true, enabled: true};
  const keeper = new CacheKeeper({enabled: () => state.enabled, certain: () => state.certain, pricing, charge: (_who, amount) => {charges.push(amount);}});
  const arm = (tokens = 100_000) => keeper.arm(who, {request: request({cacheKey: 'k'}), provider, model: MODEL, startedAt: Date.now(),
    usage: {input: tokens, output: 5, cacheRead: tokens}});
  return {calls, charges, keeper, state, arm, provider};
}
const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
async function advance(ms: number) {mock.timers.tick(ms); await settle();}
const withClock = (body: () => Promise<void>) => async () => {
  mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_000_000});
  try {await body();} finally {mock.timers.reset();}
};

test('warm delay is 90% of the ttl or ttl minus 10s, and the savings guard needs a known price', () => {
  assert.equal(warmDelayMs(300_000), 270_000);
  assert.equal(warmDelayMs(60_000), 50_000);
  assert.equal(warmDelayMs(10_000), undefined);
  assert.ok(warmSavings(100_000, MODEL, pricing)! > 0.05);
  assert.ok(warmSavings(1_000, MODEL, pricing)! < 0.05);
  assert.equal(warmSavings(100_000, JSON.stringify(['anthropic', 'unpriced']), pricing), undefined);
  assert.equal(warmSavings(100_000, MODEL, {models: {'anthropic/claude-test': {prices: {currency: 'USD', input: 3, output: 15}}}}), undefined);
});

test('keep-alive replays the last request with maxTokens 1 while a wake-up is certain, and records keepalive usage', withClock(async () => {
  const {calls, charges, keeper, arm} = fixture();
  await arm();
  await advance(269_000);
  assert.equal(calls.length, 0, 'not before 90% of the ttl');
  await advance(1_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.maxTokens, 1);
  assert.equal(calls[0]!.stream, false);
  assert.equal(calls[0]!.purpose, 'keepalive');
  const strip = (req: ModelRequest) => ({...req, maxTokens: undefined, stream: undefined, purpose: undefined});
  assert.deepEqual(strip(calls[0]!), strip(request({cacheKey: 'k'})), 'same system, tools and messages');
  assert.equal(charges.length, 1, 'usage goes to the keepalive ledger');
  await advance(270_000);
  assert.equal(calls.length, 2, 'the chain continues');
  keeper.dispose();
}));

test('keep-alive stops when the actor wakes, when the work ends, and after one hour', withClock(async () => {
  const woken = fixture();
  await woken.arm();
  woken.keeper.wake(who);
  await advance(600_000);
  assert.equal(woken.calls.length, 0);

  const ended = fixture();
  await ended.arm();
  await advance(270_000);
  assert.equal(ended.calls.length, 1);
  ended.state.certain = false;
  await advance(270_000);
  assert.equal(ended.calls.length, 1, 'no warm-up once nothing is certain to wake the actor');
  await advance(600_000);
  assert.equal(ended.calls.length, 1);

  const hour = fixture();
  await hour.arm();
  for (let elapsed = 0; elapsed < MAX_WARM_MS + 600_000; elapsed += 30_000) await advance(30_000);
  const count = hour.calls.length;
  assert.ok(count >= 12 && count <= 14, 'about one warm-up every 4.5 minutes for an hour, got ' + count);
  await advance(MAX_WARM_MS);
  assert.equal(hour.calls.length, count, 'nothing after the first hour');
}));

test('keep-alive skips non-replayable requests, long caches, tiny prompts, unknown prices, uncached prompts and the disabled setting', withClock(async () => {
  const blocked = fixture({ttlMs: 300_000, replayable: false});
  await blocked.arm(); await advance(600_000);
  assert.equal(blocked.calls.length, 0, 'budget thinking cannot be replayed with maxTokens 1');
  const long = fixture({ttlMs: 3_600_000, replayable: true});
  await long.arm(); await advance(4_000_000);
  assert.equal(long.calls.length, 0, 'a 1h cache already outlives the wait');
  const none = fixture(undefined);
  await none.arm(); await advance(600_000);
  assert.equal(none.calls.length, 0, 'providers without a short cache are never warmed');
  const small = fixture();
  await small.arm(1_000); await advance(600_000);
  assert.equal(small.calls.length, 0, 'the savings guard keeps cheap prompts cold');
  const off = fixture();
  off.state.enabled = false;
  await off.arm(); await advance(600_000);
  assert.equal(off.calls.length, 0);
  const uncached = fixture();
  await uncached.keeper.arm(who, {request: request(), provider: uncached.provider, model: MODEL, startedAt: Date.now(), usage: {input: 100_000, output: 1}});
  await advance(600_000);
  assert.equal(uncached.calls.length, 0, 'nothing was cached, nothing to keep');
  const unpriced = fixture();
  await unpriced.keeper.arm(who, {request: request(), provider: unpriced.provider, model: JSON.stringify(['nobody', 'unknown']), startedAt: Date.now(),
    usage: {input: 100_000, output: 1, cacheRead: 100_000}});
  await advance(600_000);
  assert.equal(unpriced.calls.length, 0, 'unknown prices never warm');
}));

// ---- request dump and diff tool ----
test('LOGOX_DUMP_REQUESTS writes the body exactly as sent and never a credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-dump-'));
  try {
    const dir = join(root, 'requests', 'techne');
    const sent: string[] = [];
    const provider = createProvider(anthropic({key: 'sk-ant-TOPSECRET'}), (async (_url: unknown, init: {body?: unknown}) => {sent.push(String(init.body)); return anthropicReply();}) as unknown as typeof fetch);
    for (const text of ['first', 'second']) await provider.respond({...request({messages: [{role: 'user', text}]}), stream: false, dumpDir: dir}, () => {}, new AbortController().signal);
    await provider.respond({...request(), stream: false, dumpDir: dir, purpose: 'keepalive'}, () => {}, new AbortController().signal);
    const files = (await readdir(dir)).sort();
    assert.equal(files.length, 3);
    assert.match(files[0]!, /^000001-\d+\.json$/);
    assert.match(files[2]!, /^000003-\d+-keepalive\.json$/);
    for (const [index, file] of files.entries()) {
      const text = await readFile(join(dir, file), 'utf8');
      assert.equal(text, sent[index], 'byte for byte what was sent');
      assert.ok(!/TOPSECRET|x-api-key|authorization/i.test(text));
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test('diff-requests reports the first differing offset with context, per actor, skipping warm-ups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-diff-'));
  try {
    const tool = await import(pathToFileURL(join(import.meta.dirname, '..', '..', 'scripts', 'diff-requests.mjs')).href) as {
      firstDifference(a: string, b: string): number; compareConsecutive(files: {name: string; path: string}[], context?: number): {offset: number; before: string; after: string}[];
      main(argv: string[]): number;
    };
    assert.equal(tool.firstDifference('abcdef', 'abcxef'), 3);
    assert.equal(tool.firstDifference('abc', 'abc'), -1);
    assert.equal(tool.firstDifference('abc', 'abcd'), 3);
    const dir = join(root, 'logox');
    await mkdir(dir, {recursive: true});
    const body = (tail: string) => JSON.stringify({model: 'm', system: 'S'.repeat(500), messages: [{role: 'user', text: tail}]});
    await writeFile(join(dir, '000001-1.json'), body('one'));
    await writeFile(join(dir, '000002-2-keepalive.json'), body('ignored'));
    await writeFile(join(dir, '000003-3.json'), body('two'));
    const files = [{name: '000001-1.json', path: join(dir, '000001-1.json')}, {name: '000003-3.json', path: join(dir, '000003-3.json')}];
    const [result] = tool.compareConsecutive(files, 20);
    assert.equal(result!.offset, body('one').indexOf('one'));
    assert.ok(result!.before.includes('one') && result!.after.includes('two'));
    assert.ok(result!.before.length <= 40);
    const lines: string[] = [];
    const log = console.log; console.log = (...args: unknown[]) => {lines.push(args.join(' '));};
    try {assert.equal(tool.main([root]), 0);} finally {console.log = log;}
    const output = lines.join('\n');
    assert.match(output, /== logox \(2 requests\)/);
    assert.match(output, /000001-1\.json -> 000003-3\.json: first difference at offset \d+/);
  } finally {await rm(root, {recursive: true, force: true});}
});
