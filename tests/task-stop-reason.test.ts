import test from 'node:test';
import assert from 'node:assert/strict';
import {ExecutionRecoveryError} from '../src/kernel/execution-recovery.js';
import {ProviderError} from '../src/providers/http.js';
import {ActorRecovery, faultKey} from '../src/actors/recovery.js';
import {restartStopped} from '../src/actors/restart.js';
import {DIAGNOSTIC_LIMIT, diagnosticOf, isDeliberateStop, normalizeStopReason, stopReasonFor, STOP_REASONS} from '../src/runtime/stop-reason.js';
import {actorCall, barrier, delegationFixture} from './delegation-fixture.js';

test('every vocabulary maps to the one outcome in one place', () => {
  const table: [string, Parameters<typeof stopReasonFor>[0], string][] = [
    ['an ordinary completion', {status: 'completed'}, 'completed'],
    ['a completion ignores a stale cause', {status: 'completed', cause: 'user'}, 'completed'],
    ['Esc', {status: 'cancelled', cause: 'user'}, 'cancelled_by_user'],
    ['CancelActor', {status: 'cancelled', cause: 'director_cancel'}, 'cancelled_by_director'],
    ['a graceful quit', {status: 'cancelled', cause: 'shutdown'}, 'shutdown'],
    ['a crash recovery', {status: 'cancelled', cause: 'interrupted'}, 'interrupted'],
    ['a cancel with no known cause', {status: 'cancelled'}, 'interrupted'],
    ['an outcome value passes through', {status: 'cancelled', cause: 'cancelled_by_director'}, 'cancelled_by_director'],
    ['any other failure', {status: 'failed', error: new Error('boom')}, 'error'],
    ['a provider error', {status: 'failed', error: new ProviderError('down', true, 'temporary')}, 'error'],
    ['an Automa stall', {status: 'failed', stalled: true}, 'stalled'],
    ['a length stop', {status: 'failed', length: true}, 'max_tokens'],
    ['repeated truncated text', {status: 'failed', error: new ExecutionRecoveryError('truncated_text', 'handoff')}, 'max_tokens'],
    ['repeated truncated tool arguments', {status: 'failed', error: new ExecutionRecoveryError('truncated_tools', 'stop')}, 'max_tokens'],
    ['a model that delivered nothing', {status: 'failed', error: new ExecutionRecoveryError('no_delivery', 'handoff')}, 'stalled'],
    ['a call written as text', {status: 'failed', error: new ExecutionRecoveryError('text_tool_call', 'stop')}, 'error'],
    ['a provider refusal', {status: 'failed', error: new ProviderError('blocked', false, 'protocol', {code: 'refusal'})}, 'refusal'],
    ['a content filter', {status: 'failed', error: new ProviderError('blocked', false, 'protocol', {code: 'content_filter'})}, 'refusal'],
  ];
  for (const [label, input, expected] of table) assert.equal(stopReasonFor(input), expected, label);
  assert.deepEqual([...STOP_REASONS], ['completed', 'cancelled_by_user', 'cancelled_by_director', 'interrupted', 'shutdown', 'error', 'max_tokens', 'refusal', 'stalled']);
});

test('stored values are read in both vocabularies', () => {
  assert.deepEqual(['user', 'director_cancel', 'shutdown', 'interrupted', 'completed', 'stalled', 'nonsense', undefined].map(value => normalizeStopReason(value)),
    ['cancelled_by_user', 'cancelled_by_director', 'shutdown', 'interrupted', 'completed', 'stalled', undefined, undefined]);
  assert.equal(restartStopped({status: 'cancelled', stopReason: 'interrupted'}), true);
  assert.equal(restartStopped({status: 'cancelled', stopReason: 'shutdown'}), true);
  assert.equal(restartStopped({status: 'cancelled', stopReason: 'user'}), false);
  assert.equal(restartStopped({status: 'cancelled', stopReason: 'cancelled_by_user'}), false);
  assert.equal(restartStopped({status: 'failed', stopReason: 'shutdown'}), false);
  assert.deepEqual(['cancelled_by_user', 'shutdown', 'error', 'completed'].map(value => isDeliberateStop(value as never)), [true, true, false, false]);
});

