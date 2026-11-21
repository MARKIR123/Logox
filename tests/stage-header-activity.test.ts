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

test('the header is the name alone: the model\'s ⏵ stage, tool titles, Thinking and clocks never follow it', () => {
  const f = fixture();
  const think = f.steps.thinking(); f.store.appendMessage(think, 'hmm');
  assert.match(f.header(), spun('Logox'), 'no stage yet while thinking');
  f.steps.finish(think, 'completed');
  f.tool();
  assert.match(f.header(), spun('Logox'), 'no stage yet while a tool runs');
  f.stage('Verifying the build');
  const text = f.header();
  assert.match(text, spun('Logox'), 'the Director window shows its tool calls itself: no activity after the name');
  assert.ok(!/Verifying|npm run|Shell|Thinking|\d+(\.\d)?s\b/.test(text), 'no stage, tool title, Thinking or elapsed time: ' + text);
  assert.equal(iconOf(f.headerRow()), undefined, 'no spinner in the header');
  assert.equal(f.headerRow().animation, undefined, 'the header carries no animation');
  assert.equal(f.headerRow().segments!.find(s => s.selectionKey?.endsWith(':activity_sep')), undefined, 'no separator without a wait state');
  f.stage('Packaging the result');
  assert.match(f.header(), spun('Logox'), 'a later stage does not show either');
});

test('temporary wait states follow the name while they hold and disappear afterwards', () => {
  const f = fixture();
  f.tool(); f.stage('Checking the layout');
  const base = spun('Logox');
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
  assert.equal(f.headerRow().segments!.find(s => s.selectionKey?.endsWith(':activity_sep'))!.color, faintColor(), 'the separator is faint');
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
  assert.match(g.header(), spun('Logox'));
});

test('a finished round has no spinner and no stage: just the name', () => {
  const f = fixture();
  const id = f.tool(); f.stage('Checking the layout'); f.stage('Final polish');
  f.steps.finish(id, 'completed', 'Shell\nok'); f.store.activities.update('s', 'main', {status: 'completed'});
  const row = f.headerRow();
  assert.equal(row.animation, undefined);
  assert.equal(row.text.trim(), 'Logox');
  assert.ok(!/\d+s\b/.test(row.text), 'no elapsed time');
  const quiet = fixture();
  const done = quiet.tool(); quiet.steps.finish(done, 'completed', 'Shell\nok'); quiet.store.activities.update('s', 'main', {status: 'completed'});
  assert.equal(quiet.headerRow().text.trim(), 'Logox', 'no stage was written: just the name');
});

test('an actor window header is the name alone, with only wait states after it', () => {
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
  assert.match(header(), spun('Kalon'), 'no activity after the name in the actor\'s own window');
  const question = ask(store, 'k', 'kalon');
  assert.match(header(), /^Kalon · Awaiting your answer\s*$/);
  store.interactions.cancel(question.requestId);
  store.activities.update('s', 'k', {phase: 'retry', detail: 'Connection interrupted. Retrying (1/5)...'});
  assert.match(header(), spun('Kalon', ' Retrying \\(1/5\\)'));
  store.activities.update('s', 'k', {phase: 'tool'});
  assert.match(header(), spun('Kalon'));
  steps.finish(id, 'completed', 'Shell\nok'); store.activities.update('s', 'k', {status: 'completed'});
  assert.equal(header().trim(), 'Kalon');
});

