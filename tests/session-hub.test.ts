import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createSessionHub, SessionHubError} from '../src/session-hub.js';
import type {SessionHub} from '../src/session-hub.js';
import {loadConfig} from '../src/config/config.js';
import {finalizingProvider} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';
import {InputRejected} from '../src/runtime/input-rejected.js';
import type {Provider} from '../src/runtime/messages.js';

const completed: Provider = {async respond() {return {stop: 'complete', message: {role: 'assistant', text: '完成'}};}};
const finishing: Provider = {async respond(request, delta, signal) {
  const turn = await completed.respond(request, delta, signal);
  return finalizingProvider({async respond() {return turn;}}).respond(request, delta, signal);
}};
async function fixture(provider: Provider = finishing) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-hub-')));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const hub = await createSessionHub({cwd, config, provider, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json')});
  return {cwd, hub, async cleanup() {await hub.shutdown(); await rm(cwd, {recursive: true, force: true});}};
}
async function settled(hub: SessionHub, id: string) {
  const handle = hub.getSession(id)!;
  return waitFor(() => handle.getSnapshot(), snapshot => snapshot.activities.length > 0 && snapshot.activities.every(activity => ['completed', 'failed', 'cancelled'].includes(activity.status)), {label: 'session ' + id + ' settled'});
}
function summary(hub: SessionHub, id: string) {
  return hub.getSnapshot().sessions.find(item => item.id === id)!;
}

test('two sessions run side by side; views, actions and lifecycle stay per session', async () => {
  let active = 0, peak = 0;
  const slow: Provider = {async respond() {active++; peak = Math.max(peak, active); await delay(25); active--; return {stop: 'complete', message: {role: 'assistant', text: '完成'}};}};
  const f = await fixture(slow);
  try {
    const [a, b] = await Promise.all([f.hub.create(), f.hub.create()]);
    assert.notEqual(a.id, b.id);
    assert.equal(f.hub.getSession(a.id), a);
    assert.equal(f.hub.getSession('missing'), undefined);
    assert.equal(summary(f.hub, a.id).persistent, false);
    assert.equal(summary(f.hub, b.id).state, 'open');

    let aUpdates = 0;
    const stopA = a.subscribe(() => {aUpdates++;});
    await Promise.all([f.hub.submit(a.id, '任务 A'), f.hub.submit(b.id, '任务 B')]);
    await Promise.all([settled(f.hub, a.id), settled(f.hub, b.id)]);
    assert.ok(peak >= 2, 'sessions are not serialized by a global submit lock');
    stopA();
    const before = aUpdates;
    await f.hub.submit(b.id, 'B 继续');
    await settled(f.hub, b.id);
    assert.equal(aUpdates, before, 'an unsubscribed view stays independent of the other session');
    assert.ok(a.getSnapshot().messages.some(message => message.text === '任务 A'));
    assert.ok(!a.getSnapshot().messages.some(message => message.text === 'B 继续'));

    await f.hub.rename(a.id, '  标题 A  ');
    assert.equal(summary(f.hub, a.id).title, '标题 A');
    assert.equal(summary(f.hub, b.id).title, '任务 B');
    await assert.rejects(f.hub.rename(b.id, '   '), InputRejected);
    await assert.rejects(f.hub.rename(b.id, 'x'.repeat(101)), InputRejected);

    await f.hub.close(a.id);
    assert.equal(f.hub.getSession(a.id), undefined);
    assert.equal(f.hub.getSession(b.id), b);
    assert.equal(summary(f.hub, a.id).state, 'available');
    assert.equal(summary(f.hub, a.id).persistent, true);
    await f.hub.submit(b.id, 'B 关闭 A 后继续');
    await settled(f.hub, b.id);
    await f.hub.close(a.id); // idempotent

    const reopened = await f.hub.open(a.id);
    assert.equal(reopened.id, a.id);
    assert.ok(reopened.getSnapshot().messages.some(message => message.text === '任务 A'));
    assert.equal(summary(f.hub, a.id).state, 'open');
    await assert.rejects(f.hub.open('does-not-exist'), (error: unknown) => error instanceof SessionHubError && error.code === 'SESSION_NOT_FOUND');
    await assert.rejects(f.hub.submit(a.id, '/new'), InputRejected);
    await assert.rejects(f.hub.submit(a.id, '/login'), InputRejected);
  } finally {await f.cleanup();}
});

test('open coalesces, closing blocks new work, and shutdown closes every session once', async () => {
  const f = await fixture();
  try {
    const first = await f.hub.create();
    await f.hub.submit(first.id, '保存历史');
    await settled(f.hub, first.id);
    await f.hub.close(first.id);

    const [one, two] = await Promise.all([f.hub.open(first.id), f.hub.open(first.id)]);
    assert.equal(one, two, 'concurrent opens return the same handle');
    assert.equal(summary(f.hub, first.id).state, 'open');

    const closing = f.hub.close(first.id);
    await assert.rejects(f.hub.open(first.id), (error: unknown) => error instanceof SessionHubError && error.code === 'SESSION_CLOSING');
    await assert.rejects(f.hub.submit(first.id, '不应派发'), (error: unknown) => error instanceof SessionHubError && error.code === 'SESSION_CLOSING');
    await closing;

    const second = await f.hub.create(), third = await f.hub.create();
    await f.hub.rename(second.id, '空白时命名');
    assert.equal(summary(f.hub, second.id).persistent, false, 'renaming alone never persists a blank session');
    await f.hub.submit(second.id, '第一条任务');
    await settled(f.hub, second.id);
    assert.equal(summary(f.hub, second.id).title, '空白时命名', 'the first task keeps the chosen title');
    assert.equal(summary(f.hub, second.id).persistent, true);
    const revision = f.hub.getSnapshot().revision;
    const stable = f.hub.getSnapshot();
    assert.equal(f.hub.getSnapshot(), stable, 'the list snapshot is stable while nothing changes');
    f.hub.noteDraft(second.id);
    assert.equal(f.hub.getSnapshot().revision, revision, 'a draft does not republish the list');
    await f.hub.shutdown();
    await f.hub.shutdown();
    assert.equal(f.hub.getSession(second.id), undefined);
    assert.equal(f.hub.getSession(third.id), undefined);
    await assert.rejects(f.hub.create(), (error: unknown) => error instanceof SessionHubError && error.code === 'HUB_CLOSED');
    await writeFile(join(f.cwd, 'after.txt'), 'ok');
  } finally {await rm(f.cwd, {recursive: true, force: true});}
});
