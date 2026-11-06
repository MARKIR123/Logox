import test from 'node:test';
import assert from 'node:assert/strict';
import {costOf, modelPrice, priceFor} from '../src/context/cost.js';
import {parseGitStatus, GitStatusSource} from '../src/extensions/git-status.js';
import {windowState} from '../src/application-status.js';
import {TaskModels} from '../src/actors/task-models.js';
import {statusbarText} from '../src/tui/status/statusbar.js';
import {statusbarIds} from '../src/config/statusbar-preferences.js';
import type {StageStatus} from '../src/runtime/stage-status.js';
import type {UsageRecord} from '../src/context/budget.js';
import type {RuntimeStore} from '../src/runtime/store.js';

const record = (model: string, extra: Partial<UsageRecord> = {}): UsageRecord =>
  ({id: Math.random().toString(36), model, category: 'task', input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, ...extra});
const base: StageStatus = {ownerId: 'logox', name: 'Logox', state: 'Ready', model: {provider: 'p', model: 'm'}, effort: 'high', permission: 'default'};
const only = (id: typeof statusbarIds[number]) => [{id, enabled: true}];

test('cost: prices come from one lookup (configured prices); models without a price have none', () => {
  assert.equal(modelPrice({models: {'x/y': {prices: {currency: 'EUR', input: 1}}}} as never, 'x', 'y')?.currency, 'EUR');
  assert.equal(priceFor({models: {'x/y': {prices: {currency: 'EUR', input: 1}}}} as never, 'x/y')?.currency, 'EUR');
  assert.equal(priceFor({models: {}} as never, 'local/some-new-model'), undefined);
  assert.equal(costOf([record('local/some-new-model')], {models: {}} as never), undefined);
});

test('cost: missing cache rates bill as input and mark the figure partial; fully priced usage is exact', () => {
  const config = {models: {'p/m': {prices: {currency: 'USD', input: 2, output: 10}}}} as never;
  const partial = costOf([record('p/m', {cacheRead: 400_000})], config)!;
  assert.equal(partial.partial, true);
  // 600k fresh + 400k cache at the input rate = 1M * 2 USD, plus 100k output * 10 USD.
  assert.ok(Math.abs(partial.amount - 3) < 1e-9);
  const exact = costOf([record('p/m')], config)!;
  assert.equal(exact.partial, false);
});

test('cost: subscription providers are skipped and unpriced usage marks partial', () => {
  const config = {models: {'p/m': {prices: {currency: 'USD', input: 1, output: 1}}}} as never;
  assert.equal(costOf([record('oauth/m')], config, provider => provider === 'oauth'), undefined);
  const mixed = costOf([record('p/m'), record('mystery/x')], config)!;
  assert.equal(mixed.partial, true);
});

test('statusbar: cost hides itself without a price and marks a partial figure', () => {
  assert.equal(statusbarText(base, 60, only('cost')), '');
  assert.match(statusbarText({...base, cost: 1.5, costCurrency: 'USD', costPartial: true}, 60, only('cost')), /Session cost ~USD 1\.5000/);
});

test('statusbar: tokens label states what is shown (session total)', () => {
  assert.match(statusbarText({...base, tokens: 12345}, 60, only('tokens')), /Session tokens 12,345/);
});

test('statusbar: context never rounds 99.6 up to 100 and flags overruns and estimates', () => {
  const context = (tokens: number, extra: object = {}): StageStatus => ({...base, context: {tokens, window: 1000, estimated: false, over: false, ...extra}});
  assert.match(statusbarText(context(996), 80, only('context')), /99% USED/);
  assert.match(statusbarText(context(1000), 80, only('context')), /[^>~]100% USED/);
  assert.match(statusbarText(context(1400, {over: true}), 80, only('context')), />100% USED/);
  assert.match(statusbarText(context(500, {estimated: true}), 80, only('context')), /~50% USED/);
  assert.match(statusbarText(context(500), 80, only('context')), /[^~>]50% USED/);
});

test('statusbar: git module is data only, hidden outside a repository', () => {
  assert.equal(statusbarText(base, 60, only('git')), '');
  const text = statusbarText({...base, git: {branch: 'main', dirty: 3, ahead: 1, behind: 2}}, 60, only('git'));
  assert.match(text, /main ●3 ↑1 ↓2/);
});

