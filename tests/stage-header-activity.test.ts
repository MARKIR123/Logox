import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {cast} from '../src/actors/ensemble.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {decorateRow} from '../src/tui/timeline/row-presentation.js';
import {palette} from '../src/tui/appearance/theme.js';
import {faintColor} from '../src/tui/appearance/colors.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

/** The header reads `Name · <text>` (or just `Name`): quiet text, never a spinner glyph. */
const spun = (name: string, rest = '') => new RegExp('^' + name + (rest ? ' · ' + rest.trim() : '') + '\\s*$');

function fixture() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Make a pelican.', {activityId: 'main', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
  const rows = (view = 'logox') => buildStageRows(store.getSnapshot(), 's', view, 110, {}, null);
  const headerRow = (view = 'logox', glyph = '◈'): SceneRow => rows(view).find(row => row.messageId.endsWith('-who') && row.railGlyph === glyph)!;
  const header = (view = 'logox', glyph = '◈') => decorateRow(headerRow(view, glyph), Date.now()).displayText!;
  const stage = (line: string, owner = 'logox', activityId = 'main') => store.message('s', owner, 'assistant', '⏵ ' + line, {activityId});
  const tool = (name = 'Shell', args: Record<string, unknown> = {command: 'npm run build:everything'}) => {
    const id = steps.tool({id: name + store.getSnapshot().messages.length, name, arguments: JSON.stringify(args)}); steps.start(id); return id;
  };
  return {store, steps, rows, headerRow, header, stage, tool};
}
const ask = (store: RuntimeStore, activityId: string, ownerId: string) => store.interactions.open({sessionId: 's', activityId, ownerId, kind: 'question', title: 'Pick one',
  questions: [{id: 'q', header: 'Pick', question: 'Which?', options: [{id: 'a', label: 'A', description: 'a'}, {id: 'b', label: 'B', description: 'b'}]}]});
const approve = (store: RuntimeStore, activityId: string, ownerId: string) => store.interactions.open({sessionId: 's', activityId, ownerId, kind: 'permission', title: 'Write',
  tool: 'Write', arguments: {file_path: 'a.ts'}, reason: 'Write a.ts'});
const iconOf = (row: SceneRow) => decorateRow(row, Date.now()).segments!.find(segment => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(segment.text) || segment.selectionKey?.endsWith(':activity_icon'));

test('the header reads `Name · stage`; without a stage it is the name alone, never a tool title, Thinking or a clock', () => {
  const f = fixture();
  const think = f.steps.thinking(); f.store.appendMessage(think, 'hmm');
  assert.match(f.header(), spun('Logox'), 'no stage yet while thinking');
  f.steps.finish(think, 'completed');
  f.tool();
  assert.match(f.header(), spun('Logox'), 'no stage yet while a tool runs');
  f.stage('Verifying the build');
  const text = f.header();
  assert.match(text, spun('Logox', ' Verifying the build'));
  assert.ok(!/npm run|Shell|Thinking|\d+(\.\d)?s\b/.test(text), 'no tool title, no Thinking, no elapsed time: ' + text);
  assert.equal(iconOf(f.headerRow()), undefined, 'no spinner in the header');
  assert.equal(f.headerRow().animation, undefined, 'the header carries no animation');
  assert.equal(f.headerRow().segments!.find(s => s.selectionKey?.endsWith(':activity_sep'))!.color, faintColor(), 'the separator is faint');
  f.stage('Packaging the result');
  assert.match(f.header(), spun('Logox', ' Packaging the result'), 'the latest stage wins');
});

