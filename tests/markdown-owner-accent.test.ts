import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {cast} from '../src/actors/ensemble.js';
import {ownerColor} from '../src/tui/appearance/actor-style.js';
import {palette} from '../src/tui/appearance/theme.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

function fixture() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 'Pelican', taskTitle: 'Pelican', status: 'completed', stage: 'Completed', detail: ''});
  store.message('s', 'kalon', 'user', 'Please inspect `briefcode` now.', {activityId: 'a', inputKind: 'director', source: 'logox'});
  store.message('s', 'kalon', 'assistant', 'The fix lives in `reportcode` and works.', {activityId: 'a'});
  return store;
}
const colorOf = (rows: readonly SceneRow[], word: string): string[] =>
  rows.flatMap(row => (row.segments ?? []).filter(s => s.text.includes(word)).map(s => s.color ?? ''));

test('actor-authored inline code keeps the actor colour in the Logox timeline card and in the actor window', () => {
  const store = fixture();
  const folds = {a: true, 'a-goal': true};
  const inLogox = buildStageRows(store.getSnapshot(), 's', 'logox', 120, folds, null);
  const inActor = buildStageRows(store.getSnapshot(), 's', 'kalon', 120, folds, null);
  const kalon = ownerColor('kalon', cast);
  assert.notEqual(kalon, palette.accent);
  assert.deepEqual(colorOf(inLogox, 'reportcode'), [kalon]);
  assert.deepEqual(colorOf(inActor, 'reportcode'), [kalon]);
});

test('a brief authored by Logox keeps the Logox colour in both windows', () => {
  const store = fixture();
  const folds = {a: true, 'a-goal': true};
  for (const view of ['logox', 'kalon']) {
    const rows = buildStageRows(store.getSnapshot(), 's', view, 120, folds, null);
    const colors = colorOf(rows, 'briefcode');
    assert.ok(colors.length > 0, `brief renders in ${view}`);
    assert.ok(colors.every(color => color === palette.accent), `brief accent is Logox in ${view}`);
  }
});

test('Logox-authored replies keep the Logox colour', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'l', ownerId: 'logox', kind: 'director', title: 'T', taskTitle: 'T', status: 'completed', stage: 'Completed', detail: ''});
  store.message('s', 'logox', 'user', 'Go.', {activityId: 'l', inputKind: 'human'});
  store.message('s', 'logox', 'assistant', 'Use `logoxcode` here.', {activityId: 'l'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 120, {l: true}, null);
  assert.deepEqual(colorOf(rows, 'logoxcode'), [palette.accent]);
});
