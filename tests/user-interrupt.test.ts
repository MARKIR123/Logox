import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createTestApplication as createApplication, waitForSnapshot} from './runtime-fixture.js';
import {stopNotice} from '../src/actors/ensemble.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';
import {ProcessStoppedError, USER_STOP_REASON, killActiveProcess, runProcess} from '../src/tools/process.js';
import {executeShell} from '../src/tools/ShellTool/ShellTool.js';
import {SHELL_CUT_SHORT_LINE, SHELL_STOPPED_BY_USER} from '../src/tools/ShellTool/prompt.js';
import {DIRECTOR_INTERRUPTED_TOOL_TEXT, USER_INTERRUPTED_TOOL_TEXT, USER_INTERRUPT_MARKER, directorStopMarker, userInterruptMarkerWithWorking} from '../src/prompts/runtime/interruption.js';
import {deliberateStopLabel, summarizeRound} from '../src/context/contracts.js';
import {createRuntimeContextMessage} from '../src/runtime/context-updates.js';
import {repairToolResults} from '../src/runtime/messages.js';
import {palette} from '../src/tui/appearance/theme.js';
import {toolFixture, rowText} from './tool-fixture.js';

const node = process.execPath;
const chatter = 'process.stdout.write("partial-out\\n"); process.stderr.write("partial-err\\n"); setInterval(() => {}, 1000)';

test('a stopped process rejects with a typed error that keeps its partial output', {timeout: 10000}, async () => {
  const pending = runProcess(node, ['-e', chatter], process.cwd(), new AbortController().signal, 60_000, 64_000, undefined, undefined, {toolId: 'stop-1'});
  await delay(1200);
  assert.equal(killActiveProcess('stop-1', USER_STOP_REASON, 'user'), true);
  const error = await pending.then(() => undefined, caught => caught);
  assert.ok(error instanceof ProcessStoppedError);
  assert.equal(error.message, 'Stopped by user');
  assert.equal(error.by, 'user');
  assert.match(error.stdout, /partial-out/);
  assert.match(error.stderr, /partial-err/);
});

test('Shell stopped by the user returns the static notice plus the partial output; other kills keep their text', {timeout: 15000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-stop-'));
  const file = join(dir, 'chatter.js');
  await writeFile(file, chatter);
  const command = process.platform === 'win32' ? `& '${node}' '${file}'` : `'${node}' '${file}'`;
  const start = (by: string) => executeShell({command}, process.cwd(), new AbortController().signal, {toolId: 'sh-' + by}).then(value => ({value}), error => ({error}));
  const [userRun, directorRun, systemRun] = [start('user'), start('director'), start('system')];
  await delay(3500);
  killActiveProcess('sh-user', USER_STOP_REASON, 'user');
  killActiveProcess('sh-director', 'Wrong directory', 'director');
  killActiveProcess('sh-system', 'Terminated by timeout test', 'system');
  const [user, director, other] = await Promise.all([userRun, directorRun, systemRun]);
  assert.ok('value' in user);
  assert.equal(user.value.isError, true);
  assert.ok(user.value.text.startsWith(SHELL_STOPPED_BY_USER + '\n\n' + SHELL_CUT_SHORT_LINE + '\n'));
  assert.equal(SHELL_STOPPED_BY_USER, 'Stopped by user.\nThe user stopped this command while it was running; partial output is below.\nDo not rerun it on your own. Continue with what you have, or ask the user if you need the full run.');
  assert.match(user.value.text, /partial-out/);
  assert.match(user.value.text, /Stderr:\n[\s\S]*partial-err/);
  assert.ok('value' in director);
  assert.match(director.value.text, /^Stopped by Director\.[\s\S]*Reason given: Wrong directory[\s\S]*partial-out/);
  assert.ok('error' in other);
  assert.equal((other.error as Error).message, 'Terminated by timeout test');
  await rm(dir, {recursive: true, force: true});
});

