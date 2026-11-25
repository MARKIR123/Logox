import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer, type ServerResponse} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {createAgent} from '../src/kernel/agent.js';
import {EnsembleRuntime} from '../src/actors/ensemble.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {ProviderError, retryDiagnostic} from '../src/providers/http.js';
import {Journal} from '../src/store/journal.js';
import {Tools, toolDefinitions} from '../src/tools/index.js';
import type {ModelTurn, Provider} from '../src/runtime/messages.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {loadConfig} from '../src/config/config.js';
import {createProvider} from '../src/providers/http.js';
import {createHttpTransport} from '../src/providers/transport.js';
import {createTestApplication as createApplication, waitForSnapshot} from './runtime-fixture.js';
import {synopsisBlock} from '../src/context/synopsis.js';

const cut = () => new ProviderError('[Network] Stream interrupted: Connection closed (UND_ERR_SOCKET)\nTransport: elapsed 194.0s; idle since progress 194.0s; idle since data 194.0s; 0 bytes received.',
  true, 'temporary', {phase: 'stream', code: 'UND_ERR_SOCKET', elapsedMs: 194_008, progressIdleMs: 194_008, transportIdleMs: 194_008, receivedBytes: 0});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a dropped attempt ends in the same moment its retry is announced, waits as Reconnecting with its own clock, and a fresh Thinking starts from zero', {timeout: 15_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-retry-transition-'));
  const store = new RuntimeStore();
  const finish: ModelTurn = {message: {role: 'assistant', text: 'Done.' + '\n\n' + synopsisBlock({title: 'Done', summary: 'Round outcome.'})}, stop: 'complete'};
  let calls = 0;
  const provider: Provider = {async respond(_request, delta) {
    calls++;
    if (calls === 1) {await pause(60); throw cut();}
    await pause(120);
    delta({kind: 'text', text: 'Done.'});
    return finish;
  }};
  const diagnostics: string[] = [];
  const execute = createAgent({cwd: directory, store, tools: new Tools(directory), provider: () => provider, iterations: 0, retries: 3,
    retryProvider: async (context, _error, diagnostic) => {
      diagnostics.push(diagnostic ?? '');
      store.system({id: randomUUID(), sessionId: context.sessionId, ownerId: context.ownerId, activityId: context.activityId, time: Date.now(),
        text: '[Network] Connection interrupted. Retrying (1/3)...', presentation: 'timeline', kind: 'task_notice'});
      return true;
    },
    requestBase: async () => ({...composeBaseSystemPrompt({cwd: directory, ownerId: 'logox', builtinPrompt: 'Test'}), tools: toolDefinitions})});
  const ensemble = new EnsembleRuntime<string>('s', store, new Journal(join(directory, 'sessions')), execute, {handoff: async () => {}});
  const frames: {notice: boolean; phase: string | undefined; retrySince: number | undefined; thinking: {id: string; state: string; interrupted?: boolean; elapsedMs: number}[]}[] = [];
  const stop = store.subscribe(() => {
    const snapshot = store.getSnapshot(), activity = snapshot.activities[0];
    frames.push({notice: snapshot.messages.some(message => message.role === 'system' && /Retrying/.test(message.text)), phase: activity?.phase, retrySince: activity?.retrySince,
      thinking: snapshot.messages.filter(message => message.kind === 'thinking' && message.step?.groupId).map(message => ({id: message.id, state: message.step!.state,
        ...(message.step!.interrupted ? {interrupted: true} : {}), elapsedMs: message.step!.elapsedMs}))});
  });
  try {
    const task = ensemble.dispatch('logox', 'Go', 'direct');
    await task.done;
    stop();
    assert.equal(store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(calls, 2);
    // Atomic: no snapshot holds a live Thinking row together with the retry notice.
    assert.ok(frames.some(frame => frame.notice), 'the notice was posted');
    const dropped = store.getSnapshot().messages.find(message => message.kind === 'thinking' && message.step?.groupId)!.id;
    assert.deepEqual(frames.filter(frame => frame.notice && frame.thinking.some(row => row.id === dropped && (row.state === 'running' || row.state === 'waiting'))), []);
    assert.ok(!frames.some(frame => frame.phase === 'retry' && frame.thinking.some(row => row.state === 'running' || row.state === 'waiting')), 'no live row during the wait');
    // The wait: Reconnecting state with its own clock, nothing running.
    const waiting = frames.filter(frame => frame.phase === 'retry');
    assert.ok(waiting.length > 0 && waiting.every(frame => frame.retrySince !== undefined && frame.thinking.every(row => row.state !== 'running' && row.state !== 'waiting')));
    assert.equal(store.activities.get('s', task.activityId)?.retrySince, undefined, 'the clock ends with the wait');
    // Rows: the dropped attempt is failed + interrupted with its real duration; the new attempt is a separate row that began at zero.
    const rows = store.getSnapshot().messages.filter(message => message.kind === 'thinking' && message.step?.groupId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.step!.state, 'failed'); assert.equal(rows[0]!.step!.interrupted, true); assert.ok(rows[0]!.step!.elapsedMs >= 50);
    assert.equal(rows[1]!.step!.interrupted, undefined);
    const first = frames.find(frame => frame.thinking.some(row => row.id === rows[1]!.id && row.state === 'running'));
    assert.equal(first?.thinking.find(row => row.id === rows[1]!.id)?.elapsedMs, 0, 'the fresh Thinking starts from 0');
    assert.ok(frames.findIndex(frame => frame.thinking.some(row => row.id === rows[1]!.id)) > frames.findIndex(frame => frame.phase === 'retry'), 'the new row appears after the wait began');
    // The diagnostic reached the retry hook.
    assert.match(diagnostics[0]!, /^Retry 1\/3;.*phase stream; code UND_ERR_SOCKET; elapsed 194\.0s; idle since progress 194\.0s; idle since data 194\.0s; 0 bytes received; output none before the failure/);
  } finally {stop(); await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});