test('actor card subtitle: layer 1 from events, the reply\'s own ⏵ line on top, temporary states override, nothing stale after the end', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig the pedals', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'kalon', 'user', 'Rig it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'});
  const card = (width = 130) => buildStageRows(store.getSnapshot(), 's', 'logox', width, {}, null).find(row => row.messageId === 'k')!.text.replace(/\s+/g, ' ').trim();
  // Layer 1, no narration: the running tool's own card title.
  const id = steps.tool({id: 'x', name: 'Shell', arguments: JSON.stringify({command: 'sleep 99'})}); steps.start(id);
  assert.match(card(), /Kalon · Rig the pedals · Shell\(sleep 99\)/);
  // Several tools of one batch: the first running one and a count.
  const second = steps.tool({id: 'y', name: 'Read', arguments: JSON.stringify({file_path: 'a.ts'})}); steps.start(second);
  assert.match(card(), /Rig the pedals · Shell\(sleep 99\) \+1/);
  steps.finish(second, 'completed', 'Read\nok');
  // Layer 2: the reply's own line comes first, the running tool after it.
  store.message('s', 'kalon', 'assistant', '⏵ Tracing the pedal phase', {activityId: 'k'});
  assert.match(card(), /Kalon · Rig the pedals · Tracing the pedal phase · Shell\(sleep 99\)/);
  // A narrow card clips the narration first and keeps the running tool.
  const narrow = card(66);
  assert.match(narrow, /Rig the pedals · Shell/);
  assert.ok(!/Tracing the pedal phase/.test(narrow), 'the narration is the part that gives way: ' + narrow);
  // Temporary states replace the whole live part.
  const question = ask(store, 'k', 'kalon');
  assert.match(card(), /Rig the pedals · Awaiting your answer/);
  assert.ok(!/Shell|Tracing/.test(card()));
  store.interactions.cancel(question.requestId);
  const permission = approve(store, 'k', 'kalon');
  assert.match(card(), /Rig the pedals · Awaiting approval/);
  store.interactions.cancel(permission.requestId);
  store.activities.update('s', 'k', {phase: 'retry', detail: 'Connection interrupted. Retrying (3/5)...'});
  assert.match(card(), /Rig the pedals · Retrying \(3\/5\)/);
  store.activities.update('s', 'k', {phase: 'compacting'});
  assert.match(card(), /Rig the pedals · Compacting context/);
  store.activities.update('s', 'k', {phase: 'tool'});
  assert.match(card(), /Rig the pedals · Tracing the pedal phase · Shell\(sleep 99\)/, 'the live subtitle returns');
  // The tool ends: the reply's line alone, never a stale tool.
  steps.finish(id, 'completed', 'Shell\nok');
  assert.match(card(), /Rig the pedals · Tracing the pedal phase Running/);
  // The next request opens with no line of its own: back to layer 1, the thinking state.
  const next = steps.thinking();
  assert.match(card(), /Rig the pedals · Thinking Running/);
  steps.finish(next, 'completed');
  // A reply that wrote no line keeps layer 1 only.
  store.message('s', 'kalon', 'assistant', 'Plain reply.', {activityId: 'k'});
  assert.ok(!/Tracing/.test(card()));
  steps.close('completed'); store.activities.update('s', 'k', {status: 'completed'});
  assert.match(card(), /Kalon · Rig the pedals\s+Completed/, 'an ended card shows its main title only');
  assert.ok(!/Tracing|Thinking|Shell/.test(card()));
});

test('the card clock stays blank under a second, then ticks from the row animation without rebuilding rows', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig the pedals', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'kalon', 'user', 'Rig it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'}, () => Date.now() - 400);
  steps.thinking();
  const row = buildStageRows(store.getSnapshot(), 's', 'logox', 120, {}, null).find(r => r.messageId === 'k')!;
  const clock = (now: number) => decorateRow(row, now).displayText!.replace(/\s+/g, ' ');
  assert.match(clock(Date.now()), /Rig the pedals · Thinking Running/, 'under a second: no time');
  assert.match(clock(Date.now() + 12_000), /Rig the pedals · Thinking · 12\.\ds Running/, 'the same row shows the live time later');
});

