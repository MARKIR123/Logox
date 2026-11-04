import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {groupToolMessages, summarizeGroup, type ToolGroup} from '../src/tui/timeline/tool-groups.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';
import {palette} from '../src/tui/appearance/theme.js';
import {faintColor} from '../src/tui/appearance/colors.js';
import {cast} from '../src/actors/ensemble.js';
import {pairSendMessages} from '../src/tools/coordination/SendMessageTool/pairing.js';
import {toolFixture, rowText} from './tool-fixture.js';

const texts = (rows: readonly SceneRow[]) => rows.map(rowText);
const joined = (rows: readonly SceneRow[]) => texts(rows).join('\n');

// ---------------------------------------------------------------- WebFetch
test('WebFetch: domain title, underlined URL with bold domain, page title with facts, rendered excerpt and no raw HTML', () => {
  const result = '[Fetched from: https://example.com/docs/a | HTTP 200 | Title: Example Docs]\n\n# Example Docs\n\nSome **bold** text and a [link](https://x.dev/y).\n\n<div class="x">raw <b>markup</b></div>\n\n- one\n- two';
  const {id, rows} = toolFixture('WebFetch', {url: 'https://example.com/docs/a'}, result);
  const all = rows();
  const header = all.find(row => row.messageId === id)!;
  assert.match(rowText(header), /^▾ WebFetch\(example\.com\) · 0\.0s\s*$/, 'bare domain title, no summary');
  const url = all.find(row => rowText(row).trim() === 'https://example.com/docs/a')!;
  assert.ok(url.segments!.filter(segment => segment.text.trim()).every(segment => segment.underline && segment.color === palette.link));
  assert.equal(url.segments!.find(segment => segment.text === 'example.com')!.bold, true, 'the domain is bold');
  const title = all.find(row => /^\s*Example Docs · 200 · /.test(rowText(row)))!;
  assert.ok(title, joined(all));
  assert.equal(title.segments!.find(segment => segment.text === 'Example Docs')!.bold, true);
  assert.equal(title.segments!.find(segment => segment.text.startsWith(' · 200'))!.color, faintColor());
  const excerpt = joined(all);
  assert.match(excerpt, /Some bold text and a link/);
  assert.match(excerpt, /• one/);
  assert.doesNotMatch(excerpt.replace(/\n/g, ' '), /<div|<b>|class="x"/, 'markup is stripped, never dumped');
  const link = all.flatMap(row => row.segments ?? []).find(segment => segment.text === 'https://x.dev/y');
  assert.ok(link?.underline, 'links in the excerpt are underlined');
});

test('WebFetch: empty pages use the shared empty state; HTML bodies are reduced to text; failures use the failure view', () => {
  const empty = toolFixture('WebFetch', {url: 'https://example.com/'}, '[Fetched https://example.com/: Document body is empty]').rows();
  assert.ok(empty.some(row => rowText(row).trim() === 'Empty page'));
  const html = joined(toolFixture('WebFetch', {url: 'https://example.com/'}, '[Fetched from: https://example.com/]\n\n<html><body><h1>Hi</h1><p>Plain words</p><script>evil()</script></body></html>').rows());
  assert.match(html, /Plain words/);
  assert.doesNotMatch(html, /<html|<p>|evil/);
  const failed = toolFixture('WebFetch', {url: 'https://example.com/x'}, 'Failed to fetch https://example.com/x: HTTP 404 Not Found', 'failed').rows();
  assert.match(texts(failed).find(row => row.includes('WebFetch'))!, /WebFetch\(example\.com\) · Failed to fetch .*HTTP 404/);
});

// ---------------------------------------------------------------- Browser
const pw = (tool: string, args: Record<string, unknown> = {}) => ({server: 'playwright', action: 'call', tool, arguments: args});