test('temporary states replace the stage text and the stage comes back afterwards', () => {
  const f = fixture();
  f.tool(); f.stage('Checking the layout');
  const base = spun('Logox', ' Checking the layout');
  assert.match(f.header(), base);

  // Pending answer / approval: static (no spinner) and no clock.
  const question = ask(f.store, 'main', 'logox');
  assert.match(f.header(), /^Logox · Awaiting your answer\s*$/);
  assert.equal(iconOf(f.headerRow()), undefined, 'a static wait has no spinner');
  assert.equal(f.headerRow().animation, undefined);
  f.store.interactions.cancel(question.requestId);
  assert.match(f.header(), base);
  const permission = approve(f.store, 'main', 'logox');
  assert.match(f.header(), /^Logox · Awaiting approval\s*$/);
  assert.equal(iconOf(f.headerRow()), undefined);
  f.store.interactions.cancel(permission.requestId);
  assert.match(f.header(), base);
  // A request of another owner never changes the Logox header.
  const other = ask(f.store, 'main', 'kalon');
  assert.match(f.header(), base);
  f.store.interactions.cancel(other.requestId);

  // Provider retry: the agent loop's `Network retry` report carries the counter; the retry phase holds while it waits.
  f.store.activities.update('s', 'main', {phase: 'retry', stage: 'Network retry', detail: 'Connection interrupted. Retrying (2/5)...'});
  assert.match(f.header(), spun('Logox', ' Retrying \\(2/5\\)'));
  f.store.activities.update('s', 'main', {phase: 'model'});
  assert.match(f.header(), base);

  // Context compaction.
  f.store.activities.update('s', 'main', {phase: 'compacting'});
  assert.match(f.header(), spun('Logox', ' Compacting context'));
  f.store.activities.update('s', 'main', {phase: 'model'});
  assert.match(f.header(), base);

  // Blocked on actors' results (no tool of its own running).
  const g = fixture();
  g.stage('Handing out the work');
  g.store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig', status: 'running', stage: 'x', detail: ''});
  g.store.message('s', 'kalon', 'user', 'Do it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  g.tool('Read', {file_path: 'a.ts'});
  const readId = g.store.getSnapshot().messages.findLast(m => m.kind === 'tool')!.id;
  g.steps.finish(readId, 'completed', 'Read\nok');
  assert.match(g.header(), /^Logox · Waiting on Kalon\s*$/);
  g.store.activities.update('s', 'k', {status: 'completed'});
  assert.match(g.header(), spun('Logox', ' Handing out the work'));
});

test('a finished round has no spinner: the name keeps only the last stage as quiet text', () => {
  const f = fixture();
  const id = f.tool(); f.stage('Checking the layout'); f.stage('Final polish');
  f.steps.finish(id, 'completed', 'Shell\nok'); f.store.activities.update('s', 'main', {status: 'completed'});
  const row = f.headerRow();
  assert.equal(row.animation, undefined);
  assert.equal(row.text.trim(), 'Logox · Final polish');
  assert.ok(!/\d+s\b/.test(row.text), 'no elapsed time');
  assert.equal(row.segments!.find(s => s.selectionKey?.endsWith(':activity'))!.color, palette.muted);
  const quiet = fixture();
  const done = quiet.tool(); quiet.steps.finish(done, 'completed', 'Shell\nok'); quiet.store.activities.update('s', 'main', {status: 'completed'});
  assert.equal(quiet.headerRow().text.trim(), 'Logox', 'no stage was written: just the name');
});

test('an actor window header follows the same rules for that actor', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'kalon', 'user', 'Do it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'});
  const header = () => {
    const row = buildStageRows(store.getSnapshot(), 's', 'kalon', 110, {}, null).find(r => r.messageId.endsWith('-who') && r.railGlyph === cast.kalon!.symbol)!;
    return decorateRow(row, Date.now()).displayText!;
  };
  const id = steps.tool({id: 'x', name: 'Shell', arguments: JSON.stringify({command: 'sleep 99'})}); steps.start(id);
  assert.match(header(), spun('Kalon'));
  store.message('s', 'kalon', 'assistant', '⏵ Sketching the wing', {activityId: 'k'});
  assert.match(header(), spun('Kalon', ' Sketching the wing'));
  const question = ask(store, 'k', 'kalon');
  assert.match(header(), /^Kalon · Awaiting your answer\s*$/);
  store.interactions.cancel(question.requestId);
  store.activities.update('s', 'k', {phase: 'retry', detail: 'Connection interrupted. Retrying (1/5)...'});
  assert.match(header(), spun('Kalon', ' Retrying \\(1/5\\)'));
  store.activities.update('s', 'k', {phase: 'tool'});
  assert.match(header(), spun('Kalon', ' Sketching the wing'));
  steps.finish(id, 'completed', 'Shell\nok'); store.activities.update('s', 'k', {status: 'completed'});
  assert.equal(header().trim(), 'Kalon · Sketching the wing');
});

test('actor card subtitle: current stage, temporary states override it, a tool title never appears, the last stage stays when done', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig the pedals', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'kalon', 'user', 'Rig it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'});
  const card = () => buildStageRows(store.getSnapshot(), 's', 'logox', 130, {}, null).find(row => row.messageId === 'k')!.text;
  const id = steps.tool({id: 'x', name: 'Shell', arguments: JSON.stringify({command: 'sleep 99'})}); steps.start(id);
  assert.match(card(), /Kalon · Rig the pedals(?! ·)/, 'no stage: the main title alone');
  assert.ok(!/sleep|Shell/.test(card()));
  store.message('s', 'kalon', 'assistant', '⏵ Tracing the pedal phase', {activityId: 'k'});
  assert.match(card(), /Kalon · Rig the pedals · Tracing the pedal phase/);
  assert.ok(!/sleep|Shell/.test(card()));
  const question = ask(store, 'k', 'kalon');
  assert.match(card(), /Rig the pedals · Awaiting your answer/);
  store.interactions.cancel(question.requestId);
  const permission = approve(store, 'k', 'kalon');
  assert.match(card(), /Rig the pedals · Awaiting approval/);
  store.interactions.cancel(permission.requestId);
  store.activities.update('s', 'k', {phase: 'retry', detail: 'Connection interrupted. Retrying (3/5)...'});
  assert.match(card(), /Rig the pedals · Retrying \(3\/5\)/);
  store.activities.update('s', 'k', {phase: 'compacting'});
  assert.match(card(), /Rig the pedals · Compacting context/);
  store.activities.update('s', 'k', {phase: 'tool'});
  assert.match(card(), /Rig the pedals · Tracing the pedal phase/, 'the stage returns');
  steps.finish(id, 'completed', 'Shell\nok'); store.activities.update('s', 'k', {status: 'completed'});
  assert.match(card(), /Rig the pedals · Tracing the pedal phase/, 'the last stage stays after the actor finishes');
});
