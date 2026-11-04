import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {compactParagraphs, trimTrailingBlankLines, type SceneRow} from '../src/tui/timeline/scene.js';

function fixture(owner: 'kalon' | 'logox' = 'kalon') {
  const store = new RuntimeStore();
  let now = Date.now() - 20_000;
  const actor = owner === 'kalon';
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: owner, kind: actor ? 'actor' : 'director', title: 'Pelican', taskTitle: 'Pelican', status: 'completed', stage: 'Completed', detail: ''});
  store.message('s', owner, 'user', 'Go.', {activityId: 'a', inputKind: actor ? 'director' : 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: owner}, () => now);
  const rows = (folds: Record<string, boolean> = {a: true}) => buildStageRows(store.getSnapshot(), 's', 'logox', 120, folds, null);
  return {store, steps, advance: (ms: number) => {now += ms;}, rows};
}
const text = (row: SceneRow) => (row.displayText ?? row.text).replace(/[│\s]/g, '');
const blank = (row: SceneRow) => text(row) === '';
const reply = (store: RuntimeStore, owner: string, body: string) => store.message('s', owner, 'assistant', body, {activityId: 'a'});

test('thinking text drops blank lines at the edges and between paragraphs, keeping paragraphs on separate rows under the thought marker', () => {
  const raw = '\n\nFirst paragraph.\n\n\nSecond paragraph.\n\nThird.\n\n';
  assert.equal(compactParagraphs(raw), 'First paragraph.\nSecond paragraph.\nThird.');
  const f = fixture();
  const id = f.steps.thinking(); f.store.appendMessage(id, raw); f.advance(2000); f.steps.finish(id, 'completed'); f.steps.endGroup('completed');
  const message = f.store.getSnapshot().messages.find(m => m.kind === 'thinking')!;
  const rows = f.rows({a: true, [message.id]: true});
  const first = rows.findIndex(r => /^∴Firstparagraph\.$/.test(text(r)));
  assert.ok(first >= 0, 'thinking body renders');
  assert.deepEqual(rows.slice(first + 1, first + 3).map(text), ['Secondparagraph.', 'Third.']);
  assert.equal(rows[first - 1] && blank(rows[first - 1]!), false, 'no empty row between the header and the body');
  assert.equal(message.text, raw, 'stored data is untouched');
});

test('trailing newlines in tool output never become an empty row, interior blank lines stay', () => {
  assert.equal(trimTrailingBlankLines('a\n\n  \n'), 'a');
  assert.equal(trimTrailingBlankLines('  indented\n'), '  indented');
  const f = fixture();
  const id = f.steps.tool({id: 'sh1', name: 'Shell', arguments: JSON.stringify({command: 'python build.py'})});
  f.steps.start(id); f.advance(300);
  f.steps.finish(id, 'completed', 'Shell\nExit code: 0\nline one\n\nline three\n\n');
  const tool = f.store.getSnapshot().messages.find(m => m.kind === 'tool')!;
  const rows = f.rows({a: true, [tool.id]: true});
  const first = rows.findIndex(r => text(r) === 'lineone');
  assert.ok(first >= 0, 'tool body renders');
  assert.deepEqual(rows.slice(first, first + 3).map(text), ['lineone', '', 'linethree']);
  assert.ok(!rows[first + 3] || !blank(rows[first + 3]!) || /spacer|-bottom/.test(rows[first + 3]!.messageId) , 'nothing blank after the last output line unless it is card spacing');
});

for (const owner of ['kalon', 'logox'] as const) {
  test(`a reply with leading or trailing newlines adds no empty rows (${owner})`, () => {
    const f = fixture(owner);
    reply(f.store, owner, '\n\nAll done.\n\nSecond paragraph.\n\n\n');
    const rows = f.rows();
    const first = rows.findIndex(r => text(r) === 'Alldone.');
    assert.ok(first >= 0);
    assert.equal(rows[first - 1] && text(rows[first - 1]!) !== '' || rows[first - 1]!.messageId.startsWith('spacer'), true, 'no leading empty markdown row');
    assert.deepEqual(rows.slice(first, first + 3).map(text), ['Alldone.', '', 'Secondparagraph.'], 'the paragraph break is kept as the only blank row');
    const last = rows.findLastIndex(r => text(r) === 'Secondparagraph.');
    assert.ok(rows.slice(last + 1).every(r => !blank(r) || /spacer|-bottom/.test(r.messageId)), 'no trailing empty markdown row');
  });

  test(`an empty or narration-only reply draws no empty rows (${owner})`, () => {
    const f = fixture(owner);
    reply(f.store, owner, '   \n');
    reply(f.store, owner, '⏵ Checking the pelican files\n');
    const rows = f.rows();
    const messageIds = f.store.getSnapshot().messages.filter(m => m.role === 'assistant').map(m => m.id);
    assert.ok(!rows.some(r => messageIds.includes(r.messageId) && blank(r)), 'no empty rows owned by empty assistant messages');
  });
}