test('the diagnostic is one short line without secrets, and only for errors', () => {
  const secret = new Error('Request failed\nAuthorization: Bearer abcdefghijklmnop1234\nkey sk-live_1234567890abcdef used; api_key=hunter2hunter2');
  assert.equal(diagnosticOf('error', secret), 'Request failed');
  assert.equal(diagnosticOf('error', new Error('bad key sk-live_1234567890abcdef in the call')), 'bad key [redacted] in the call');
  assert.equal(diagnosticOf('error', new Error('token: abcdef123456 was rejected')), '[redacted] was rejected');
  const long = diagnosticOf('error', new Error('x '.repeat(400)))!;
  assert.ok(long.length <= DIAGNOSTIC_LIMIT && long.endsWith('…'), long.length + '');
  assert.equal(diagnosticOf('completed', new Error('late')), undefined);
  assert.equal(diagnosticOf('cancelled_by_user', new Error('Aborted')), undefined);
  assert.equal(diagnosticOf('error', undefined), undefined);
});

test('recovery classifies by the stop reason, not by the wording of the error', async () => {
  const recovery = new ActorRecovery('s');
  const refused = await recovery.next('root-a', new Error('The request was stopped'), undefined, 'refusal');
  const cut = await recovery.next('root-b', new Error('The request was stopped'), undefined, 'max_tokens');
  assert.notEqual(refused.key, cut.key, 'same text, different stop reason, different class');
  assert.deepEqual([refused.key, cut.key], ['stop:refusal', 'stop:max_tokens']);
  const reworded = await recovery.next('root-a', new Error('A completely different sentence'), undefined, 'refusal');
  assert.equal(reworded.key, refused.key, 'different text, same stop reason, same class');
  assert.equal(reworded.attempt, 2, 'and the same budget');
  const third = await recovery.next('root-a', new Error('Yet another wording'), undefined, 'refusal');
  assert.equal(third.exhausted, true);
  // Without a classifying stop reason the old rule still applies: provider category, else the error text.
  assert.equal(faultKey(new Error('same'), 'error'), faultKey(new Error('same')));
  assert.notEqual(faultKey(new Error('one')), faultKey(new Error('two')));
  assert.equal(faultKey(new ProviderError('x', true, 'temporary', {status: 503}), 'error'), 'provider:temporary:request');
  assert.equal(faultKey(new ProviderError('x', true, 'temporary'), 'max_tokens'), 'stop:max_tokens', 'a named class wins over the provider category');
});

test('an old journal without the field loads, and a checkpoint keeps the new reason and diagnostic', async () => {
  const f = await delegationFixture(async () => {});
  try {
    const base = {ownerId: 'techne', prompt: 'p', source: 'logox', time: 1};
    await f.journal.checkpoint('s', {...base, activityId: 'old-none', status: 'failed'});
    await f.journal.checkpoint('s', {...base, activityId: 'old-user', status: 'cancelled', stopReason: 'user'});
    await f.journal.checkpoint('s', {...base, activityId: 'new', status: 'failed', stopReason: 'max_tokens', diagnostic: 'cut off'});
    const tasks = await f.journal.tasks('s');
    const by = (id: string) => tasks.find(task => task.activityId === id)!;
    assert.deepEqual([by('old-none').stopReason, by('old-none').diagnostic], [undefined, undefined]);
    assert.equal(normalizeStopReason(by('old-user').stopReason), 'cancelled_by_user');
    assert.deepEqual([by('new').stopReason, by('new').diagnostic], ['max_tokens', 'cut off']);
  } finally {await f.close();}
});

