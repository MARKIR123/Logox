import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PermissionEngine} from '../src/permissions/engine.js';
import {Tools} from '../src/tools/tools.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {changedBetween, workspaceState} from '../src/tools/ShellTool/workspace-diff.js';
import {buildRuntimeRecord} from '../src/actors/runtime-record.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const context = (ownerId: string, activityId = ownerId + '-act'): ActorContext => ({
  sessionId: 's', activityId, ownerId, history: [], signal: new AbortController().signal,
  report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {return false;}});
const call = (name: string, args: unknown, id = 'c') => ({id, name, arguments: JSON.stringify(args)});
const node = (script: string) => `node -e "${script.replace(/"/g, '\\"')}"`;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, stdio: 'ignore'});

test('outside git the workspace is walked: created, modified and deleted files are changes, dependency folders are skipped', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-audit-walk-'));
  try {
    await writeFile(join(cwd, 'keep.txt'), 'same');
    await writeFile(join(cwd, 'edit.txt'), 'one');
    await writeFile(join(cwd, 'gone.txt'), 'x');
    await mkdir(join(cwd, 'node_modules'));
    const before = (await workspaceState(cwd))!;
    await writeFile(join(cwd, 'edit.txt'), 'one two');
    await writeFile(join(cwd, 'new.txt'), 'n');
    await unlink(join(cwd, 'gone.txt'));
    await writeFile(join(cwd, 'node_modules', 'dep.js'), 'x');
    assert.deepEqual(changedBetween(before, (await workspaceState(cwd))!), ['edit.txt', 'gone.txt', 'new.txt']);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('in a git work tree the state is git status: tracked and untracked changes count, ignored files do not, and a file already modified is seen changing again', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-audit-git-'));
  try {
    git(cwd, 'init', '-q');
    await writeFile(join(cwd, '.gitignore'), 'build/\n');
    await writeFile(join(cwd, 'a.txt'), 'a');
    await writeFile(join(cwd, 'dirty.txt'), 'd');
    git(cwd, 'add', '.');
    git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'base');
    await writeFile(join(cwd, 'dirty.txt'), 'already changed before the command');
    const before = (await workspaceState(cwd))!;
    await writeFile(join(cwd, 'a.txt'), 'a changed');
    await writeFile(join(cwd, 'dirty.txt'), 'changed again by the command');
    await mkdir(join(cwd, 'sub'));
    await writeFile(join(cwd, 'sub', 'new.txt'), 'n');
    await mkdir(join(cwd, 'build'));
    await writeFile(join(cwd, 'build', 'out.js'), 'ignored');
    assert.deepEqual(changedBetween(before, (await workspaceState(cwd))!), ['a.txt', 'dirty.txt', 'sub/new.txt']);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a foreground Shell command reports the files it changed, notes files another actor owns, and a background one is not audited', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-audit-shell-'));
  try {
    const store = new RuntimeStore(), tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    tools.setActivityProbe(() => store.getSnapshot().activities);
    store.activities.create({sessionId: 's', activityId: 'kalon-act', ownerId: 'kalon', kind: 'actor', title: 'Draw', taskTitle: 'Draw',
      status: 'running', stage: 'x', detail: 'x', ownedFiles: ['art.svg']});
    const result = await tools.execute(call('Shell', {command: node("require('fs').writeFileSync('art.svg','<svg/>');require('fs').writeFileSync('page.html','<p>')")}), context('techne'));
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(result.changedFiles, ['art.svg', 'page.html']);
    assert.match(result.text, /^Files changed: art\.svg, page\.html$/m);
    assert.match(result.text, /Note: art\.svg belongs to Kalon's active assignment "Draw"/);
    assert.deepEqual(tools.shellChangedPaths(['techne-act']), ['art.svg', 'page.html']);
    const quiet = await tools.execute(call('Shell', {command: node("console.log('read only')")}, 'q'), context('techne'));
    assert.equal(quiet.changedFiles, undefined);
    assert.doesNotMatch(quiet.text, /Files changed/);
    const background = await tools.execute(call('Shell', {command: node("require('fs').writeFileSync('bg.txt','x')"), run_in_background: true}, 'bg'), context('techne'));
    assert.equal(background.changedFiles, undefined, 'a background command has no end to compare against');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('a file a teammate writes through Write while the command runs is not counted as the command\'s change', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-audit-race-'));
  try {
    const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home: cwd});
    const command = tools.execute(call('Shell', {command: node("setTimeout(() => require('fs').writeFileSync('mine.txt','x'), 600)")}), context('techne'));
    await new Promise(resolve => setTimeout(resolve, 200));
    const write = await tools.execute(call('Write', {file_path: join(cwd, 'theirs.txt'), content: 'y'}, 'w'), context('kalon'));
    assert.equal(write.isError, false, write.text);
    const result = await command;
    assert.deepEqual(result.changedFiles, ['mine.txt']);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('the runtime record lists Shell changes beside Edit and Write, and flags those outside owns', () => {
  const messages: ModelMessage[] = [
    {role: 'assistant', text: '', toolCalls: [{id: 'w', name: 'Write', arguments: JSON.stringify({file_path: 'src/engine.js'})}, {id: 's', name: 'Shell', arguments: JSON.stringify({command: 'node build.mjs'})}]},
    {role: 'tool', callId: 'w', name: 'Write', text: 'ok', isError: false},
    {role: 'tool', callId: 's', name: 'Shell', text: 'Exit code: 0\nFiles changed: index.html, src/engine.js', isError: false, changedFiles: ['index.html', 'src/engine.js']},
  ];
  const record = buildRuntimeRecord({actor: 'Techne', messages, cwd: tmpdir(), ownedFiles: ['src/']});
  assert.match(record, /src\/engine\.js, index\.html/, 'first-touch order, no duplicates');
  assert.match(record, /index\.html/);
  assert.match(record, /"node build\.mjs" exit 0/);
  const outside = record.split('\n').find(line => /outside/i.test(line));
  assert.ok(outside?.includes('index.html') && !outside.includes('engine'), outside);
});
