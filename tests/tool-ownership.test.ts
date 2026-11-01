import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PermissionEngine} from '../src/permissions/engine.js';
import {Tools, schemas} from '../src/tools/tools.js';
import {ownsPath} from '../src/tools/ownership.js';
import {actorSchema} from '../src/tools/orchestration/ActorTool/ActorTool.js';
import {ACTOR_DESCRIPTION} from '../src/tools/orchestration/ActorTool/prompt.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {activeEnsembleRoster} from '../src/actors/facts.js';
import type {ActorContext} from '../src/actors/ensemble.js';

const context = (ownerId: string, activityId = ownerId + '-act'): ActorContext => ({
  sessionId: 's', activityId, ownerId, history: [], signal: new AbortController().signal,
  report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {return false;}});
const call = (name: string, args: unknown) => ({id: 'c', name, arguments: JSON.stringify(args)});

test('Actor schema accepts files and rejects bad types', () => {
  const ok = actorSchema.parse({tasks: [{ownerId: 'techne', prompt: 'Build', files: ['index.html', 'src/**/*.js']}]});
  assert.deepEqual(ok.tasks[0]?.files, ['index.html', 'src/**/*.js']);
  assert.ok(actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'Build'}]}).success);
  assert.ok(!actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'Build', files: 'index.html'}]}).success);
  assert.ok(!actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'Build', files: [1]}]}).success);
  assert.ok(!actorSchema.safeParse({tasks: [{ownerId: 'techne', prompt: 'Build', files: ['']}]}).success);
  assert.match(ACTOR_DESCRIPTION, /`files`/);
  assert.ok(schemas.Actor);
});

test('ownsPath matches exact files, directories and globs relative to the project', () => {
  const cwd = join(tmpdir(), 'proj');
  assert.ok(ownsPath(['index.html'], join(cwd, 'index.html'), cwd));
  assert.ok(!ownsPath(['index.html'], join(cwd, 'sub', 'index.html'), cwd));
  assert.ok(ownsPath(['assets/'], join(cwd, 'assets', 'a.svg'), cwd));
  assert.ok(ownsPath(['src/**/*.ts'], join(cwd, 'src', 'a', 'b.ts'), cwd));
  assert.ok(ownsPath(['*.css'], join(cwd, 'x', 'site.css'), cwd));
  assert.ok(!ownsPath(['src/*.ts'], join(cwd, 'src', 'a', 'b.ts'), cwd));
});

test('non-owner edits get one note per (editor, file, activity) while the owner is active', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-own-'));
  try {
    const store = new RuntimeStore(), tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'auto'));
    tools.setActivityProbe(() => store.getSnapshot().activities);
    store.activities.create({sessionId: 's', activityId: 'techne-act', ownerId: 'techne', kind: 'actor', title: 'Build page', taskTitle: 'Build page',
      status: 'running', stage: 'x', detail: 'x', ownedFiles: ['index.html']});
    const file = join(cwd, 'index.html');
    await writeFile(file, 'one two three');
    const edit = async (owner: string, from: string, to: string) => {
      const ctx = context(owner);
      await tools.execute(call('Read', {file_path: file}), ctx);
      return tools.execute(call('Edit', {file_path: file, old_string: from, new_string: to}), ctx);
    };
    const owner = await edit('techne', 'one', '1');
    assert.equal(owner.isError, false); assert.doesNotMatch(owner.text, /Note:/);
    const first = await edit('kalon', 'two', '2');
    assert.equal(first.isError, false, first.text);
    assert.match(first.text, /Note: index\.html belongs to Techne's active assignment "Build page"\. Coordinate with SendMessage/);
    const second = await edit('kalon', 'three', '3');
    assert.doesNotMatch(second.text, /Note:/);
    const director = await edit('logox', '1', 'uno');
    assert.match(director.text, /Note: index\.html belongs to Techne/);
    store.activities.update('s', 'techne-act', {status: 'completed'});
    const after = await edit('aletheia', 'uno', '1');
    assert.equal(after.isError, false); assert.doesNotMatch(after.text, /Note:/);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('roster shows a peer\'s owned files', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'Build', status: 'running', stage: 'x', detail: 'x', ownedFiles: ['index.html', 'app.js']});
  const roster = activeEnsembleRoster(store.getSnapshot(), {ownerId: 'kalon', activityId: 'k'});
  assert.match(roster, /\| owns: index\.html, app\.js/);
});
