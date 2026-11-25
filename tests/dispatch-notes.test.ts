import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {dispatchNotes, liveOwnsNotes, ownsConflicts} from '../src/tools/orchestration/ActorTool/notes.js';
import {dispatchedResult, ownsConflictRefusal} from '../src/tools/orchestration/ActorTool/prompt.js';
import type {Activity} from '../src/runtime/contracts.js';

const cwd = tmpdir();
const task = (ownerId: string, extra: Record<string, unknown> = {}) => ({ownerId, prompt: 'x', ...extra});

test('owners that may run at the same time and share a path, a directory prefix or a glob are a conflict', () => {
  const conflicts = ownsConflicts([task('techne', {owns: ['src/ui/']}), task('kalon', {owns: ['src/ui/theme.css']})], cwd);
  assert.deepEqual(conflicts, [{a: 'techne', b: 'kalon', path: 'src/ui/'}]);
  assert.equal(ownsConflictRefusal(conflicts), 'Nothing was dispatched: tasks that may run at the same time both own the same files.\n- techne and kalon both own src/ui/\n' +
    'Give each file one owner, or order the tasks with `after` so one builds on the other, then call Actor again. Editing a file never needs owning it.');
  assert.equal(ownsConflicts([task('techne', {owns: ['src/**/*.ts']}), task('aletheia', {owns: ['src/a.ts']})], cwd).length, 1);
  assert.deepEqual(ownsConflicts([task('techne', {owns: ['src/a.ts']}), task('kalon', {owns: ['assets/']})], cwd), []);
  assert.deepEqual(ownsConflicts([task('techne', {owns: ['a.ts']}), task('techne', {owns: ['a.ts']})], cwd), [], 'one owner never conflicts with itself');
  assert.deepEqual(ownsConflicts([task('techne', {owns: ['a.ts'], resumeTask: 'r1'}), task('kalon', {owns: ['a.ts']})], cwd), [], 'a resumed task is not new work');
});

test('an after relation in either direction, also through another task of the call, orders the tasks: no conflict', () => {
  for (const [first, second] of [[{after: ['t']}, {}], [{}, {after: ['k']}]]) {
    assert.deepEqual(ownsConflicts([task('techne', {id: 't', owns: ['src'], ...second}), task('kalon', {id: 'k', owns: ['src'], ...first})], cwd), []);
  }
  const chain = [task('techne', {id: 't', owns: ['src']}), task('aletheia', {id: 'a', after: ['t']}), task('kalon', {owns: ['src'], after: ['a']})];
  assert.deepEqual(ownsConflicts(chain, cwd), [], 'kalon runs after aletheia, which runs after techne');
  const waves = [task('kalon', {id: 'assets', owns: ['art/']}), task('techne', {id: 'engine', owns: ['src/']}), task('techne', {id: 'build', owns: ['index.html', 'art/'], after: ['assets', 'engine']}),
    task('kalon', {id: 'review', owns: ['art/'], after: ['build']})];
  assert.deepEqual(ownsConflicts(waves, cwd), [], 'waves of one pipeline never conflict');
  assert.deepEqual(ownsConflicts([task('kalon', {id: 'assets', owns: ['art/']}), task('techne', {id: 'build', owns: ['art/logo.svg']})], cwd), [{a: 'kalon (assets)', b: 'techne (build)', path: 'art/'}]);
});

test('a new task that owns what another actor\'s active task owns gets a note, unless it runs after that task', () => {
  const live = [{activityId: 'a9', ownerId: 'kalon', status: 'running', title: 'Draw the pelican', ownedFiles: ['src/art.svg']}] as unknown as Activity[];
  assert.deepEqual(liveOwnsNotes([task('techne', {owns: ['src/']})], live, cwd),
    ['Note: techne owns src/, which kalon\'s active task "Draw the pelican" (a9) already owns. Edits are not blocked: order the task with `after`, or coordinate with SendMessage.']);
  assert.deepEqual(liveOwnsNotes([task('techne', {owns: ['src/'], after: ['a9']})], live, cwd), []);
  assert.deepEqual(liveOwnsNotes([task('kalon', {owns: ['src/']})], live, cwd), [], 'its own earlier task is no conflict');
  assert.deepEqual(liveOwnsNotes([task('techne', {owns: ['src/']})], [{...live[0]!, status: 'completed'}], cwd), [], 'finished work owns nothing');
});

test('missing owns is noted only beside other owners and missing acceptance only when owns is set', () => {
  assert.deepEqual(dispatchNotes([task('techne')], cwd), []);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['a.ts'], acceptance: ['ok']}), task('kalon')], cwd),
    ['Note: kalon has no `owns`, so teammates are not told which files it is changing.']);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['a.ts']})], cwd),
    ['Note: techne has no `acceptance`, so its report comes back without checks to read it against.']);
});

test('resume tasks are ignored and each task of one owner is noted on its own', () => {
  assert.deepEqual(dispatchNotes([task('techne', {resumeTask: 'a1'}), task('kalon', {resumeTask: 'a2'})], cwd), []);
  assert.deepEqual(dispatchNotes([task('techne', {owns: ['a.ts']}), task('techne', {acceptance: ['ok']})], cwd),
    ['Note: techne (#1) has no `acceptance`, so its report comes back without checks to read it against.']);
});

test('notes follow the dispatch result on their own lines', () => {
  const tasks = [{activityId: 'a1', ownerId: 'techne', title: 'Build', owns: ['src/a.ts'], after: ['a0']}];
  const text = dispatchedResult(tasks, 'b1', ['Note: one', 'Note: two']);
  assert.match(text, /\nNote: one\nNote: two$/);
  assert.match(text, /^Dispatched to techne \(Batch b1\):\n- a1 techne: Build \| owns: src\/a\.ts \| after: a0\n/);
  assert.equal(dispatchedResult(tasks, 'b1'), dispatchedResult(tasks, 'b1', []));
});
