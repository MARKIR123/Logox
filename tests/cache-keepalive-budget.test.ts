import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {cacheLifetime, LONG_CACHE_MS, SHORT_CACHE_MS} from '../src/providers/cache.js';
import {CacheKeeper, warmCosts, type KeepAliveReason, type KeepAliveWho} from '../src/kernel/cache-keepalive.js';
import {kernelPreferenceSchema, loadConfig} from '../src/config/config.js';
import type {CacheProfile, ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const MINUTE = 60_000;
const who: KeepAliveWho = {sessionId: 's', ownerId: 'logox', activityId: 'a', rootActivityId: 'a'};
const MODEL = JSON.stringify(['anthropic', 'claude-test']);
// A cheap cache read keeps the cumulative-cost stop far away, so the away budget is what ends the warming.
const cheapRead = {models: {'anthropic/claude-test': {prices: {currency: 'USD', input: 3, output: 15, cache_read: 0.03, cache_write: 3.75}}}};
const dearRead = {models: {'anthropic/claude-test': {prices: {currency: 'USD', input: 3, output: 15, cache_read: 0.3, cache_write: 3.75}}}};
const request = (): ModelRequest => ({system: 'rules', tools: [], messages: [{role: 'user', text: 'hello'}], cacheKey: 'k'});

function fixture(options: {ttlMs: number; certain?: KeepAliveReason | false; awayMinutes?: number; pricing?: typeof cheapRead}) {
  const calls: ModelRequest[] = [], times: number[] = [];
  const profile: CacheProfile = {ttlMs: options.ttlMs, replayable: true};
  const usage: ModelTurn['usage'] = {input: 100_000, output: 1, cacheRead: 100_000};
  const provider: Provider = {
    async cacheProfile() {return profile;},
    async respond(req) {calls.push(req); times.push(Date.now()); return {message: {role: 'assistant', text: ''}, stop: 'length', usage};},
  };
  const state = {certain: options.certain ?? 'peer' as KeepAliveReason | false, awayMinutes: options.awayMinutes ?? 60};
  const keeper = new CacheKeeper({enabled: () => true, certain: () => state.certain, awayMs: () => state.awayMinutes * MINUTE, pricing: options.pricing ?? dearRead, charge: () => {}});
  const arm = () => keeper.arm(who, {request: request(), provider, model: MODEL, startedAt: Date.now(), usage: {input: 100_000, output: 5, cacheRead: 100_000}});
  return {calls, times, keeper, state, arm};
}
const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};
async function advance(ms: number) {mock.timers.tick(ms); await settle();}
/** Runs the clock forward in steps no longer than the warm delay, so every warm-up fires at its own time. */
async function run(ms: number, step = 30_000) {for (let elapsed = 0; elapsed < ms; elapsed += step) await advance(step);}
const withClock = (body: () => Promise<void>) => async () => {
  mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_000_000});
  try {await body();} finally {mock.timers.reset();}
};

test('lifetime confidence: configured and Anthropic lifetimes are known, GPT lifetimes are conservative estimates, the rest is unknown', () => {
  const anthropic = {kind: 'anthropic' as const, model: 'claude-test', baseUrl: 'https://api.anthropic.com/v1'};
  assert.deepEqual(cacheLifetime(anthropic, {cacheRetention: {role: 'long'}}), {ms: LONG_CACHE_MS, confidence: 'known'});
  assert.deepEqual(cacheLifetime(anthropic, {cacheRetention: {role: 'short'}}), {ms: SHORT_CACHE_MS, confidence: 'known'});
  assert.deepEqual(cacheLifetime({kind: 'openai_compat', model: 'gpt-4.1', cacheTtlMs: 120_000}, {}), {ms: 120_000, confidence: 'known'}, 'the user setting wins');
  assert.deepEqual(cacheLifetime({kind: 'openai_compat', model: 'gpt-5.6'}, {}), {ms: 30 * MINUTE, confidence: 'estimated'});
  assert.deepEqual(cacheLifetime({kind: 'openai_compat', model: 'gpt-6.1-sol', cacheRetention: 'long'}, {}), {ms: 12 * 60 * MINUTE, confidence: 'estimated'});
  assert.deepEqual(cacheLifetime({kind: 'openai_compat', model: 'gpt-5.4'}, {}), {ms: 5 * MINUTE, confidence: 'estimated'});
  assert.deepEqual(cacheLifetime({kind: 'openai_compat', model: 'gpt-4o', cacheRetention: 'long'}, {}), {ms: 24 * 60 * MINUTE, confidence: 'estimated'});
  assert.equal(cacheLifetime({kind: 'openai_compat', model: 'deepseek-chat'}, {}), undefined);
});

