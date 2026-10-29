import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {SystemHistory} from '../src/store/system-history.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {isTimelineMessage, systemEventSchema, systemPresentationSchema, type SystemEvent} from '../src/runtime/system-events.js';
import type {Message} from '../src/runtime/contracts.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {extractSelection, timelineRows} from '../src/tui/timeline/viewport.js';
import {actionAt, hoveredCardAt} from '../src/tui/timeline/scene.js';

function legacyEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return {version: 1, id: randomUUID(), sessionId: 's', ownerId: 'logox', time: 10,
    kind: 'command_result', text: 'Current model: fixture', ...overrides};
}

test('system presentation is optional strict v1 metadata, never a legacy migration', () => {
  const legacy = legacyEvent();
  assert.deepEqual(systemEventSchema.parse(legacy), legacy);
  assert.equal(Object.hasOwn(systemEventSchema.parse(legacy), 'presentation'), false);
  assert.equal(Object.hasOwn(systemEventSchema.parse(legacy), 'title'), false);
  for (const presentation of systemPresentationSchema.options) {
    const event = {...legacy, presentation, title: ''};
    assert.deepEqual(systemEventSchema.parse(event), event);
  }
  for (const invalid of [{presentation: 'toast'}, {title: 1}, {systemReplay: true}, {version: 2}]) {
    assert.equal(systemEventSchema.safeParse({...legacy, ...invalid}).success, false);
  }
});

