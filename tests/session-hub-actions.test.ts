import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSessionHub} from '../src/session-hub.js';
import {loadConfig} from '../src/config/config.js';
import {waitFor} from './wait-for.js';
import type {Provider} from '../src/runtime/messages.js';
import type {Activity, Interaction} from '../src/runtime/contracts.js';

const tool = (command: string) => ({id: 'same-call', name: 'shell', arguments: JSON.stringify({command})});
function scripted(command: string): Provider {
  return {async respond(request) {
    const finished = request.messages.some(message => message.role === 'tool');
    return finished ? {stop: 'complete', message: {role: 'assistant', text: '完成'}}
      : {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [tool(command)]}};
  }};
}
async function fixture(provider: Provider, mode: 'default' | 'creative' = 'default') {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-hub-actions-')));
  const config = await loadConfig(cwd, {permissions: {mode}, provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const hub = await createSessionHub({cwd, config, provider, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json')});
  return {cwd, hub, async cleanup() {await hub.shutdown(); await rm(cwd, {recursive: true, force: true, maxRetries: 100, retryDelay: 100});}};
}
const pending = (items: readonly Interaction[]) => items.find(item => item.kind === 'permission' && item.status === 'pending');
const openActivity = (items: readonly Activity[]) => items.find(item => ['running', 'waiting_input'].includes(item.status));

test('approvals and answers are addressed to their session; a project rule re-evaluates every session', async () => {
  const f = await fixture(scripted('node -e "process.exit(0)"'));
  try {
    const [a, b] = await Promise.all([f.hub.create(), f.hub.create()]);
    await Promise.all([f.hub.submit(a.id, 'A 写入'), f.hub.submit(b.id, 'B 写入')]);
    const snapA = await waitFor(() => a.getSnapshot(), snapshot => Boolean(pending(snapshot.interactions)), {label: 'A pending approval'});
    const snapB = await waitFor(() => b.getSnapshot(), snapshot => Boolean(pending(snapshot.interactions)), {label: 'B pending approval'});
    const askA = pending(snapA.interactions)!, askB = pending(snapB.interactions)!;
    assert.equal(askA.sessionId, a.id); assert.equal(askB.sessionId, b.id);

    const answer = {kind: 'permission' as const, sessionId: a.id, activityId: askA.activityId, ownerId: askA.ownerId, requestId: askA.requestId, decision: 'allow_session' as const};
    assert.equal(f.hub.respond(b.id, answer).ok, false, 'A request cannot be answered through B');
    assert.equal(f.hub.respond(a.id, {...answer, sessionId: b.id}).ok, false, 'an answer naming another session is refused');
    assert.equal(f.hub.respond(a.id, answer).ok, true);
    assert.equal(f.hub.respond(a.id, answer).ok, false, 'a duplicate answer is stale');
    await waitFor(() => a.getSnapshot(), snapshot => !openActivity(snapshot.activities), {label: 'A completes'});
    assert.ok(pending(b.getSnapshot().interactions), "A's session grant never re-evaluates B's pending approval");

    // The same command in A is now covered by its session grant; B still has no grant.
    await f.hub.submit(a.id, 'A 再次写入');
    await waitFor(() => a.getSnapshot(), snapshot => !openActivity(snapshot.activities), {label: 'A second run completes'});
    assert.equal(pending(a.getSnapshot().interactions), undefined);
    assert.ok(pending(b.getSnapshot().interactions), 'B never inherits the session grant of A');

    // A project-wide rule is shared: it cancels B's pending approval and lets B re-evaluate to completion.
    await f.hub.submit(a.id, '/permissions add project allow shell *');
    await waitFor(() => b.getSnapshot(), snapshot => !openActivity(snapshot.activities), {label: 'B re-evaluated after the project rule'});
    assert.equal(pending(b.getSnapshot().interactions), undefined);
    assert.ok(b.getSnapshot().messages.some(message => message.role === 'assistant' && message.text === '完成'));
  } finally {await f.cleanup();}
});

test('the same actor and tool call id in two sessions: one cancelTool stops only its own process', async () => {
  const f = await fixture(scripted('node -e "setTimeout(() => {}, 30000)"'), 'creative');
  try {
    const [a, b] = await Promise.all([f.hub.create(), f.hub.create()]);
    await Promise.all([f.hub.submit(a.id, 'A 长任务'), f.hub.submit(b.id, 'B 长任务')]);
    await waitFor(() => a.getSnapshot(), snapshot => snapshot.activities.some(activity => activity.phase === 'tool'), {label: 'A tool running'});
    await waitFor(() => b.getSnapshot(), snapshot => snapshot.activities.some(activity => activity.phase === 'tool'), {label: 'B tool running'});
    assert.equal(f.hub.cancelTool(a.id, 'same-call'), true);
    await waitFor(() => a.getSnapshot(), snapshot => !openActivity(snapshot.activities), {label: 'A settles after cancelTool'});
    const bRunning = openActivity(b.getSnapshot().activities);
    assert.ok(bRunning, "A's cancelTool did not kill B's identical call id");
    assert.equal(f.hub.cancelTool(b.id, 'same-call'), true);
    await waitFor(() => b.getSnapshot(), snapshot => !openActivity(snapshot.activities), {label: 'B settles after its own cancelTool'});
    assert.equal(f.hub.cancelTool(a.id, 'missing'), false);
  } finally {await f.cleanup();}
});


test('closing a running session cancels only its own work; the sibling keeps running', async () => {
  const f = await fixture(scripted('node -e "setTimeout(() => {}, 30000)"'), 'creative');
  try {
    const [a, b] = await Promise.all([f.hub.create(), f.hub.create()]);
    await Promise.all([f.hub.submit(a.id, 'A 长任务'), f.hub.submit(b.id, 'B 长任务')]);
    await waitFor(() => a.getSnapshot(), snapshot => snapshot.activities.some(activity => activity.phase === 'tool'), {label: 'A tool running'});
    const bTool = await waitFor(() => b.getSnapshot(), snapshot => Boolean(openActivity(snapshot.activities)), {label: 'B tool running'});
    await f.hub.close(a.id);
    assert.equal(f.hub.getSession(a.id), undefined);
    assert.equal(f.hub.getSession(b.id), b);
    assert.equal(f.hub.getSnapshot().sessions.find(item => item.id === a.id)?.state, 'available');
    assert.ok(openActivity(b.getSnapshot().activities), 'closing A did not cancel B');
    assert.equal(f.hub.cancel(b.id, openActivity(bTool.activities)!.activityId), true);
    await waitFor(() => b.getSnapshot(), snapshot => !openActivity(snapshot.activities), {label: 'B settles after cancel'});
  } finally {await f.cleanup();}
});


test('pending input can only be sent or discarded through its own session', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  let calls = 0;
  const provider: Provider = {async respond() {
    if (calls++ === 0) await gate;
    return {stop: 'complete', message: {role: 'assistant', text: '完成'}};
  }};
  const f = await fixture(provider);
  try {
    const [a, b] = await Promise.all([f.hub.create(), f.hub.create()]);
    await f.hub.submit(a.id, '@aletheia 第一');
    await waitFor(() => a.getSnapshot(), snapshot => snapshot.activities.some(activity => activity.ownerId === 'aletheia' && activity.status === 'running'), {label: 'A actor running'});
    await f.hub.submit(a.id, '@aletheia 第二条');
    const pending = await waitFor(() => a.getSnapshot(), snapshot => snapshot.pending[0]?.sessionId === a.id, {label: 'A has a pending input'});
    const item = pending.pending[0]!;
    assert.equal(await f.hub.sendPendingNow(b.id, item.id), false);
    assert.equal(f.hub.discardPending(b.id, item.id), undefined);
    assert.equal(f.hub.discardPending(a.id, item.id), '第二条');
    release();
    await waitFor(() => a.getSnapshot(), snapshot => !openActivity(snapshot.activities) && snapshot.pending.length === 0, {label: 'A settles'});
  } finally {release(); await f.cleanup();}
});