test('a miss costs the 1h write price for a long lifetime, so a long cache may be warmed more often', () => {
  const short = warmCosts(100_000, MODEL, dearRead)!, long = warmCosts(100_000, MODEL, dearRead, true)!;
  assert.ok(long.miss > short.miss);
  assert.equal(long.warm, short.warm);
  assert.equal(warmCosts(100_000, JSON.stringify(['nobody', 'unknown']), dearRead), undefined, 'unknown prices never warm');
});

test('peer wait: a 1h cache is warmed too, with no time cap, until the warm-ups would cost one miss', withClock(async () => {
  const f = fixture({ttlMs: LONG_CACHE_MS, certain: 'peer'});
  await f.arm();
  await run(53 * MINUTE);
  assert.equal(f.calls.length, 0, 'not before 54 minutes');
  await run(2 * MINUTE);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.keeper.state(who)?.reason, 'peer');
  await run(20 * 60 * MINUTE, 60_000);
  const count = f.calls.length;
  assert.equal(count, 18, 'about eighteen 1h warm-ups equal one 1h miss, far beyond the old 60-minute cap');
  await run(3 * 60 * MINUTE, 60_000);
  assert.equal(f.calls.length, count, 'nothing after the cost limit');
  assert.equal(f.keeper.state(who), undefined);
}));

test('peer wait of a 5m cache stops at the cumulative cost, not at an hour', withClock(async () => {
  const f = fixture({ttlMs: 5 * MINUTE, certain: 'peer'});
  await f.arm();
  await run(90 * MINUTE);
  assert.equal(f.calls.length, 11);
  assert.equal(f.times.at(-1)! - 1_000_000, 11 * 270_000, 'the count is set by cost, not by the clock');
}));

test('human away: a 5m cache is warmed about every 4.5 minutes until the budget ends', withClock(async () => {
  const f = fixture({ttlMs: 5 * MINUTE, certain: 'human', awayMinutes: 60, pricing: cheapRead});
  await f.arm();
  await run(3 * MINUTE);
  const early = f.keeper.state(who)!;
  assert.equal(early.reason, 'human');
  assert.equal(early.until, 1_000_000 + 60 * MINUTE);
  assert.equal(early.nextWarmAt, 1_000_000 + 270_000);
  await run(120 * MINUTE);
  assert.equal(f.calls.length, 13, 'the last warm-up keeps the cache alive to within a tenth of its lifetime of the budget end');
  assert.ok(f.times.every((time, index) => time - 1_000_000 === 270_000 * (index + 1)), 'one warm-up every 4.5 minutes');
  assert.ok(f.times.at(-1)! < 1_000_000 + 60 * MINUTE);
  assert.equal(f.keeper.state(who), undefined, 'after the budget nothing is warmed');
}));

test('human away: the budget is the setting, and 0 never warms', withClock(async () => {
  const half = fixture({ttlMs: 5 * MINUTE, certain: 'human', awayMinutes: 30, pricing: cheapRead});
  await half.arm(); await run(120 * MINUTE);
  assert.equal(half.calls.length, 6);
  const none = fixture({ttlMs: 5 * MINUTE, certain: 'human', awayMinutes: 0, pricing: cheapRead});
  await none.arm();
  assert.equal(none.keeper.state(who), undefined);
  await run(30 * MINUTE);
  assert.equal(none.calls.length, 0);
}));