test('history metadata roundtrips with replay flags, stable IDs, owner/session attribution, and no model entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-history-presentation-'));
  try {
    const journal = new Journal(directory), store = new RuntimeStore();
    let persistent = false;
    const history = new SystemHistory('s', store, journal, () => persistent);
    for (const presentation of systemPresentationSchema.options) {
      history.emit('Receipt: ' + presentation, 'command_result', 'techne', 'activity', true,
        {presentation, title: 'Title: ' + presentation});
    }
    history.emit('Title only', 'task_notice', 'logox', undefined, true, {title: ''});
    history.emit('Legacy default');
    history.emit('Empty options', 'command_result', 'logox', undefined, true, {});
    await history.flush();
    assert.deepEqual(await journal.systemEvents('s'), [], 'Blank-session events stay buffered.');
    assert.equal(store.getSnapshot().messages.length, 8);
    assert.ok(store.getSnapshot().messages.every(message => message.systemReplay === false));
    persistent = true;
    await history.flush();
    const events = await journal.systemEvents('s');
    assert.equal(events.length, 8);
    assert.ok(events.every(event => !Object.hasOwn(event, 'systemReplay')));
    assert.ok(events.slice(5).every(event => !Object.hasOwn(event, 'presentation')));
    assert.ok(events.slice(6).every(event => !Object.hasOwn(event, 'title')));
    for (const owner of ['logox', 'techne', '$system']) assert.deepEqual(await journal.loadRaw('s', owner), []);
    assert.deepEqual(await journal.systemEvents('other'), []);
    const restored = new RuntimeStore(), replay = new SystemHistory('s', restored, journal, () => true);
    await replay.restore();
    await replay.restore();
    assert.equal(restored.getSnapshot().messages.length, events.length);
    for (const event of events) {
      const message = restored.getSnapshot().messages.find(item => item.id === event.id)!;
      assert.equal(message.role, 'system');
      assert.equal(message.sessionId, event.sessionId);
      assert.equal(message.ownerId, event.ownerId);
      assert.equal(message.activityId, event.activityId);
      assert.equal(message.time, event.time);
      assert.equal(message.text, event.text);
      assert.equal(message.systemPresentation, event.presentation);
      assert.equal(message.systemTitle, event.title);
      assert.equal(message.systemEventKind, event.kind);
      assert.equal(message.systemReplay, true);
      restored.system(event);
      assert.equal(restored.getSnapshot().messages.find(item => item.id === event.id), message, 'Same ID never replaces replay metadata.');
    }
    assert.deepEqual(await journal.systemEvents('s'), events, 'Restore never emits receipts back into the journal.');
    await journal.fork('s', ['logox', 'techne'], ['activity']);
    assert.equal((await journal.systemEvents('s')).length, 3);
    const raw: SystemEvent[] = JSON.parse(await readFile(journal.path('s', '$system') + '.events.json', 'utf8'));
    assert.deepEqual(raw, events, 'Branch rollback only changes the effective projection.');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('legacy raw events retain absent metadata through restore and later append', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-history-legacy-'));
  try {
    const journal = new Journal(directory), event = legacyEvent();
    const file = journal.path('s', '$system') + '.events.json';
    const original = JSON.stringify([event], null, 2) + '\n';
    await writeFile(file, original);
    const store = new RuntimeStore(), history = new SystemHistory('s', store, journal, () => true);
    await history.restore();
    assert.equal(await readFile(file, 'utf8'), original, 'Read/restore never rewrites raw bytes.');
    const message = store.getSnapshot().messages[0]!;
    assert.equal(isTimelineMessage(message), true);
    assert.equal(message.systemReplay, true);
    assert.equal(Object.hasOwn(message, 'systemPresentation'), false);
    assert.equal(Object.hasOwn(message, 'systemTitle'), false);
    history.emit('Saved', 'command_result', 'logox', undefined, true, {presentation: 'status', title: 'Settings'});
    await history.flush();
    const raw: SystemEvent[] = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(raw[0], event, 'Appending new metadata never fills old fields.');
    assert.equal(Object.hasOwn(raw[0]!, 'presentation'), false);
    assert.equal(Object.hasOwn(raw[0]!, 'title'), false);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('only explicitly non-timeline system messages are hidden, independently of text and replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-history-rows-'));
  try {
    const journal = new Journal(directory), store = new RuntimeStore();
    const history = new SystemHistory('s', store, journal, () => true);
    for (const presentation of ['status', 'panel', 'silent', 'welcome'] as const) {
      history.emit('Same receipt body', 'command_result', 'logox', undefined, true, {presentation});
    }
    await history.flush();
    const quiet = store.getSnapshot();
    assert.equal(quiet.messages.length, 4);
    assert.ok(quiet.messages.every(message => !isTimelineMessage(message)));
    assert.deepEqual(buildStageRows(quiet, 's', 'logox', 80, {}, null), []);
    assert.deepEqual(timelineRows(quiet.messages, 80), []);
    assert.equal((await journal.systemEvents('s')).length, 4);
    assert.deepEqual(await journal.loadRaw('s', 'logox'), []);
    history.emit('Same receipt body');
    history.emit('Same receipt body', 'command_error', 'logox', undefined, true, {presentation: 'timeline'});
    history.emit('Same receipt body', 'model_error');
    await history.flush();
    const snapshot = store.getSnapshot();
    const visible = snapshot.messages.filter(isTimelineMessage);
    assert.equal(visible.length, 3, 'Legacy defaults and explicit timeline errors stay visible.');
    const stage = buildStageRows(snapshot, 's', 'logox', 80, {}, null);
    const fallback = timelineRows(snapshot.messages, 80);
    for (const message of snapshot.messages) {
      assert.equal(stage.some(row => row.messageId === message.id), isTimelineMessage(message));
      assert.equal(fallback.some(row => row.messageId === message.id), isTimelineMessage(message));
    }
    const replayed = new RuntimeStore();
    await new SystemHistory('s', replayed, journal, () => true).restore();
    assert.deepEqual(buildStageRows(replayed.getSnapshot(), 's', 'logox', 80, {}, null), stage);
    assert.deepEqual(timelineRows(replayed.getSnapshot().messages, 80), fallback);
    const base: Message = {id: 'message', sessionId: 's', ownerId: 'logox', role: 'system', text: '/model fixture'};
    assert.equal(isTimelineMessage(base), true, 'Never infer presentation from command text.');
    for (const role of ['user', 'assistant', 'notice'] as const) {
      assert.equal(isTimelineMessage({...base, role, systemPresentation: 'silent'}), true);
    }
    const visibleTool: Message = {...base, role: 'assistant', kind: 'tool'};
    assert.equal(isTimelineMessage(visibleTool), true);
    assert.equal(isTimelineMessage({role: 'tool'}), true);
    const hiddenTool: Message = {...base, id: 'hidden-tool', role: 'assistant', kind: 'tool', text: 'Hidden tool',
      step: {title: 'Hidden tool', state: 'completed', elapsedMs: 0, terminalVisibility: 'silent',
        call: {id: 'call', name: 'Read', arguments: '{}'}}};
    assert.deepEqual(buildStageRows({...quiet, messages: [hiddenTool]}, 's', 'logox', 80, {}, null), []);
    assert.deepEqual(timelineRows([hiddenTool], 80), [], 'Existing hidden-tool filtering remains active.');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('explicit global timeline errors use independent one-line folds with selectable original details', () => {
  const store = new RuntimeStore();
  const detail = 'Request failed\nProvider detail: synthetic failure\nRecovery: retry later';
  const first = legacyEvent({kind: 'command_error', text: detail, presentation: 'timeline'});
  const second = legacyEvent({kind: 'model_error', text: detail, presentation: 'timeline', title: 'Provider unavailable'});
  store.system(first);
  store.system(second, true);
  const legacy = legacyEvent({kind: 'command_error', text: 'Legacy failure\nLegacy detail'});
  store.system(legacy, true);
  const notice = store.message('s', 'logox', 'notice', 'Ordinary notice\nNotice detail');
  const user = store.message('s', 'logox', 'user', 'Error: user content');
  for (const width of [8, 20, 80]) {
    const collapsed = buildStageRows(store.getSnapshot(), 's', 'logox', width, {}, null);
    for (const event of [first, second]) {
      const headers = collapsed.filter(row => row.action?.foldId === event.id);
      assert.equal(headers.length, 1, 'Each global event has its own one-line fold even on narrow screens.');
      const header = headers[0]!;
      const hit = header.hits!.find(item => item.action.foldId === event.id)!;
      assert.deepEqual(actionAt(header, hit.startCol), {kind: 'toggle_fold', foldId: event.id});
      assert.equal(hoveredCardAt(header, hit.startCol), event.id);
      assert.equal(header.messageId, event.id);
    }
    assert.equal(collapsed.some(row => row.text.includes('Provider detail')), false);
  }
  const expanded = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[first.id]: true}, null);
  const body = expanded.filter(row => row.messageId === first.id && row.tone === 'body' && row.action?.foldId !== first.id);
  const copied = extractSelection(body, {anchor: {x: 0, y: 0}, focus: {x: 200, y: body.length - 1}});
  assert.equal(copied.split('\n').map(line => line.trimStart()).join('\n'), detail);
  assert.equal(expanded.filter(row => row.messageId === second.id).length, 1, 'Another event with identical text stays independently closed.');
  assert.ok(expanded.some(row => row.messageId === legacy.id && row.text === 'Legacy detail'));
  assert.ok(expanded.some(row => row.messageId === notice && row.text === 'Notice detail'));
  assert.ok(expanded.some(row => row.messageId === user && row.text === 'Error: user content'));
  assert.equal(store.getSnapshot().messages.find(message => message.id === first.id)!.text, detail);
});

test('task-owned errors keep their original activity fold instead of a global error card', () => {
  const store = new RuntimeStore();
  for (const activityId of ['task-a', 'task-b']) {
    store.activities.create({sessionId: 's', activityId, ownerId: 'logox', kind: 'director', title: activityId,
      status: 'failed', stage: 'Failed', detail: 'Same task error\nTask-specific recovery'});
    store.message('s', 'logox', 'user', activityId, {activityId});
    const event = legacyEvent({activityId, kind: 'model_error', text: 'Same task error\nTask-specific recovery', presentation: 'timeline'});
    store.system(event);
  }
  const collapsed = buildStageRows(store.getSnapshot(), 's', 'logox', 80, {}, null);
  assert.deepEqual(collapsed.filter(row => row.action?.kind === 'toggle_fold').map(row => row.action?.foldId), ['task-a', 'task-b']);
  const expanded = buildStageRows(store.getSnapshot(), 's', 'logox', 80, {'task-a': true}, null);
  assert.equal(expanded.filter(row => row.text === 'Task-specific recovery').length, 1);
});

test('failed system flush retains quiet metadata for retry without persisting replay or failure notices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-test-history-retry-'));
  try {
    const blocked = join(directory, 'journal');
    await writeFile(blocked, 'Not a directory');
    const journal = new Journal(blocked), store = new RuntimeStore();
    const history = new SystemHistory('s', store, journal, () => true);
    history.emit('Saved', 'command_result', 'techne', undefined, true, {presentation: 'status', title: 'Settings'});
    await assert.rejects(history.flush());
    await new Promise<void>(resolve => setImmediate(resolve));
    const receipt = store.getSnapshot().messages[0]!;
    assert.equal(receipt.systemPresentation, 'status');
    assert.equal(receipt.systemReplay, false);
    assert.ok(store.getSnapshot().messages.some(message => message.id !== receipt.id && isTimelineMessage(message)), 'Persistence errors remain timeline notices.');
    await rm(blocked);
    await mkdir(blocked);
    await history.flush();
    const events = await journal.systemEvents('s');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.id, receipt.id);
    assert.equal(events[0]!.presentation, 'status');
    assert.equal(events[0]!.title, 'Settings');
    assert.equal(Object.hasOwn(events[0]!, 'systemReplay'), false);
  } finally {await rm(directory, {recursive: true, force: true});}
});