test('statusbar: effort distinguishes a lookup failure from an unsupported model', () => {
  assert.match(statusbarText({...base, effort: 'Unsupported'}, 60, only('effort')), /unsupported/);
  assert.match(statusbarText({...base, effort: 'Unavailable', effortError: 'No provider'}, 60, only('effort')), /unavailable/);
});

test('git: porcelain v2 output parses branch, dirty count and divergence', () => {
  const out = ['# branch.oid abcdef1234', '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 a b src/a.ts', '? new.txt', '2 R. N... 100644 100644 100644 a b R100 b.ts\ta.ts'].join('\n');
  assert.deepEqual(parseGitStatus(out), {branch: 'feature/x', dirty: 3, ahead: 2, behind: 1});
  assert.deepEqual(parseGitStatus('# branch.oid 1234567890\n# branch.head (detached)\n'), {branch: '1234567', dirty: 0, ahead: 0, behind: 0});
  assert.equal(parseGitStatus(''), undefined);
});

test('git: source caches, notifies only on change, and shows nothing for a non-repository', async () => {
  let output: string | undefined = '# branch.head main\n';
  let changes = 0, reads = 0;
  const source = new GitStatusSource('/x', () => {changes++;}, async () => {reads++; return output;});
  await source.refresh();
  assert.equal(source.get()?.branch, 'main');
  await source.refresh();
  assert.equal(changes, 1, 'an unchanged value does not notify');
  output = undefined;
  await source.refresh();
  assert.equal(source.get(), undefined);
  assert.equal(changes, 2);
  assert.equal(reads, 3);
  source.close();
});

const fakeStore = (activities: object[], interactions: object[] = []) =>
  ({getSnapshot: () => ({activities, interactions})}) as unknown as RuntimeStore;
const act = (ownerId: string, status: string, kind = 'actor') => ({ownerId, status, kind, activityId: ownerId + status});

test('state: keeps the last terminal state, distinguishes approval from question, and shows companions for the Director', () => {
  assert.equal(windowState(fakeStore([]), 'techne'), 'Ready');
  assert.equal(windowState(fakeStore([act('techne', 'completed')]), 'techne'), 'Completed');
  assert.equal(windowState(fakeStore([act('techne', 'failed')]), 'techne'), 'Failed');
  assert.equal(windowState(fakeStore([act('techne', 'cancelled')]), 'techne'), 'Stopped');
  assert.equal(windowState(fakeStore([act('techne', 'waiting_input')], [{ownerId: 'techne', status: 'pending', kind: 'permission'}]), 'techne'), 'Awaiting permission');
  assert.equal(windowState(fakeStore([act('techne', 'waiting_input')], [{ownerId: 'techne', status: 'pending', kind: 'question'}]), 'techne'), 'Awaiting answer');
  assert.equal(windowState(fakeStore([act('logox', 'completed', 'director'), act('techne', 'running'), act('kalon', 'queued')]), 'logox'), 'Waiting on 2 actors');
  assert.equal(windowState(fakeStore([act('techne', 'running')]), 'logox'), 'Waiting on 1 actor');
  assert.equal(windowState(fakeStore([act('logox', 'running', 'director'), act('techne', 'running')]), 'logox'), 'Running');
});

test('idle model selection follows actor model overrides and the unregistered-provider fallback', () => {
  const registry = {names: () => ['main'], selection: () => ({provider: 'main', model: 'session'})};
  let override: {provider: string; model: string} | undefined = {provider: 'main', model: 'override'};
  const models = new TaskModels({registry: registry as never, defaultModel: owner => owner === 'techne' ? override : undefined,
    defaultFallbackModel: () => ({provider: 'main', model: 'fallback'})});
  assert.deepEqual(models.idleSelection('techne'), {provider: 'main', model: 'override'});
  override = {provider: 'gone', model: 'x'};
  assert.deepEqual(models.idleSelection('techne'), {provider: 'main', model: 'fallback'});
  assert.deepEqual(models.idleSelection('logox'), {provider: 'main', model: 'session'});
});
