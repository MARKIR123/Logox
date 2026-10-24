import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {RuntimeStore} from '../src/runtime/store.js';
import {App, type AppProps} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal.js';
import {buildStageRows} from '../src/tui/stage.js';
import {TerminalScreen} from './terminal-screen.js';
import type {SubmitDelivery} from '../src/application.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
function addDirector(store: RuntimeStore, id: string) {
  store.activities.create({sessionId: 's', activityId: id, ownerId: 'logox', kind: 'director', title: id,
    status: 'running', stage: 'Working', detail: ''});
  store.message('s', 'logox', 'user', id + ' goal', {activityId: id, inputKind: 'human'});
  return store.message('s', 'logox', 'assistant', 'Working on ' + id, {activityId: id, kind: 'thinking',
    step: {title: 'Thinking', state: 'running', elapsedMs: 0}});
}
async function fixture(options: Partial<AppProps> = {}) {
  const input = new TerminalInput(), output = new TerminalScreen(), store = options.store ?? new RuntimeStore();
  output.columns = 120; output.rows = 24;
  let instance!: ReturnType<typeof renderTerminal>;
  const props: AppProps = {store, sessionId: 's', stage: true, getStatus: () => ({ownerId: 'logox', name: 'Logox', state: 'running'}),
    onSubmit: async () => {}, onCancel() {}, onClose: async () => {}, ...options};
  await act(async () => {instance = renderTerminal(<App {...props}/>, {stdin: input, stdout: output, stderr: output,
    interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = () => act(async () => {await instance.waitUntilRenderFlush();});
  await flush();
  return {store, input, output, flush, async key(text: string) {await act(async () => {input.write(text);}); await flush();},
    async select(foldId: string) {
      const rows = buildStageRows(store.getSnapshot(), 's', 'logox', output.columns - 1, {}, null);
      const ids = [...new Set(rows.flatMap(row => row.action?.foldId ? [row.action.foldId] : []))];
      const target = ids.indexOf(foldId); assert.ok(target >= 0, 'The selected task must have a visible fold');
      const count = (target - 4 % ids.length + ids.length) % ids.length || ids.length;
      for (let index = 0; index < count; index++) {await act(async () => {input.write('\x0e');}); await flush();}
    },
    async close() {await act(async () => {instance.unmount();}); await instance.waitUntilExit();}
  };
}

test('production footer exposes Queue, selected-task Steer and an authoritative pending count', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); const thinking = addDirector(store, 'director-a'); addDirector(store, 'director-b');
  const submissions: {text: string; source?: string | undefined; delivery?: SubmitDelivery | undefined}[] = [], cancelled: string[] = [];
  const f = await fixture({store, getQueuedCount: () => 2, onSubmit: async (text, source, delivery) => {submissions.push({text, source, delivery});}, onCancel: id => {cancelled.push(id);}});
  try {
    assert.match(f.output.lines.join('\n'), /Queued 2/); assert.match(f.output.lines.join('\n'), /Enter Queue/);
    await f.key('later work'); await f.key('\r');
    assert.deepEqual(submissions[0], {text: 'later work', source: 'logox', delivery: {mode: 'queue'}});
    await f.select(thinking); await f.key('current correction'); await f.key('\x14');
    assert.deepEqual(submissions[1], {text: 'current correction', source: 'logox', delivery: {mode: 'steer', activityId: 'director-a'}});
    assert.deepEqual(cancelled, []);
  } finally {await f.close();}
});

test('stale selected tasks retain the draft and never steer another live task', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); const thinking = addDirector(store, 'director-a'); addDirector(store, 'director-b');
  const submissions: {text: string; delivery?: SubmitDelivery | undefined}[] = [];
  const f = await fixture({store, onSubmit: async (text, _source, delivery) => {submissions.push({text, delivery});}});
  try {
    await f.select(thinking); await f.key('keep this draft');
    await act(async () => {store.activities.update('s', 'director-a', {status: 'completed'});}); await f.flush();
    await f.key('\x14');
    assert.equal(submissions.length, 0);
    assert.match(f.output.lines.join('\n'), /keep this draft/);
    assert.match(f.output.lines.join('\n'), /no longer active|Select an active/i);
    await f.key('\r'); assert.deepEqual(submissions[0], {text: 'keep this draft', delivery: {mode: 'queue'}});
  } finally {await f.close();}
});