test('human away: a 1h cache with a 60-minute budget never needs a warm-up, a longer budget does', withClock(async () => {
  const hour = fixture({ttlMs: LONG_CACHE_MS, certain: 'human', awayMinutes: 60, pricing: cheapRead});
  await hour.arm();
  assert.equal(hour.keeper.state(who), undefined, 'nothing is planned');
  await run(2 * 60 * MINUTE, 60_000);
  assert.equal(hour.calls.length, 0);
  const longer = fixture({ttlMs: LONG_CACHE_MS, certain: 'human', awayMinutes: 150, pricing: cheapRead});
  await longer.arm(); await run(3 * 60 * MINUTE, 60_000);
  assert.equal(longer.calls.length, 2, 'the cache is renewed twice to cover 150 minutes');
}));

test('human away: the cumulative-cost stop still applies, and a wait that is no longer certain stops warming', withClock(async () => {
  const dear = fixture({ttlMs: 5 * MINUTE, certain: 'human', awayMinutes: 240});
  await dear.arm(); await run(240 * MINUTE);
  assert.equal(dear.calls.length, 11, 'eleven warm-ups cost one miss');
  const over = fixture({ttlMs: 5 * MINUTE, certain: 'human', awayMinutes: 60, pricing: cheapRead});
  await over.arm(); await run(10 * MINUTE);
  const before = over.calls.length;
  over.state.certain = false;
  await run(30 * MINUTE);
  assert.equal(over.calls.length, before, 'a companion (or a Director with work in flight) is never warmed for the human');
}));

test('a real request ends the stretch and a new one starts a fresh budget and cost count', withClock(async () => {
  const f = fixture({ttlMs: 5 * MINUTE, certain: 'human', awayMinutes: 10, pricing: cheapRead});
  await f.arm(); await run(4.6 * MINUTE);
  assert.equal(f.calls.length, 1);
  f.keeper.wake(who);
  assert.equal(f.keeper.state(who), undefined);
  await run(10 * MINUTE);
  assert.equal(f.calls.length, 1);
  await f.arm();
  assert.equal(f.keeper.state(who)?.spent, 0);
  assert.equal(f.keeper.touchedAt(who), Date.now(), 'the keeper remembers when the cache was last refreshed');
}));

test('away_keepalive_minutes: defaults to 60, accepts 0, rejects negatives, and a /settings choice overrides the TOML', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-away-')), cwd = await mkdtemp(join(tmpdir(), 'logox-away-cwd-'));
  try {
    const quiet = () => {};
    assert.equal((await loadConfig(cwd, {}, {}, home, undefined, quiet)).kernel.away_keepalive_minutes, 60);
    assert.equal((await loadConfig(cwd, {kernel: {away_keepalive_minutes: 0}}, {}, home, undefined, quiet)).kernel.away_keepalive_minutes, 0);
    await assert.rejects(loadConfig(cwd, {kernel: {away_keepalive_minutes: -1}}, {}, home, undefined, quiet));
    await mkdir(join(home, '.logox'), {recursive: true});
    await writeFile(join(home, '.logox', 'config.toml'), '[kernel]\naway_keepalive_minutes = 90\ncache_keepalive = true\n');
    assert.equal((await loadConfig(cwd, {}, {}, home, undefined, quiet)).kernel.away_keepalive_minutes, 90);
    await writeFile(join(home, '.logox', 'kernel-preferences.json'), JSON.stringify({version: 1, away_keepalive_minutes: 15, cache_keepalive: false}));
    const saved = (await loadConfig(cwd, {}, {}, home, undefined, quiet)).kernel;
    assert.equal(saved.away_keepalive_minutes, 15); assert.equal(saved.cache_keepalive, false);
    assert.equal(kernelPreferenceSchema.safeParse({version: 1, away_keepalive_minutes: -5}).success, false);
  } finally {await rm(home, {recursive: true, force: true}); await rm(cwd, {recursive: true, force: true});}
});