test('an interrupted attempt reads as muted history and the wait is the live state of the card', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'techne', kind: 'actor', title: 'Build', taskTitle: 'Build the thing', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'techne', 'user', 'Build it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  let clock = 1_000_000;
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'techne'}, () => clock);
  const think = steps.thinking();
  clock += 194_008;
  steps.interrupted(think); steps.endGroup('failed');
  const resume = steps.reconnecting();
  store.activities.update('s', 'k', {detail: 'Connection interrupted. Retrying (1/3)...'});
  const rows = (view: string) => buildStageRows(store.getSnapshot(), 's', view, 120, {}, null);
  const card = rows('logox').find(row => row.messageId === 'k')!;
  assert.match(card.text.replace(/\s+/g, ' '), /Build the thing · Reconnecting \(1\/3\)/);
  assert.equal(card.animation?.clockStart, clock, 'the card clock counts the wait');
  // Inside the card and in the actor's own window the interrupted attempt is a finished, muted row.
  const own = rows('techne').map(row => row.text.replace(/\s+/g, ' ')).join('\n');
  assert.match(own, /Thinking · interrupted after 3m 14s/);
  assert.ok(!/Thinking\s*$/m.test(own.replace(/Thinking · interrupted after 3m 14s/g, '')), 'no live Thinking row while waiting');
  resume();
  assert.equal(store.activities.get('s', 'k')?.phase, 'model');
  assert.equal(store.activities.get('s', 'k')?.retrySince, undefined);
  const next = steps.thinking();
  assert.equal(steps.get(next).state, 'running'); assert.equal(steps.get(next).elapsedMs, 0);
  assert.notEqual(next, think);
});

test('the diagnostic line carries timings, bytes, code and where it ran, and stays public-safe', () => {
  const line = retryDiagnostic(cut(), {provider: 'antigravity', model: 'gemini-4-neon-high', attempt: 1, retries: 3, streamed: false});
  assert.equal(line, 'Retry 1/3; antigravity/gemini-4-neon-high; phase stream; code UND_ERR_SOCKET; elapsed 194.0s; idle since progress 194.0s; idle since data 194.0s; 0 bytes received; output none before the failure; [Network] Stream interrupted: Connection closed (UND_ERR_SOCKET)');
  assert.ok(retryDiagnostic(new ProviderError('x'.repeat(2000), true), {attempt: 2, retries: 3, streamed: true}).length <= 600);
});

const send = (res: ServerResponse, delta: unknown, finish_reason: string | null = null) =>
  res.write('data: ' + JSON.stringify({choices: [{delta, finish_reason}]}) + '\n\n');

test('a retried network failure leaves its diagnostic in the session events, not in the timeline text', {timeout: 15_000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-retry-diagnostic-'));
  let count = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    count++; res.writeHead(200, {'content-type': 'text/event-stream'});
    if (count === 1) {send(res, {reasoning_content: 'thinking...'}); setTimeout(() => res.destroy(), 20);}
    else {send(res, {content: 'recovered'}, 'stop'); res.end('data: [DONE]\n\n');}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const transport = createHttpTransport({});
  const provider = createProvider({kind: 'openai_compat', baseUrl: `http://127.0.0.1:${address.port}`, model: 'test', key: '', maxTokens: 512, temperature: 0.2, timeoutMs: 3000}, transport.fetch);
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, config, provider, sessionId: 'diag', outageDelaysMs: [5], resourceOptions: {home: cwd, boundary: cwd}});
  try {
    await app.submit('Go');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'logox' && ['completed', 'failed'].includes(activity.status)), 10_000);
    await app.close();
    const events = (await app.journal.systemEvents('diag')).filter(event => /Retrying/.test(event.text));
    assert.ok(events.length >= 1, JSON.stringify(await app.journal.systemEvents('diag')) + ' count=' + count);
    assert.match(events[0]!.diagnostic ?? '', /^Retry 1\/\d; .*elapsed \d+\.\ds; idle since progress \d+\.\ds; .*bytes received; output streamed before the failure/);
    assert.ok(!events[0]!.text.includes('elapsed'), 'the notice text stays one concise line');
    assert.ok(!app.store.getSnapshot().messages.some(message => message.text.includes('idle since progress') && message.role === 'system'), 'the diagnostic is never drawn');
  } finally {await app.close().catch(() => {}); await transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(cwd, {recursive: true, force: true});}
});
