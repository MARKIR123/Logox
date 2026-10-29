import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {act} from 'react';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
import type {SystemPresentation} from '../src/runtime/system-events.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {palette} from '../src/tui/appearance/theme.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
function emit(store: RuntimeStore, text: string, presentation: SystemPresentation, options: {sessionId?: string; ownerId?: string; replay?: boolean} = {}) {
  store.system({id: randomUUID(), sessionId: options.sessionId ?? 's', ownerId: options.ownerId ?? 'logox',
    time: Date.now(), text, presentation}, options.replay ?? false);
}
// Store-only fixtures perform no config/resource discovery, credential reads or provider/network calls.
async function mount(store: RuntimeStore, stage = true) {
  const input = new Input(), output = new TerminalScreen(), surfaces = new CommandSurfaces(() => {});
  const actors = ['logox', 'alpha', 'beta'].map(id => ({id, symbol: '◇', name: id, title: id, color: palette.accent}));
  const node = (sessionId = 's', key = 'mount') => <App key={key} stage={stage} store={store} surfaces={surfaces} sessionId={sessionId}
    getActors={() => actors} onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>;
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(node(), {stdin: input, stdout: output, stderr: output, interactive: true,
    alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => instance.waitUntilRenderFlush();
  const change = async (fn: () => void) => {await act(async () => fn()); await flush();};
  const key = async (value: string) => {
    await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await flush();
  };
  await flush();
  return {input, output, surfaces, key, change, flush, text: () => output.lines.join('\n'),
    rerender: async (sessionId: string, key = 'mount') => change(() => instance.rerender(node(sessionId, key))),
    close: async () => {await act(async () => {surfaces.close(); store.interactions.close(); instance.unmount();});
      await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}

test('live saves replace one footer status slot, expire without timeline rows, and never displace Actor pills', async () => {
  const store = new RuntimeStore();
  for (let index = 0; index < 40; index++) store.message('s', 'logox', 'assistant', 'history row ' + index);
  emit(store, 'preexisting-save', 'status'); emit(store, 'silent-model-switch', 'silent'); emit(store, 'preexisting-panel', 'panel');
  store.activities.create({sessionId: 's', activityId: 'actor', ownerId: 'alpha', kind: 'actor', title: 'Work', status: 'running', stage: '', detail: ''});
  const f = await mount(store, false);
  try {
    assert.doesNotMatch(f.text(), /preexisting-save|silent-model-switch|preexisting-panel/);
    await f.key('\x1b[5~');
    const history = f.text().match(/history row \d+/g); assert.ok(history?.length);
    const timeline = () => f.output.lines.slice(0, -1).join('\n');
    await f.change(() => emit(store, 'Saved one', 'status'));
    assert.match(f.output.lines.at(-1)!, /Saved one/); assert.doesNotMatch(timeline(), /Saved one/);
    await f.change(() => {emit(store, 'Saved two', 'status'); emit(store, 'Saved latest ' + 'x'.repeat(200), 'status');});
    assert.match(f.output.lines.at(-1)!, /Saved latest/); assert.match(f.output.lines.at(-1)!, /alpha/);
    assert.doesNotMatch(f.text(), /Saved one|Saved two/);
    assert.deepEqual(f.text().match(/history row \d+/g), history, 'Success notices leave the reading anchor unchanged');
    assert.doesNotMatch(timeline(), /Saved latest/);
    await act(async () => {await delay(1850);}); await f.flush();
    assert.doesNotMatch(f.text(), /Saved latest/); assert.match(f.output.lines.at(-1)!, /alpha/);
    assert.deepEqual(f.text().match(/history row \d+/g), history);
  } finally {await f.close();}
});

test('status toasts obey session/window scope, ignore replay and remount history, and panel events never reopen a surface', async () => {
  const store = new RuntimeStore(); emit(store, 'mounted-history', 'status');
  const f = await mount(store);
  try {
    assert.doesNotMatch(f.text(), /mounted-history/);
    await f.change(() => emit(store, 'wrong-session', 'status', {sessionId: 'other'}));
    assert.doesNotMatch(f.text(), /wrong-session/);
    await f.key('\x07'); // Ctrl+G: Director -> alpha.
    await f.change(() => emit(store, 'wrong-owner', 'status', {ownerId: 'beta'}));
    assert.doesNotMatch(f.text(), /wrong-owner/);
    await f.change(() => emit(store, 'right-owner', 'status', {ownerId: 'alpha'}));
    assert.match(f.output.lines.at(-1)!, /right-owner/);
    await f.change(() => emit(store, 'replayed-save', 'status', {ownerId: 'alpha', replay: true}));
    assert.doesNotMatch(f.text(), /replayed-save/); assert.match(f.text(), /right-owner/);
    await f.key('\x1b'); // Back to Director; old actor-window receipts do not replay.
    assert.doesNotMatch(f.text(), /right-owner|wrong-owner/);
    await f.change(() => emit(store, 'live-child-save', 'status', {ownerId: 'beta'}));
    assert.match(f.output.lines.at(-1)!, /live-child-save/, 'Director sees live receipts from all actors');
    await f.change(() => {emit(store, 'panel-record', 'panel'); emit(store, 'restored-panel', 'panel', {replay: true}); emit(store, 'quiet-cancel', 'silent');});
    assert.equal(f.surfaces.getSnapshot(), null); assert.doesNotMatch(f.text(), /panel-record|restored-panel|quiet-cancel/);
    await f.rerender('s', 'remounted'); assert.doesNotMatch(f.text(), /live-child-save|mounted-history|replayed-save/);
    await f.rerender('other', 'remounted'); assert.doesNotMatch(f.text(), /wrong-session/);
    await f.change(() => emit(store, 'fresh-other-session', 'status', {sessionId: 'other'}));
    assert.match(f.output.lines.at(-1)!, /fresh-other-session/);
  } finally {await f.close();}
});

for (const stage of [false, true]) test(`welcome is an independent empty state only, preserving metadata and legacy timeline (stage=${stage})`, async () => {
  const store = new RuntimeStore(); emit(store, 'Welcome to an empty conversation', 'welcome');
  emit(store, 'startup-quiet', 'silent'); emit(store, 'startup-save', 'status');
  const f = await mount(store, stage);
  try {
    assert.match(f.text(), /Welcome to an empty conversation/);
    assert.equal(f.text().match(/Welcome to an empty conversation/g)?.length, 1);
    assert.equal(store.getSnapshot().messages.find(message => message.text.startsWith('Welcome'))?.systemPresentation, 'welcome');
    await f.key('draft stays local'); assert.match(f.text(), /Welcome to an empty conversation/); assert.match(f.text(), /draft stays local/);
    await f.change(() => {store.message('s', 'logox', 'user', 'Start a real conversation');});
    assert.doesNotMatch(f.text(), /Welcome to an empty conversation/); assert.match(f.text(), /Start a real conversation/);
    await f.change(() => {store.message('s', 'logox', 'system', 'Saved model changed legacy text remains visible');});
    assert.match(f.text(), /Saved model changed legacy text remains visible/, 'No text-keyword filtering of older system messages');
    await f.change(() => emit(store, 'Necessary explicit error', 'timeline'));
    assert.match(f.text(), /Necessary explicit error/);
    await f.change(() => {emit(store, 'invisible-save', 'status', {replay: true}); emit(store, 'invisible-model', 'silent');});
    assert.doesNotMatch(f.text(), /invisible-save|invisible-model/);
    await f.key('\x07');
    assert.doesNotMatch(f.text(), /Welcome to an empty conversation/, 'Director welcome is not copied into Actor windows');
    const actorWindow = stage ? 'alpha' : 'kalon';
    await f.change(() => emit(store, 'Welcome Actor window', 'welcome', {ownerId: actorWindow}));
    assert.match(f.text(), /Welcome Actor window/, 'An actually empty Actor window can show its own welcome');
    await f.change(() => {store.activities.create({sessionId: 's', ownerId: actorWindow, activityId: 'actor-task',
      kind: 'actor', title: 'Task content', status: 'running', stage: '', detail: ''});});
    assert.doesNotMatch(f.text(), /Welcome Actor window/, 'Starting a task removes the empty state before any assistant text');
    await f.rerender('s', 'after-remount'); assert.doesNotMatch(f.text(), /Welcome to an empty conversation/);
    assert.equal(store.getSnapshot().messages.filter(message => message.systemPresentation === 'welcome').length, 2, 'Rendering never inserts duplicate welcome messages');
  } finally {await f.close();}
});