test('the Shell card shows a user stop as a muted reason with the partial output, never error red', () => {
  const text = SHELL_STOPPED_BY_USER + '\n\n' + SHELL_CUT_SHORT_LINE + '\npartial-out\n\nStderr:\npartial-err';
  const card = toolFixture('Shell', {command: 'npm run dev'}, text, 'failed');
  const rows = card.rows();
  const header = rows.find(row => row.messageId === card.id)!;
  const reason = header.segments!.find(segment => segment.text === 'Stopped by user')!;
  assert.ok(reason, rowText(header));
  assert.equal(reason.color, palette.muted);
  assert.ok(!header.segments!.some(segment => segment.color === palette.error && segment.text.trim()), 'no error-coloured text in the header');
  assert.ok(!rowText(header).includes('Error'));
  assert.ok(rows.some(row => row.text.includes('partial-out')), rows.map(row => row.text).join('|'));
  assert.ok(!rows.some(row => row.text.includes('The user stopped this command')), 'the instruction to the model is not shown on the card');
});

function scripted(turns: Array<ModelTurn | ((request: ModelRequest) => ModelTurn)>, seen: ModelRequest[] = []): Provider {
  return {async respond(request) {
    seen.push(request);
    const next = turns.shift() ?? (seen.length > 2 ? done() : undefined);
    assert.ok(next, 'unexpected extra model request');
    return typeof next === 'function' ? next(request) : next;
  }};
}
const writeTurn = (): ModelTurn => ({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [
  {id: 'w1', name: 'write', arguments: JSON.stringify({file_path: 'x.txt', content: 'x'})},
  {id: 'r2', name: 'read', arguments: JSON.stringify({file_path: 'x.txt'})}]}});
const done = (): ModelTurn => ({stop: 'complete', message: {role: 'assistant', text: 'ok'}});

async function fixture(provider: Provider) {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-interrupt-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider});
  return {cwd, app, async cleanup() {await app.close(); await rm(cwd, {recursive: true, force: true});}};
}
const markers = (request: ModelRequest) => request.messages.filter(message => message.role === 'context' && message.kind === 'interruption');

test('Esc on a round: user-specific tool texts and exactly one [Interrupted by user] marker on the next request', {timeout: 20000}, async () => {
  const seen: ModelRequest[] = [];
  const f = await fixture(scripted([writeTurn(), done()], seen));
  try {
    const first = f.app.ensemble.dispatch('logox', 'write it');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    first.cancel();
    await first.done;
    const entries = await f.app.journal.load('test', 'logox');
    const tools = entries.filter(entry => entry.role === 'tool');
    assert.deepEqual(tools.map(entry => entry.text), [USER_INTERRUPTED_TOOL_TEXT, USER_INTERRUPTED_TOOL_TEXT]);
    const marker = entries.filter(entry => entry.message?.role === 'context' && entry.message.kind === 'interruption');
    assert.equal(marker.length, 1);
    assert.ok(marker[0]!.text.startsWith('[Interrupted by user]'));
    assert.equal(marker[0]!.text, USER_INTERRUPT_MARKER);
    assert.equal(f.app.store.activities.get('test', first.activityId)?.stopReason, 'user');
    await f.app.ensemble.dispatch('logox', 'continue').done;
    const next = seen.at(-1)!;
    assert.equal(markers(next).length, 1);
    const index = next.messages.findIndex(message => message.role === 'context' && message.kind === 'interruption');
    assert.equal(next.messages[index]!.text, USER_INTERRUPT_MARKER);
    assert.equal(next.messages.at(-1)!.text, 'continue');
    assert.ok(index < next.messages.length - 1, 'the marker precedes the next user message');
    const rounds = await f.app.journal.rounds('test', 'logox', await f.app.journal.load('test', 'logox'));
    assert.equal(rounds.find(round => round.activityId === first.activityId)?.summary.title, 'Interrupted by user');
  } finally {await f.cleanup();}
});

