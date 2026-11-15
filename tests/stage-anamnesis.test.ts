import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';

function fixture() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'completed', stage: 'Completed', detail: ''});
  const say = (text: string, time: number) => store.message('s', 'logox', 'user', text, {activityId: 'main', inputKind: 'human', time});
  const note = (id: string, stage: string, createdAt: number | undefined, detail = '') => store.activities.create({sessionId: 's', activityId: id, ownerId: 'anamnesis',
    kind: 'anamnesis', title: 'Anamnesis', status: 'completed', stage, detail, ...(createdAt === undefined ? {} : {createdAt})});
  const rows = (folds: Record<string, boolean> = {}) => buildStageRows(store.getSnapshot(), 's', 'logox', 100, folds, null);
  const at = (text: string, folds?: Record<string, boolean>) => rows(folds).findIndex(row => (row.displayText ?? row.text).includes(text));
  return {store, say, note, rows, at};
}

test('an Anamnesis card sits where it began among the messages, not at the end of the timeline', () => {
  const f = fixture();
  f.say('FIRST-MESSAGE', 1000);
  f.say('SECOND-MESSAGE', 3000);
  f.say('THIRD-MESSAGE', 5000);
  f.note('b', 'RECAP-AFTER-SECOND', 4000);
  f.note('a', 'RECAP-AFTER-FIRST', 2000);
  const order = ['FIRST-MESSAGE', 'RECAP-AFTER-FIRST', 'SECOND-MESSAGE', 'RECAP-AFTER-SECOND', 'THIRD-MESSAGE'].map(text => f.at(text));
  assert.ok(order.every(index => index >= 0), 'every message and card renders: ' + order.join(','));
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'chronological order');
});

test('a card without a creation time keeps the old place after the last message, and a card after the last message follows it', () => {
  const f = fixture();
  f.say('ONLY-MESSAGE', 1000);
  f.note('late', 'AFTER-EVERYTHING', 9000);
  f.note('untimed', 'NO-TIME', undefined);
  const [message, late, untimed] = ['ONLY-MESSAGE', 'AFTER-EVERYTHING', 'NO-TIME'].map(text => f.at(text));
  assert.ok(message! >= 0 && message! < late! && late! < untimed!, [message, late, untimed].join(','));
});

test('the card body (the rest of the note) follows its title when the card is open', () => {
  const f = fixture();
  f.say('HELLO', 1000);
  f.note('a', 'Where the work stands', 2000, 'Done: shipped the thing\nOpen: nothing\nNext: rest');
  assert.ok(f.at('Done: shipped the thing', {a: true}) > f.at('Where the work stands', {a: true}));
});

test('companion windows never show the Anamnesis card', () => {
  const f = fixture();
  f.say('HELLO', 1000);
  f.note('a', 'ONLY-IN-DIRECTOR-VIEW', 2000);
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'kalon', 100, {}, null);
  assert.ok(!rows.some(row => (row.displayText ?? row.text).includes('ONLY-IN-DIRECTOR-VIEW')));
});