test('steering rejects command drafts and a pending acceptance cannot duplicate submissions or erase edits', {timeout: 10000}, async () => {
  const store = new RuntimeStore(); const thinking = addDirector(store, 'director-a');
  const submissions: string[] = []; let release!: () => void;
  const accepted = new Promise<void>(resolve => {release = resolve;});
  const f = await fixture({store, onSubmit: async text => {submissions.push(text); await accepted;}});
  try {
    await f.select(thinking); await f.key('/status'); await f.key('\x14');
    assert.deepEqual(submissions, []); assert.match(f.output.lines.join('\n'), /command|routing/i);
    for (let index = 0; index < 7; index++) await f.key('\x7f');
    await f.key('first correction'); await f.key('\x14'); await f.key('\x14');
    assert.deepEqual(submissions, ['first correction']);
    await f.key(' extra'); await act(async () => {release(); await accepted;}); await f.flush();
    assert.match(f.output.lines.join('\n'), /first correction extra/);
  } finally {release(); await f.close();}
});

test('selected Actor steering uses its explicit owner instead of the main-window default', {timeout: 10000}, async () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'actor-a', ownerId: 'techne', kind: 'actor', title: 'Build module', status: 'running', stage: 'Building', detail: ''});
  store.message('s', 'techne', 'user', 'Build module', {activityId: 'actor-a', inputKind: 'director'});
  const submissions: {text: string; source?: string | undefined; delivery?: SubmitDelivery | undefined}[] = [];
  const f = await fixture({store, onSubmit: async (text, source, delivery) => {submissions.push({text, source, delivery});}});
  try {
    await f.select('actor-a'); await f.key('keep the existing interface'); await f.key('\x14');
    assert.deepEqual(submissions[0], {text: 'keep the existing interface', source: 'techne', delivery: {mode: 'steer', activityId: 'actor-a'}});
  } finally {await f.close();}
});

test('later human task rows carry a Queued label until execution actually starts', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'later', ownerId: 'logox', kind: 'director', title: 'Later', status: 'queued', stage: 'Queued', detail: ''});
  store.message('s', 'logox', 'user', 'Later independent work', {activityId: 'later', inputKind: 'human'});
  const text = () => buildStageRows(store.getSnapshot(), 's', 'logox', 80, {}, null).map(row => row.text).join('\n');
  assert.match(text(), /Queued/);
  store.activities.update('s', 'later', {status: 'running'});
  assert.doesNotMatch(text(), /Queued/);
});

test('pending count remains visible with status modules, command menus and narrow terminal widths', {timeout: 10000}, async () => {
  let queued = 2;
  const f = await fixture({getQueuedCount: () => queued});
  try {
    await f.key('/'); assert.match(f.output.lines.join('\n'), /Queued 2/);
    await act(async () => {f.output.resize(26, 12);}); await f.flush();
    assert.match(f.output.lines.join('\n'), /Queued 2/);
    queued = 1; await act(async () => {f.store.message('s', 'logox', 'notice', 'Queue changed.');}); await f.flush();
    assert.match(f.output.lines.join('\n'), /Queued 1/); assert.doesNotMatch(f.output.lines.join('\n'), /Queued 2/);
    queued = 0; await act(async () => {f.store.message('s', 'logox', 'notice', 'Queue empty.');}); await f.flush();
    assert.match(f.output.lines.join('\n'), /Queued 0/);
  } finally {await f.close();}
});