function browserScene(owner = 'logox') {
  const store = new RuntimeStore();
  const actor = owner !== 'logox';
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: owner, kind: actor ? 'actor' : 'director', title: 'Browse', status: 'running', stage: 'x', detail: ''});
  store.message('s', actor ? owner : 'user', 'user', 'Go.', {activityId: 'a', inputKind: actor ? 'director' : 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: owner});
  let count = 0;
  const call = (name: string, args: unknown, result = 'ok', state: 'completed' | 'failed' = 'completed') => {
    const id = steps.tool({id: 'c' + count++, name, arguments: JSON.stringify(args)});
    steps.start(id); steps.finish(id, state, name + '\n' + result, state === 'failed' ? 'error' : undefined);
    return id;
  };
  const rows = (folds: Record<string, boolean> = {}, view = 'logox') => buildStageRows(store.getSnapshot(), 's', view, 110, folds, null);
  const groupId = () => store.getSnapshot().messages.find(message => message.kind === 'tool')!.id + '-group';
  return {store, call, rows, groupId};
}

test('Browser: consecutive page actions merge into one `Browser` card with `N actions`, collapsed by default', () => {
  const f = browserScene();
  f.call('mcp', pw('browser_navigate', {url: 'https://example.com/app'}));
  f.call('mcp', pw('browser_click', {element: 'START', target: 'e3'}));
  f.call('mcp', pw('browser_take_screenshot'));
  f.call('mcp', pw('browser_close'));
  f.call('mcp__playwright__browser_snapshot', {});
  const collapsed = f.rows();
  const headers = texts(collapsed).filter(row => /Browser/.test(row));
  assert.equal(headers.length, 1, texts(collapsed).join('|'));
  assert.match(headers[0]!, /^▸ Browser · 5 actions/);
  assert.ok(!texts(collapsed).some(row => /Opened|Clicked/.test(row)), 'actions fold into the card');
});

test('Browser: opening, inspecting, interacting, screenshotting and closing read as plain-language rows, each with its own mark', () => {
  const f = browserScene();
  const ids = [
    f.call('mcp', pw('browser_navigate', {url: 'https://example.com/app'}), '### Page\n- Page URL: https://example.com/app'),
    f.call('mcp', pw('browser_click', {element: 'START', target: 'e3'})),
    f.call('mcp', pw('browser_type', {element: 'Name field', text: 'Ada'})),
    f.call('mcp', pw('browser_press_key', {key: 'Enter'})),
    f.call('mcp', pw('browser_take_screenshot'), '### Result\n[Screenshot of viewport](/tmp/shot-1.png)'),
    f.call('mcp', pw('browser_snapshot'), '### Page\n- Page URL: https://example.com/app\n- Page Title: App\n### Snapshot\n```yaml\n- button "START" [ref=e3]\n- text: Running\n```'),
    f.call('mcp', pw('browser_console_messages'), '### Result\nTotal messages: 3 (Errors: 2, Warnings: 0)\n[ERROR] Boom @ http://x/a.js:1\n[ERROR] Again\n[LOG] fine'),
    f.call('mcp', pw('browser_evaluate', {function: '() => document.title'}), '### Result\n"App"'),
    f.call('mcp', pw('browser_wait_for', {text: 'Done'})),
    f.call('mcp', pw('browser_close')),
  ];
  const rows = f.rows({[f.groupId()]: true, [ids[5]!]: true, [ids[6]!]: true, [ids[7]!]: true});
  const text = texts(rows).map(row => row.trim());
  const row = (pattern: RegExp) => rows.find(candidate => pattern.test(rowText(candidate).trim()))!;
  for (const expected of [/^▮ Opened https:\/\/example\.com\/app/, /^▮ Clicked "START"/, /^▮ Typed "Ada" into Name field/, /^▮ Pressed Enter/,
    /^▮ Screenshot → \/tmp\/shot-1\.png/, /^▾ Snapshot of App/, /^▾ Console · 2 errors · Boom/, /^▾ Evaluated \(\) => document\.title/, /^▮ Waited for "Done"/, /^▮ Closed browser/]) {
    assert.ok(text.some(line => expected.test(line)), String(expected) + '\n' + text.join('\n'));
  }
  const opened = row(/Opened/);
  const url = opened.segments!.find(segment => segment.text === 'https://example.com/app')!;
  assert.ok(url.underline && url.color === palette.link, 'the URL is underlined in the link color');
  assert.equal(row(/Screenshot/).segments!.find(segment => segment.text.includes('shot-1.png'))!.color, palette.path);
  assert.equal(row(/Console/).segments!.find(segment => segment.selectionKey?.endsWith(':icon'))!.color, palette.error, 'errors turn the mark red');
  assert.ok(text.includes('- button "START" [ref=e3]'), 'snapshot rows expand');
  assert.ok(text.includes('[ERROR] Again') && text.includes('[LOG] fine'));
  assert.ok(text.includes('"App"'));
  assert.equal(row(/Clicked/).action, undefined, 'a row without a useful body is not expandable');
  assert.ok(row(/Snapshot of App/).action, 'a row with a body is');
});