test('a settled activity, its checkpoint and the Director report carry the outcome and the short diagnostic', async () => {
  const f = await delegationFixture(async (prompt, context, services) => {
    if (prompt === 'start') {await services.execute(actorCall([{ownerId: 'techne', prompt: 'fine', title: 'Fine'}, {ownerId: 'kalon', prompt: 'break', title: 'Broken'}]), context); return;}
    if (prompt === 'again') {await services.execute(actorCall([{ownerId: 'aletheia', prompt: 'cut', title: 'Cut'}]), context); return;}
    if (prompt.startsWith('break')) throw new Error('Gateway rejected key sk-live_1234567890abcdef\nsecond line');
    if (prompt.startsWith('cut')) throw new ExecutionRecoveryError('truncated_text', 'handoff');
    context.say('done');
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    await f.idle();
    await f.ensemble.dispatch('logox', 'again', 'direct').done;
    await f.idle();
    const find = (owner: string) => f.store.getSnapshot().activities.find(activity => activity.ownerId === owner)!;
    const [fine, broken, cut] = [find('techne'), find('kalon'), find('aletheia')];
    assert.deepEqual([fine.status, fine.stopReason, fine.diagnostic], ['completed', 'completed', undefined]);
    assert.equal(typeof fine.startedAt, 'number'); assert.equal(typeof fine.finishedAt, 'number');
    assert.deepEqual([broken.status, broken.stopReason, broken.diagnostic], ['failed', 'error', 'Gateway rejected key [redacted]']);
    assert.deepEqual([cut.status, cut.stopReason], ['failed', 'max_tokens']);
    const saved = await f.journal.tasks('s');
    assert.deepEqual(['techne', 'kalon', 'aletheia'].map(owner => saved.find(task => task.ownerId === owner && task.status !== 'queued' && task.status !== 'running')?.stopReason), ['completed', 'error', 'max_tokens']);
    assert.equal(saved.find(task => task.ownerId === 'kalon')?.diagnostic, 'Gateway rejected key [redacted]');
    const texts = f.services.deliveries.snapshot().map(item => item.text);
    assert.ok(texts.some(text => text.includes('(failed)\nStop reason: error')), 'the failure report says it');
    assert.ok(texts.some(text => text.includes('(failed)\nStop reason: max_tokens')));
    assert.ok(texts.some(text => text.includes('(completed)\nStop reason: completed')), 'and so does a completed report');
    const notices = f.store.getSnapshot().messages.filter(message => message.role === 'notice').map(message => message.text);
    assert.ok(notices.some(text => /Kalon \(kalon\) activity \S+ failed \(stop: error\)/.test(text)), notices.join('\n'));
  } finally {await f.close();}
});

test('a user stop and a Director cancel settle as their own outcomes', async () => {
  const running = barrier();
  const f = await delegationFixture(async (prompt, context, services) => {
    if (prompt === 'start') {await services.execute(actorCall([{ownerId: 'techne', prompt: 'wait one'}, {ownerId: 'kalon', prompt: 'wait two'}]), context); return;}
    if (!prompt.startsWith('wait')) return;
    running.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true}));
    context.signal.throwIfAborted();
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    await running.promise;
    const techne = f.store.getSnapshot().activities.find(activity => activity.ownerId === 'techne')!, kalon = f.store.getSnapshot().activities.find(activity => activity.ownerId === 'kalon')!;
    f.ensemble.cancel(techne.activityId, 'user');
    f.ensemble.cancel(kalon.activityId, 'director_cancel', 'no longer needed');
    await f.idle();
    assert.equal(f.store.activities.get('s', techne.activityId)?.stopReason, 'cancelled_by_user');
    assert.equal(f.store.activities.get('s', kalon.activityId)?.stopReason, 'cancelled_by_director');
    const saved = await f.journal.tasks('s');
    assert.equal(saved.find(task => task.activityId === techne.activityId && task.status === 'cancelled')?.stopReason, 'cancelled_by_user');
  } finally {await f.close();}
});

test('a task cancelled before it started settles with its outcome', async () => {
  const hold = barrier();
  const f = await delegationFixture(async (prompt, context, services) => {
    if (prompt === 'start') {await services.execute(actorCall([{ownerId: 'techne', prompt: 'first', title: 'First'}]), context); return;}
    await hold.promise;
  });
  try {
    await f.ensemble.dispatch('logox', 'start', 'direct').done;
    const queued = f.ensemble.dispatch('techne', 'second', 'direct');
    assert.equal(f.store.activities.get('s', queued.activityId)?.status, 'queued');
    f.ensemble.cancel(queued.activityId, 'director_cancel', 'not needed');
    assert.equal(f.store.activities.get('s', queued.activityId)?.stopReason, 'cancelled_by_director');
    hold.resolve(); await f.idle();
  } finally {hold.resolve(); await f.close();}
});