test('Director stopping an actor tells the actor "Stopped by Director" with the reason', {timeout: 20000}, async () => {
  const seen: ModelRequest[] = [];
  const f = await fixture(scripted([writeTurn(), done()], seen));
  try {
    const first = f.app.ensemble.dispatch('techne', 'write it');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    assert.equal(f.app.ensemble.cancelActor('techne', 'activity', undefined, 'Wrong approach, use the adapter').success, true);
    await first.done;
    const entries = await f.app.journal.load('test', 'techne');
    assert.deepEqual(entries.filter(entry => entry.role === 'tool').map(entry => entry.text), [DIRECTOR_INTERRUPTED_TOOL_TEXT, DIRECTOR_INTERRUPTED_TOOL_TEXT]);
    const marker = entries.filter(entry => entry.message?.role === 'context' && entry.message.kind === 'interruption');
    assert.equal(marker.length, 1);
    assert.equal(marker[0]!.text, directorStopMarker('Wrong approach, use the adapter'));
    assert.ok(marker[0]!.text.startsWith('[Stopped by Director]'));
    assert.ok(!marker[0]!.text.includes('Interrupted by user'));
    await f.app.ensemble.dispatch('techne', 'next').done;
    assert.equal(markers(seen[1]!).length, 1);
  } finally {await f.cleanup();}
});

test('recovery wording for crashed runs is unchanged and only deliberate stops relabel the round', () => {
  const call = {id: 'c1', name: 'Shell', arguments: '{}'};
  const repaired = repairToolResults([{role: 'assistant', text: '', toolCalls: [call]}]);
  assert.equal(repaired[0]!.text, 'The previous run was interrupted and this tool has no complete result. Re-check the current state before deciding the next step.');
  assert.equal(summarizeRound([{role: 'user', text: 'go'}], 'cancelled').title, 'Interrupted; follow-up work needs checking');
  assert.equal(deliberateStopLabel([]), undefined);
  const marker = createRuntimeContextMessage('interruption', USER_INTERRUPT_MARKER, {by: 'user'});
  assert.equal(deliberateStopLabel([marker]), 'Interrupted by user');
  assert.equal(summarizeRound([{role: 'user', text: 'go'}, marker], 'cancelled').title, 'Interrupted by user');
});

test('the marker is a hidden ledger note: no timeline row live or after the session is restored', {timeout: 20000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-interrupt-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const open = () => createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'test', config, provider: scripted([writeTurn()])});
  const first = await open();
  try {
    const handle = first.ensemble.dispatch('logox', 'write it');
    await waitForSnapshot(first.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    handle.cancel();
    await handle.done;
    assert.ok(!first.store.getSnapshot().messages.some(message => message.text.includes('[Interrupted by user]')), 'live timeline');
    await first.close();
    const second = await open();
    try {
      const messages = second.store.getSnapshot().messages;
      assert.ok(messages.some(message => message.text === 'write it'), 'the session was restored');
      assert.ok(!messages.some(message => message.text.includes('Interrupted by user]')), 'restored timeline');
    } finally {await second.close();}
  } finally {await first.close().catch(() => {}); await rm(cwd, {recursive: true, force: true});}
});

test('stopping Logox while companions keep working: the marker names them, and a plain Esc keeps the standard marker', {timeout: 20000}, async () => {
  const f = await fixture(scripted([writeTurn(), done()]));
  try {
    f.app.store.activities.create({sessionId: 'test', activityId: 'kalon-1', ownerId: 'kalon', kind: 'actor', title: 'Polish', stage: 'Working',
      detail: '', status: 'running', inputKind: 'director'});
    const first = f.app.ensemble.dispatch('logox', 'write it');
    await waitForSnapshot(f.app.store, snapshot => snapshot.interactions.some(item => item.status === 'pending'));
    f.app.cancel(first.activityId);
    await first.done;
    const entries = await f.app.journal.load('test', 'logox');
    const marker = entries.filter(entry => entry.message?.role === 'context' && entry.message.kind === 'interruption');
    assert.equal(marker.length, 1);
    assert.equal(marker[0]!.text, userInterruptMarkerWithWorking(['Kalon']));
    assert.ok(marker[0]!.text.startsWith('[Interrupted by user]') && marker[0]!.text.includes('Kalon'));
    assert.equal(stopNotice('user', undefined, 'x')?.text, USER_INTERRUPT_MARKER);
  } finally {await f.cleanup();}
});