test('a reply with no ⏵ line gets a fallback stage label from its latest tool call, only on the card subtitle and only when nothing runs or thinks; the model\'s own line wins', async () => {
  const {liveStatus, liveStatusLine} = await import('../src/tui/timeline/live-status.js');
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig the pedals', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'kalon', 'user', 'Rig it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'});
  const rows = () => buildStageRows(store.getSnapshot(), 's', 'logox', 130, {}, null);
  const card = () => rows().find(row => row.messageId === 'k')!.text.replace(/\s+/g, ' ').trim();
  const messages = () => store.getSnapshot().messages.filter(message => message.activityId === 'k');
  const call = (name: string, args: Record<string, unknown>) => {const id = steps.tool({id: name + messages().length, name, arguments: JSON.stringify(args)}); steps.start(id); return id;};
  // A running tool keeps its own card title (the label is only for the gap).
  const read = call('Read', {file_path: 'src/foo.ts'});
  assert.match(card(), /Rig the pedals · Read\(src\/foo\.ts\)/);
  assert.equal(liveStatus(messages())?.derived, undefined, 'nothing derived while the tool itself is the activity');
  // The tool ends and nothing else runs: the card keeps a meaningful stage instead of going blank.
  steps.finish(read, 'completed', 'Read\nok');
  assert.match(card(), /Kalon · Rig the pedals · Reading src\/foo\.ts/);
  const labels: [string, Record<string, unknown>, string][] = [
    ['Edit', {file_path: 'src/app.ts', old_string: 'a', new_string: 'b'}, 'Editing src/app.ts'],
    ['Shell', {command: 'npm test'}, 'Running npm test'],
    ['Grep', {pattern: 'foo'}, 'Searching "foo"'],
    ['Automa', {jobs: [{title: 'a', prompt: 'p'}, {title: 'b', prompt: 'p'}, {title: 'c', prompt: 'p'}]}, 'Dispatching 3 workers'],
  ];
  for (const [name, args, label] of labels) {
    steps.finish(call(name, args), 'completed', name + '\nok');
    assert.ok(card().includes('Rig the pedals · ' + label), label + ' in ' + card());
    assert.equal(liveStatusLine(liveStatus(messages())), label, 'the footer activity line reads the same');
  }
  // Display only: no timeline row other than the card header carries it, and no message (the ledger source) holds it.
  assert.ok(!rows().some(row => row.messageId !== 'k' && /Dispatching 3 workers|Reading src|Running npm/.test(row.displayText ?? row.text)));
  assert.ok(!messages().some(message => /Dispatching 3 workers|Running npm test|Reading src\/foo/.test(message.text)));
  // The model's own line wins over the label; the next request's thinking state replaces it.
  store.message('s', 'kalon', 'assistant', '⏵ Tracing the pedal phase', {activityId: 'k'});
  assert.match(card(), /Rig the pedals · Tracing the pedal phase/);
  assert.ok(!/Dispatching 3 workers/.test(card()));
  const next = steps.thinking();
  assert.match(card(), /Rig the pedals · Thinking/);
  assert.ok(!/Dispatching|Tracing/.test(card()), 'a new reply starts clean');
  steps.finish(next, 'completed');
});

test('the current activity shows only on a folded actor card: not on an open card, the actor window\'s own card, or any header', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  store.activities.create({sessionId: 's', activityId: 'k', ownerId: 'kalon', kind: 'actor', title: 'Rig', taskTitle: 'Rig the pedals', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'kalon', 'user', 'Rig it.', {activityId: 'k', inputKind: 'director', source: 'logox'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'k', ownerId: 'kalon'});
  const id = steps.tool({id: 'x', name: 'Shell', arguments: JSON.stringify({command: 'sleep 99'})}); steps.start(id);
  store.message('s', 'kalon', 'assistant', '⏵ Tracing the pedal phase', {activityId: 'k'});
  const text = (view: string, folds: Record<string, boolean>, match: (row: SceneRow) => boolean) =>
    buildStageRows(store.getSnapshot(), 's', view, 130, folds, null).filter(match).map(row => row.text.replace(/\s+/g, ' ').trim()).join('\n');
  const live = /Tracing the pedal phase|Shell\(sleep 99\)/;
  // Folded in the Director window: the activity is the only view of it.
  assert.match(text('logox', {}, row => row.messageId === 'k'), /Kalon · Rig the pedals · Tracing the pedal phase · Shell\(sleep 99\)/);
  // Open: the tool rows are visible, so the title row is the main title only.
  const open = text('logox', {k: true}, row => row.messageId === 'k');
  assert.match(open, /Kalon · Rig the pedals/);
  assert.ok(!live.test(open), 'open card title row: ' + open);
  // The Director's speaker header never carries it.
  assert.ok(!live.test(text('logox', {}, row => row.messageId.endsWith('-who'))));
  // The actor's own window: neither its header nor its outer card carries it.
  assert.ok(!live.test(text('kalon', {}, row => row.messageId.endsWith('-who') || row.messageId === 'k')));
});
