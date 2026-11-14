import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {dispatchNotes} from '../src/tools/orchestration/ActorTool/notes.js';
import {dispatchedResult} from '../src/tools/orchestration/ActorTool/prompt.js';

const cwd = tmpdir();
const task = (ownerId: string, extra: Record<string, unknown> = {}) => ({ownerId, prompt: 'x', ...extra});

test('parallel owners that share a path, a directory prefix or a glob get one overlap note', () => {
  const notes = dispatchNotes([task('techne', {owns: ['src/ui/'], acceptance: ['a']}), task('kalon', {owns: ['src/ui/theme.css'], acceptance: ['b']})], cwd);
  assert.deepEqual(notes, ['Note: techne and kalon both own src/ui/ and run in parallel. File locks keep the edits safe; set `after` or split the paths if one must build on the other.']);
  assert.equal(dispatchNotes([task('techne', {owns: ['src/**/*.ts'], acceptance: ['a']}), task('aletheia', {owns: ['src/a.ts'], acceptance: ['b']})], cwd).length, 1);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['src/a.ts'], acceptance: ['a']}), task('kalon', {owns: ['assets/'], acceptance: ['b']})], cwd), []);
});

test('an after relation in either direction silences the overlap note', () => {
  for (const [first, second] of [[{after: ['techne']}, {}], [{}, {after: ['kalon']}]]) {
    const notes = dispatchNotes([task('techne', {owns: ['src'], acceptance: ['a'], ...second}), task('kalon', {owns: ['src'], acceptance: ['b'], ...first})], cwd);
    assert.deepEqual(notes, []);
  }
});

test('missing owns is noted only beside other owners and missing acceptance only when owns is set', () => {
  assert.deepEqual(dispatchNotes([task('techne')], cwd), []);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['a.ts'], acceptance: ['ok']}), task('kalon')], cwd),
    ['Note: kalon has no `owns`, so teammates are not told which files it is changing.']);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['a.ts']})], cwd),
    ['Note: techne has no `acceptance`, so its report comes back without checks to read it against.']);
});

test('resume tasks are ignored and tasks of one owner are grouped', () => {
  assert.deepEqual(dispatchNotes([task('techne', {resumeTask: 'a1'}), task('kalon', {resumeTask: 'a2'})], cwd), []);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['a.ts']}), task('techne', {acceptance: ['ok']})], cwd), []);
});

test('notes follow the dispatch result on their own lines', () => {
  const tasks = [{activityId: 'a1', ownerId: 'techne', title: 'Build', owns: ['src/a.ts'], after: ['a0']}];
  const text = dispatchedResult(tasks, 'b1', ['Note: one', 'Note: two']);
  assert.match(text, /\nNote: one\nNote: two$/);
  assert.match(text, /^Dispatched to techne \(Batch b1\):\n- a1 techne: Build \| owns: src\/a\.ts \| after: a0\n/);
  assert.equal(dispatchedResult(tasks, 'b1'), dispatchedResult(tasks, 'b1', []));
});
