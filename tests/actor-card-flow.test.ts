import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';

function card(report: string, source: 'model' | 'local', assistantTexts: string[], status: 'completed' | 'failed' = 'completed') {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 'Polish the page', status: 'running', stage: 'Working', detail: ''});
  store.message('s', 'kalon', 'user', 'Polish it', {activityId: 'a', inputKind: 'director'});
  assistantTexts.forEach((text, index) => {
    store.message('s', 'kalon', 'assistant', text, {activityId: 'a'});
    if (index < assistantTexts.length - 1) store.message('s', 'kalon', 'notice', 'Read\nfile.html', {activityId: 'a', kind: 'tool'});
  });
  store.activities.update('s', 'a', {status, summary: {title: 'Polished the page', report, source}});
  return buildStageRows(store.getSnapshot(), 's', 'logox', 80, {a: true}, null);
}
const indexOf = (rows: ReturnType<typeof card>, needle: string) => rows.findIndex(row => row.text.includes(needle));

test('a wrapped report is not repeated when its reply is in the transcript, and never sits above the transcript', () => {
  const report = 'Goal: Polish it\nStatus: Completed\nReply: The page is polished.';
  const rows = card(report, 'local', ['⏵ Polishing\nLooking at the page.', 'The page is polished.']);
  assert.equal(rows.filter(row => row.text.includes('Status: Completed')).length, 0, 'the delivering message is in the transcript');
  assert.equal(rows.filter(row => row.text.includes('The page is polished.')).length, 1);
});

test('a report with no delivering message closes the card after the transcript', () => {
  const rows = card('Goal: Polish it\nStatus: Failed; needs further handling', 'local', ['⏵ Polishing\nWorking.'], 'failed');
  const report = indexOf(rows, 'Status: Failed');
  assert.ok(report > indexOf(rows, 'Working.'), 'report comes after the transcript');
});

test('every row of an actor card hangs off the same col-0 rail', () => {
  const rows = card('Done.', 'model', ['⏵ Building the page\nFirst.', '⏵ Checking the page', 'Done.']);
  const body = rows.filter(row => row.messageId !== 'a' && /First\.|Checking the page|Done\./.test(row.text));
  assert.equal(body.length, 3);
  assert.equal(new Set(body.map(row => row.gutterCols)).size, 1, 'one indent for every prose row');
  assert.ok(body.every(row => row.prefixSegments?.some(segment => segment.text.includes('│'))), 'each row carries the rail');
});

test('a markdown heading in ordinary prose renders as prose, not as a stage', () => {
  const rows = card('Done.', 'model', ['### Notes\nSome detail.', 'Done.']);
  assert.ok(rows.some(row => row.text.includes('Notes')));
  assert.ok(rows.some(row => row.text.includes('Some detail.')));
  assert.ok(!rows.some(row => row.messageId !== 'a' && row.text.includes('✧')), 'no phase-heading row');
});