test('Browser: a clean console is a plain mark; a failed action shows the shared failure row; reads and browsing never share a card', () => {
  const f = browserScene();
  f.call('mcp', pw('browser_console_messages'), '### Result\nTotal messages: 0 (Errors: 0, Warnings: 0)');
  f.call('mcp', pw('browser_click', {element: 'Gone'}), 'Element not found', 'failed');
  f.call('mcp', pw('browser_navigate', {url: 'https://example.com/'}));
  const groups = f.store.getSnapshot().messages.filter(message => message.kind === 'tool').map(message => message.id + '-group');
  const rows = f.rows({[groups[0]!]: true, [groups[2]!]: true});
  const text = texts(rows).map(row => row.trim());
  assert.equal(text.filter(line => /^[▸▾] Browser · 1 action/.test(line)).length, 2, 'the failure splits the sequence: ' + text.join('|'));
  assert.ok(text.some(line => /^▮ Console · no errors/.test(line)), text.join('|'));
  assert.ok(text.some(line => /^▮ Clicked "Gone" · Element not found/.test(line)));
  assert.ok(text.some(line => /^▮ Opened https:\/\/example\.com\//.test(line)), 'a lone page action after a failure is still its own card');
});

test('Browser: groupToolMessages keeps browser runs apart from Read/Grep/Shell runs and never merges two actors', () => {
  const f = browserScene();
  f.call('Read', {file_path: 'a.ts'}); f.call('Read', {file_path: 'b.ts'});
  f.call('mcp', pw('browser_navigate', {url: 'https://example.com/'})); f.call('mcp', pw('browser_click', {element: 'x'}));
  f.call('Shell', {command: 'ls'}); f.call('Shell', {command: 'pwd'});
  const groups = groupToolMessages(f.store.getSnapshot().messages.filter(message => message.kind === 'tool')).filter((item): item is ToolGroup => item.type === 'group');
  assert.deepEqual(groups.map(group => group.kind), ['explore', 'browser', 'explore']);
  assert.equal(summarizeGroup(groups[0]!), 'read 2 files');
  assert.equal(groups[1]!.counts.browse, 2);
});

// ---------------------------------------------------------------- Generic and default tools
test('default tool card: arguments as aligned key/value rows, rendered result, `No output` when empty', () => {
  const rows = toolFixture('ExternalTool', {path: 'src/a.ts', limit: 5, nested: {a: [1, 2]}}, '# Done\n\n- **one**').rows();
  const text = texts(rows).map(row => row.trim());
  assert.ok(text.includes('path    src/a.ts') || text.some(line => /^path\s+src\/a\.ts$/.test(line)), text.join('|'));
  assert.ok(text.some(line => /^nested\s+\{"a":\[1,2\]\}$/.test(line)));
  assert.ok(text.some(line => line.startsWith('• one')), 'Markdown results are rendered');
  const empty = toolFixture('ExternalTool', {}, '').rows();
  assert.ok(texts(empty).some(row => row.trim() === 'No output'));
});

// ---------------------------------------------------------------- SendMessage
function conversation() {
  const store = new RuntimeStore();
  for (const [owner, id] of [['techne', 'ta'], ['kalon', 'ka']] as const) {
    store.activities.create({sessionId: 's', activityId: id, ownerId: owner, kind: 'actor', title: owner, status: 'running', stage: 'x', detail: ''});
    store.message('s', owner, 'user', 'Task.', {activityId: id, inputKind: 'director'});
  }
  const steps = {techne: new Steps(store, {sessionId: 's', activityId: 'ta', ownerId: 'techne'}), kalon: new Steps(store, {sessionId: 's', activityId: 'ka', ownerId: 'kalon'})};
  let count = 0;
  const send = (from: 'techne' | 'kalon', args: Record<string, unknown>, state: 'completed' | 'failed' = 'completed') => {
    const id = steps[from].tool({id: 's' + count++, name: 'SendMessage', arguments: JSON.stringify(args)});
    steps[from].start(id); steps[from].finish(id, state, 'SendMessage\nDelivered.', state === 'failed' ? 'error' : undefined);
    return id;
  };
  const view = (who: string, folds: Record<string, boolean> = {}) => buildStageRows(store.getSnapshot(), 's', who, 110, folds, null);
  return {store, send, view};
}

test('SendMessage: an ask shows `ask · awaiting reply` and `Q`; once answered the card says `answered` with Q then A', () => {
  const f = conversation();
  const ask = f.send('techne', {to: 'kalon', type: 'ask', message: 'Is the art ready?'});
  let rows = f.view('techne', {[ask]: true});
  let header = rows.find(row => row.messageId === ask)!;
  assert.match(rowText(header), /^▾ SendMessage to ✧ Kalon · ask · awaiting reply/);
  const target = header.segments!.find(segment => segment.text === '✧ Kalon')!;
  assert.equal(target.color, cast.kalon.color);
  assert.equal(target.bold, true);
  assert.deepEqual(texts(rows).filter(row => /^\s+[QA]  /.test(row)).map(row => row.trim()), ['Q  Is the art ready?']);
  assert.equal(rows.find(row => /Q {2}Is the/.test(rowText(row)))!.segments!.find(segment => segment.text.startsWith('Q'))!.color, faintColor(), 'labels are faint');

  f.send('kalon', {to: 'techne', type: 'reply', message: 'Yes, ready at assets/art.png'});
  rows = f.view('techne', {[ask]: true});
  header = rows.find(row => row.messageId === ask)!;
  assert.match(rowText(header), /· ask · answered/);
  assert.deepEqual(texts(rows).filter(row => /^\s+[QA]  /.test(row)).map(row => row.trim()), ['Q  Is the art ready?', 'A  Yes, ready at assets/art.png']);
});

test('SendMessage: the replier\'s card shows the original question before its own answer; a follow-up ask is labelled `ask`', () => {
  const f = conversation();
  f.send('techne', {to: 'kalon', type: 'ask', message: 'Is the art ready?'});
  const reply = f.send('kalon', {to: 'techne', type: 'reply', message: 'Almost, one more pass.'});
  const rows = f.view('kalon', {[reply]: true});
  assert.match(rowText(rows.find(row => row.messageId === reply)!), /^▾ SendMessage to ⊞ Techne · reply/);
  assert.deepEqual(texts(rows).filter(row => /^\s+[QA]  /.test(row)).map(row => row.trim()), ['Q  Is the art ready?', 'A  Almost, one more pass.']);

  const g = conversation();
  g.send('techne', {to: 'kalon', type: 'ask', message: 'Which palette?'});
  const follow = g.send('kalon', {to: 'techne', type: 'ask', message: 'Warm or cold?'});
  const followRows = g.view('kalon', {[follow]: true});
  assert.match(rowText(followRows.find(row => row.messageId === follow)!), /· ask · \d/);
  assert.deepEqual(texts(followRows).filter(row => /^\s+Q  /.test(row)).map(row => row.trim()), ['Q  Which palette?', 'Q  Warm or cold?']);
});

test('SendMessage: an inform shows its text; pairing follows the runtime rule (a reply closes every open ask between the pair)', () => {
  const f = conversation();
  const inform = f.send('techne', {to: 'kalon', message: 'FYI the rig is merged.'});
  const rows = f.view('techne', {[inform]: true});
  assert.match(rowText(rows.find(row => row.messageId === inform)!), /^▾ SendMessage to ✧ Kalon · inform/);
  assert.ok(texts(rows).some(row => row.trim() === 'FYI the rig is merged.'));

  const g = conversation();
  const a = g.send('techne', {to: 'kalon', type: 'ask', message: 'First?'});
  const b = g.send('techne', {to: 'kalon', type: 'ask', message: 'Second?'});
  const r = g.send('kalon', {to: 'techne', type: 'reply', message: 'Both done.'});
  const pairs = pairSendMessages(g.store.getSnapshot().messages);
  assert.equal(pairs.get(a)?.answered, true);
  assert.equal(pairs.get(b)?.answered, true);
  assert.equal(pairs.get(r)?.question, 'Second?');
});

test('SendMessage: actor-to-actor messages stay out of the Director timeline unless Logox sends or receives', () => {
  const f = conversation();
  const peer = f.send('techne', {to: 'kalon', type: 'ask', message: 'PEER_ONLY_QUESTION'});
  const toLogox = f.send('kalon', {to: 'logox', type: 'inform', message: 'For the Director'});
  const open = {ka: true, ta: true, [peer]: true, [toLogox]: true};
  const logox = f.view('logox', open);
  assert.ok(!joined(logox).includes('PEER_ONLY_QUESTION'), 'hidden from the main timeline');
  assert.ok(!logox.some(row => row.messageId === peer));
  assert.ok(logox.some(row => row.messageId === toLogox), 'addressed to Logox: shown');
  assert.ok(f.view('techne', {[peer]: true}).some(row => row.messageId === peer), 'the sender\'s own window shows it');

  const director = conversation();
  const fromLogox = (() => {
    const steps = new Steps(director.store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
    director.store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
    const id = steps.tool({id: 'l1', name: 'SendMessage', arguments: JSON.stringify({to: 'kalon', type: 'ask', message: 'Director question'})});
    steps.start(id); steps.finish(id, 'completed', 'SendMessage\nDelivered.');
    return id;
  })();
  assert.ok(director.view('logox', {[fromLogox]: true}).some(row => row.messageId === fromLogox), 'sent by Logox: shown');
});

// ---------------------------------------------------------------- AskUserQuestion
test('AskUserQuestion: an answered card is a record of Q and bold user-colour A', () => {
  const args = {questions: [
    {question: 'Which theme?', header: 'Theme', options: [{label: 'Dark', description: ''}, {label: 'Light', description: ''}]},
    {question: 'Extras?', header: 'Extras', multiSelect: true, options: [{label: 'Icons', description: ''}, {label: 'Sounds', description: ''}, {label: 'Mascot', description: ''}]},
    {question: 'Anything else?', header: 'Other'},
  ]};
  const result = JSON.stringify({status: 'answered', response: {answers: {q0: {type: 'option', optionId: 'o1'}, q1: {type: 'options', optionIds: ['o0', 'o2']}, q2: {type: 'text', text: 'Make it fast'}}}});
  const {id, rows} = toolFixture('AskUserQuestion', args, result);
  const all = rows();
  assert.match(rowText(all.find(row => row.messageId === id)!), /^▾ AskUserQuestion · Theme · answered/);
  const lines = texts(all).filter(row => /^\s+[QA]  /.test(row)).map(row => row.trim());
  assert.deepEqual(lines, ['Q  Which theme?', 'A  Light', 'Q  Extras?', 'A  Icons, Mascot', 'Q  Anything else?', 'A  Make it fast']);
  const answer = all.find(row => /A {2}Light/.test(rowText(row)))!.segments!.find(segment => segment.text === 'Light')!;
  assert.equal(answer.bold, true);
  assert.equal(answer.color, palette.user);
});

test('AskUserQuestion: a cancelled card says `cancelled` with the questions only and a muted mark', () => {
  const {id, rows} = toolFixture('AskUserQuestion', {questions: [{question: 'Which theme?', header: 'Theme', options: [{label: 'Dark', description: ''}, {label: 'Light', description: ''}]}]},
    JSON.stringify({status: 'cancelled', reason: 'Cancelled by user'}), 'failed');
  const all = rows();
  const header = all.find(row => row.messageId === id)!;
  assert.match(rowText(header), /· cancelled/);
  assert.equal(header.segments!.find(segment => segment.selectionKey?.endsWith(':icon'))!.color, palette.muted);
  assert.ok(!texts(all).some(row => /^\s+A  /.test(row)));
  assert.ok(texts(all).some(row => row.trim() === 'Q  Which theme?'));
});

// ---------------------------------------------------------------- Hidden tools
const hiddenCases: [string, Record<string, unknown>, string][] = [
  ['Actor', {tasks: [{ownerId: 'kalon', title: 'Polish'}]}, 'Actor(kalon)'],
  ['ListActors', {}, 'ListActors'],
  ['ReadActor', {ownerId: 'kalon'}, 'ReadActor(kalon)'],
  ['LoadTools', {names: ['x']}, 'LoadTools'],
  ['UpdateTaskProgress', {label: 'x'}, 'UpdateTaskProgress'],
  ['_FinishRound', {title: 'Done'}, '_FinishRound'],
  ['_GitStatus', {}, '_GitStatus'],
];
for (const [name, args, label] of hiddenCases) {
  test(`${name}: nothing on success; one quiet row (red mark, muted title, red reason) on failure`, () => {
    const ok = toolFixture(name, args, 'fine').rows();
    assert.ok(!ok.some(row => row.messageId.startsWith('c1') || rowText(row).includes(label)), name + ' draws nothing: ' + joined(ok));
    const bad = toolFixture(name, args, 'Unknown actor kalon', 'failed');
    const rows = bad.rows();
    const hits = rows.filter(row => rowText(row).includes(label));
    assert.equal(hits.length, 1, joined(rows));
    const row = hits[0]!;
    assert.match(rowText(row), new RegExp('^[▮▾] ' + label.replace(/[()]/g, '\\$&') + ' · Unknown actor kalon · 0\\.0s\\s*$'));
    assert.equal(row.segments!.find(segment => segment.selectionKey?.endsWith(':icon'))!.color, palette.error);
    assert.equal(row.segments!.find(segment => segment.text.startsWith('Unknown actor'))!.color, palette.error);
    assert.ok(!rowText(row).includes('Error'), 'no separate Error label');
  });
}

test('hidden tools leave no blank rows and never appear in tool-group summaries', () => {
  const f = browserScene();
  f.call('Read', {file_path: 'a.ts'});
  f.call('ListActors', {});
  f.call('Actor', {tasks: [{ownerId: 'kalon', title: 'x'}]});
  f.call('_GitStatus', {});
  f.call('Read', {file_path: 'b.ts'});
  const rows = f.rows();
  const text = texts(rows);
  assert.ok(text.some(row => /^▸ [A-Z][\w' -]* 2 files/.test(row.trim())), 'the two reads still form one group: ' + text.join('|'));
  assert.ok(!text.some(row => /Listed actors|ListActors|Actor\(|_GitStatus/.test(row)));
  for (let index = 1; index < text.length; index++) assert.ok(!(text[index]!.trim() === '' && text[index - 1]!.trim() === ''), 'no double blank rows');
  const expanded = f.rows({[f.groupId()]: true});
  assert.ok(!texts(expanded).some(row => /ListActors|Actor\(|_GitStatus/.test(row)));
});

// ---------------------------------------------------------------- CancelActor
test('CancelActor: one fixed `■ Stopped <symbol> <Name>` row in the actor colour, not expandable', () => {
  const {id, rows} = toolFixture('CancelActor', {actor: 'techne', scope: 'activity', reason: 'Wrong direction'}, 'Cancelled.');
  const all = rows();
  const mine = all.filter(row => row.messageId === id);
  assert.equal(mine.length, 1, 'exactly one row');
  const row = mine[0]!;
  assert.match(rowText(row).trimEnd(), /^■ Stopped ⊞ Techne$/);
  assert.ok(row.segments!.filter(segment => segment.text.trim() && !segment.selectionKey?.startsWith('│')).every(segment => segment.color === cast.techne.color));
  assert.equal(row.action, undefined); assert.equal(row.hits, undefined); assert.equal(row.hover, undefined);
});
