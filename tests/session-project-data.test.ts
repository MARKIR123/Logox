import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config/config.js';
import {projectDataDir, projectKey} from '../src/config/project-data.js';
import {acquireFileLock} from '../src/store/file-lock.js';
import {migrateProjectData, migrationLockPath} from '../src/store/project-migration.js';
import {createTestApplication, waitForSnapshot} from './runtime-fixture.js';
import type {Provider} from '../src/runtime/messages.js';

const exists = (path: string) => stat(path).then(() => true, () => false);
async function files(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, {withFileTypes: true}).catch(() => [])) {
    if (entry.isDirectory()) result.push(...await files(join(root, entry.name), prefix + entry.name + '/'));
    else result.push(prefix + entry.name);
  }
  return result.sort();
}
/** A temp home and a project with runtime state in the layout older versions wrote under `<project>/.logox/`. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-project-data-')));
  const home = join(root, 'home'), project = join(root, 'project'), legacy = join(project, '.logox');
  await mkdir(home); await mkdir(legacy, {recursive: true});
  const target = projectDataDir(project, home);
  const seed = async () => {
    await mkdir(join(legacy, 'state', 'sessions', 's1'), {recursive: true});
    await writeFile(join(legacy, 'state', 'sessions', 's1', 'director.jsonl'), 'ledger\n');
    await writeFile(join(legacy, 'state', 'last-session'), 's1');
    await mkdir(join(legacy, 'snapshots'), {recursive: true});
    await writeFile(join(legacy, 'snapshots', 'a.json'), '{"a":1}');
    await writeFile(join(legacy, 'permissions.json'), '{"rules":[]}');
  };
  return {root, home, project, legacy, target, seed, cleanup: () => rm(root, {recursive: true, force: true})};
}

test('projectKey replaces every character outside [A-Za-z0-9] with a dash, Windows and POSIX alike', () => {
  assert.equal(projectKey('G:\\hz\\codes\\Logox'), 'G--hz-codes-Logox');
  assert.equal(projectKey('/home/a/b'), '-home-a-b');
  assert.equal(projectKey('/home/a b/c.d_e'), '-home-a-b-c-d-e');
  assert.equal(projectKey('C:\\Users\\Zoë\\proj'), 'C--Users-Zo--proj');
});

test('projectDataDir lives under <home>/.logox/projects and keys the resolved project path', () => {
  const project = join(tmpdir(), 'proj'), home = join(tmpdir(), 'home');
  const dir = projectDataDir(join(tmpdir(), 'other', '..', 'proj'), home);
  assert.equal(dirname(dir), join(home, '.logox', 'projects'));
  assert.equal(dir, join(home, '.logox', 'projects', projectKey(project)));
  assert.equal(projectDataDir(project + sep, home), dir, 'a trailing separator does not change the key');
});

test('migration with nothing under <project>/.logox creates nothing', async () => {
  const f = await fixture();
  try {
    const result = await migrateProjectData({project: f.project, home: f.home});
    assert.deepEqual(result, {dataDir: f.target, notices: []});
    assert.deepEqual(await readdir(f.home), []);
    assert.deepEqual(await readdir(f.legacy), []);
  } finally {await f.cleanup();}
});

test('migration moves state, snapshots and permissions to the project data folder, verified, and removes the old copies', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await writeFile(join(f.legacy, 'bulletin.md'), 'notes'); await mkdir(join(f.legacy, 'actors')); await writeFile(join(f.legacy, 'config.toml'), '');
    const result = await migrateProjectData({project: f.project, home: f.home});
    assert.deepEqual(result.notices, ['Moved runtime state to ' + f.target + '.']);
    assert.equal(result.dataDir, f.target);
    assert.deepEqual(await files(f.target), ['permissions.json', 'snapshots/a.json', 'state/last-session', 'state/sessions/s1/director.jsonl']);
    assert.equal(await readFile(join(f.target, 'state', 'sessions', 's1', 'director.jsonl'), 'utf8'), 'ledger\n');
    assert.deepEqual((await readdir(f.legacy)).sort(), ['actors', 'bulletin.md', 'config.toml'], 'what the user reads or edits stays');
    const again = await migrateProjectData({project: f.project, home: f.home});
    assert.deepEqual(again, {dataDir: f.target, notices: []}, 'a second start is a no-op');
  } finally {await f.cleanup();}
});

test('a failed move deletes the partial target, leaves the old data and keeps using the old folder with a notice', async () => {
  const f = await fixture();
  try {
    await f.seed();
    // The data folder cannot be created: <home>/.logox/projects is a file.
    await mkdir(join(f.home, '.logox')); await writeFile(join(f.home, '.logox', 'projects'), 'in the way');
    const result = await migrateProjectData({project: f.project, home: f.home});
    assert.equal(result.dataDir, f.legacy);
    assert.equal(result.notices.length, 1);
    assert.match(result.notices[0]!, new RegExp('^Could not move runtime state to ' + f.target.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + ': .+\\. Using ' + f.legacy.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + ' for now\\.$'));
    assert.deepEqual(await files(f.legacy), ['permissions.json', 'snapshots/a.json', 'state/last-session', 'state/sessions/s1/director.jsonl']);
  } finally {await f.cleanup();}
});

test('a copy that does not match the original fails verification: the partial target is removed and the old data stays', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const {cp} = await import('node:fs/promises');
    const result = await migrateProjectData({project: f.project, home: f.home, copy: async (from, to) => {
      await cp(from, to, {recursive: true});
      if (to.endsWith('snapshots')) await writeFile(join(to, 'a.json'), 'short');
    }});
    assert.equal(result.dataDir, f.legacy);
    assert.match(result.notices[0]!, /^Could not move runtime state to .+: Copy of snapshots did not match the original\. Using .+ for now\.$/);
    assert.equal(await exists(f.target), false, 'nothing copied is left, state included');
    assert.deepEqual(await files(f.legacy), ['permissions.json', 'snapshots/a.json', 'state/last-session', 'state/sessions/s1/director.jsonl']);
  } finally {await f.cleanup();}
});

test('when the target already has entries, only the missing ones move and conflicts stay, reported once', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await mkdir(join(f.target, 'state', 'sessions', 's2'), {recursive: true});
    await writeFile(join(f.target, 'state', 'sessions', 's2', 'director.jsonl'), 'new ledger\n');
    await writeFile(join(f.target, 'state', 'last-session'), 's2');
    await writeFile(join(f.target, 'permissions.json'), '{"rules":["kept"]}');
    const result = await migrateProjectData({project: f.project, home: f.home});
    assert.deepEqual(result.notices, [
      'Moved runtime state to ' + f.target + '.',
      'Runtime state exists in both ' + f.legacy + ' and ' + f.target + '; kept ' + f.target + '. Left in place: 2 entries.']);
    assert.equal(await readFile(join(f.target, 'state', 'last-session'), 'utf8'), 's2', 'the target wins');
    assert.equal(await readFile(join(f.target, 'permissions.json'), 'utf8'), '{"rules":["kept"]}');
    assert.deepEqual(await files(f.target), ['permissions.json', 'snapshots/a.json', 'state/last-session', 'state/sessions/s1/director.jsonl', 'state/sessions/s2/director.jsonl']);
    assert.deepEqual(await files(f.legacy), ['permissions.json', 'state/last-session'], 'only the conflicting entries remain');
  } finally {await f.cleanup();}
});

test('the migration lock keeps two processes from moving the same project at once', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const release = await acquireFileLock(migrationLockPath(f.project, f.home));
    let finished = false;
    const running = migrateProjectData({project: f.project, home: f.home}).then(result => {finished = true; return result;});
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(finished, false, 'waits while another process holds the lock');
    assert.equal(await exists(join(f.legacy, 'state')), true, 'nothing moved yet');
    await release();
    const result = await running;
    assert.deepEqual(result.notices, ['Moved runtime state to ' + f.target + '.']);
    assert.equal(await exists(join(f.legacy, 'state')), false);
  } finally {await f.cleanup();}
});

test('an application started on a project with old-layout state resumes the old session from the project data folder', async () => {
  const f = await fixture();
  const provider: Provider = {async respond(_request, delta) {delta({kind: 'text', text: 'done'}); return {message: {role: 'assistant', text: 'done'}, stop: 'complete'};}};
  const options = async () => ({cwd: f.project, resourceOptions: {home: f.home, boundary: f.root}, env: {}, authPath: join(f.root, 'auth.json'), sessionId: 'first',
    config: await loadConfig(f.project, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, f.home, f.root), provider});
  try {
    const first = await createTestApplication(await options());
    await first.submit('remember this goal');
    await waitForSnapshot(first.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
    await first.close();
    // Put what the first run wrote back where older versions kept it.
    await rename(join(f.target, 'state'), join(f.legacy, 'state'));
    if (await exists(join(f.target, 'snapshots'))) await rename(join(f.target, 'snapshots'), join(f.legacy, 'snapshots'));
    await rm(f.target, {recursive: true, force: true});
    const second = await createTestApplication({...await options(), resume: true});
    try {
      assert.equal(second.sessionId, 'first');
      assert.ok(second.store.getSnapshot().messages.some(message => message.text === 'remember this goal'), 'the old ledger was read from the new place');
      assert.equal(await exists(join(f.legacy, 'state')), false, 'the old state folder is gone');
      assert.equal(await exists(join(f.target, 'state', 'sessions', 'first', 'director.jsonl')), true);
      assert.ok((await second.sessions.list()).sessions.some(session => session.id === 'first'));
      assert.ok(second.store.getSnapshot().messages.some(message => message.text.startsWith('Moved runtime state to ' + f.target)), 'one notice in the timeline');
    } finally {await second.close();}
  } finally {await f.cleanup();}
});

test('a fresh project gets nothing in its .logox folder but bulletin.md; runtime state goes to the project data folder', async () => {
  const f = await fixture();
  await rm(f.legacy, {recursive: true, force: true});
  const provider: Provider = {async respond(_request, delta) {delta({kind: 'text', text: 'done'}); return {message: {role: 'assistant', text: 'done'}, stop: 'complete'};}};
  try {
    const app = await createTestApplication({cwd: f.project, resourceOptions: {home: f.home, boundary: f.root}, env: {}, authPath: join(f.root, 'auth.json'), sessionId: 'fresh', provider,
      config: await loadConfig(f.project, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, f.home, f.root)});
    try {
      await app.submit('/permissions add project deny edit *.txt');
      await app.submit('hello');
      await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
    } finally {await app.close();}
    assert.deepEqual(await readdir(join(f.project, '.logox')).catch(() => []), ['bulletin.md']);
    assert.equal(await exists(join(f.target, 'state', 'sessions', 'fresh', 'director.jsonl')), true);
    assert.equal(await exists(join(f.target, 'permissions.json')), true, 'project permission rules are runtime state too');
  } finally {await f.cleanup();}
});
