import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeEdit} from '../src/tools/EditTool/EditTool.js';
import {executeRead} from '../src/tools/ReadTool/ReadTool.js';
import {executeWrite} from '../src/tools/WriteTool/WriteTool.js';
import {Snapshots} from '../src/tools/snapshots.js';
import {NOTE_LINE_BUDGET, lineDiff, remapRanges} from '../src/tools/file-views.js';
import {earlierIdenticalRead, readDigest, restoreBrokenReadStubs} from '../src/kernel/read-reuse.js';
import {executionRecoveryInstruction} from '../src/prompts/runtime/recovery.js';
import {WRITE_DESCRIPTION} from '../src/tools/WriteTool/prompt.js';
import {supersededReads} from '../src/context/supersession.js';
import {READ_UNCHANGED_STUB, readUnchangedStub} from '../src/prompts/runtime/file-changes.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const signal = new AbortController().signal;
const numbered = (count: number, tag = 'line') => Array.from({length: count}, (_, index) => `${tag} ${index + 1}`).join('\n') + '\n';

async function fixture(t: TestContext, content: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-views-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'index.html');
  await writeFile(file, content);
  const snapshots = new Snapshots(join(root, 'snapshots'));
  const read = (owner: string, offset?: number, limit?: number) => executeRead({file_path: file, ...(offset ? {offset} : {}), ...(limit ? {limit} : {})}, file, snapshots, owner, 's');
  const edit = (owner: string, old_string: string, new_string: string) => executeEdit({file_path: file, old_string, new_string}, file, snapshots, 'a-' + owner, signal, owner, 's');
  return {root, file, snapshots, read, edit};
}

test('lineDiff finds separate hunks and remapRanges follows them', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f'], after = ['a', 'B', 'c', 'd', 'x', 'y', 'e', 'f'];
  const hunks = lineDiff(before, after);
  assert.deepEqual(hunks, [{a: 1, al: 1, b: 1, bl: 1}, {a: 4, al: 0, b: 4, bl: 2}]);
  assert.deepEqual(remapRanges([{from: 6, to: 6}], hunks, after.length), [{from: 8, to: 8}]);
});

test('a peer edit reaches the other actor as one note with its hunks, and the shown lines count as seen', async t => {
  const f = await fixture(t, numbered(200));
  await f.read('techne');
  await f.edit('kalon', 'line 50\n', 'line 50 changed by kalon\n');
  await f.edit('kalon', 'line 51\n', 'line 51 also changed\n');
  const note = await f.snapshots.views.collect('techne', 's', () => 'index.html');
  assert.ok(note);
  assert.match(note, /index\.html changed by kalon/);
  assert.match(note, /changed 50-51/);
  assert.match(note, /\+ 50: line 50 changed by kalon/);
  assert.match(note, /^- line 50$/m);
  assert.equal(await f.snapshots.views.collect('techne', 's'), null, 'a delivered change is reported once');
  assert.equal(await f.snapshots.views.collect('kalon', 's'), null, 'the writer is not told about its own change');
  // The hunks were shown, so an Edit that touches them is allowed without a fresh read.
  const result = await f.edit('techne', 'line 50 changed by kalon\n', 'line 50 final\n');
  assert.equal(result.isError, false);
  assert.match(await readFile(f.file, 'utf8'), /line 50 final/);
});

test('an Edit over lines whose change was not shown is refused with only those ranges, and a Read of them clears it', async t => {
  const f = await fixture(t, numbered(300));
  await f.read('techne');
  const size = NOTE_LINE_BUDGET + 20;
  const lines = (await readFile(f.file, 'utf8')).split('\n');
  lines.splice(99, 0, ...Array.from({length: size}, (_, index) => 'rewritten ' + index));
  await executeWrite({file_path: f.file, content: lines.join('\n'), overwrite: true}, f.file, f.snapshots, 'a-kalon', signal, 'kalon', undefined, 's');
  const note = await f.snapshots.views.collect('techne', 's');
  assert.ok(note);
  assert.match(note, /Not shown here; Read these lines before editing them: 100-/);
  await assert.rejects(f.edit('techne', 'rewritten 3\n', 'x\n'), /Lines? .*changed since you last saw them and were not shown/i);
  await f.read('techne', 100, size);
  assert.equal((await f.edit('techne', 'rewritten 3\n', 'x\n')).isError, false);
  // An edit away from the changed lines was never blocked.
  assert.equal((await f.edit('techne', 'line 250\n', 'line 250 mine\n')).isError, false);
});

test('an Edit before the note is delivered is allowed away from the change and refused on it', async t => {
  const f = await fixture(t, numbered(100));
  await f.read('techne');
  await f.edit('kalon', 'line 10\n', 'line 10 kalon\n');
  assert.equal((await f.edit('techne', 'line 80\n', 'line 80 techne\n')).isError, false);
  await assert.rejects(f.edit('techne', 'line 10 kalon\n', 'line 10 techne\n'), /changed since you last saw them/);
  const note = await f.snapshots.views.collect('techne', 's');
  assert.match(note ?? '', /changed by kalon/);
  assert.doesNotMatch(note ?? '', /line 80 techne/, 'the actor own edit is not reported back');
});

test('an outside change is reported without an author, a deletion is reported, and a fold forgets the views', async t => {
  const f = await fixture(t, numbered(40));
  await f.read('techne');
  await writeFile(f.file, numbered(40).replace('line 5\n', 'line 5 by hand\n'));
  assert.match(await f.snapshots.views.collect('techne', 's') ?? '', /changed by something outside the actors/);
  await rm(f.file);
  assert.match(await f.snapshots.views.collect('techne', 's') ?? '', /was deleted/);
  await writeFile(f.file, numbered(40));
  await f.read('techne');
  await writeFile(f.file, 'other\n');
  f.snapshots.views.reset('techne', 's');
  assert.equal(await f.snapshots.views.collect('techne', 's'), null);
});

test('a full Write over a file a peer changed still needs a fresh Read, even after the note', async t => {
  const f = await fixture(t, numbered(30));
  await f.read('techne');
  await f.edit('kalon', 'line 3\n', 'line 3 kalon\n');
  await f.snapshots.views.collect('techne', 's');
  await assert.rejects(executeWrite({file_path: f.file, content: 'blind\n'}, f.file, f.snapshots, 'a', signal, 'techne', undefined, 's'), /modified by kalon since your last read/);
  await f.read('techne');
  assert.equal((await executeWrite({file_path: f.file, content: 'after read\n'}, f.file, f.snapshots, 'a', signal, 'techne', undefined, 's')).isError, false);
});

test('a repeated Read points at the earlier result only while that result is verbatim in the request', () => {
  const body = Array.from({length: 40}, (_, index) => `${index + 1}: some source line ${index}`).join('\n');
  const call = {id: 'c1', name: 'Read', arguments: JSON.stringify({file_path: '/p/a.ts'})};
  const again = {id: 'c2', name: 'Read', arguments: JSON.stringify({file_path: '/p/a.ts'})};
  const history: ModelMessage[] = [{role: 'assistant', text: '', toolCalls: [call]}, {role: 'tool', callId: 'c1', name: 'Read', text: body, isError: false}];
  assert.equal(earlierIdenticalRead(history, again, body, '/p'), 'c1');
  assert.equal(earlierIdenticalRead(history, again, body + '\n41: more', '/p'), undefined, 'changed content is returned');
  assert.equal(earlierIdenticalRead([history[0]!, {...history[1]!, text: 'Tool result archived: x'} as ModelMessage], again, body, '/p'), undefined, 'archived or tombstoned results are not pointed at');
  assert.equal(earlierIdenticalRead([], again, body, '/p'), undefined, 'a folded result is not pointed at');
  assert.equal(earlierIdenticalRead(history, {...again, arguments: JSON.stringify({file_path: '/p/a.ts', offset: 5})}, body, '/p'), undefined, 'another range is not the same read');
  assert.equal(earlierIdenticalRead(history, again, 'short', '/p'), undefined);
});

test('a cut-off tool call is redone smaller, never continued, and big new files start as a skeleton', () => {
  for (const kind of ['truncated_tools', 'truncated_text'] as const) {
    const note = executionRecoveryInstruction(kind, 'techne');
    assert.doesNotMatch(note, /from the break point/i);
    assert.match(note, /smaller/i);
    assert.match(note, /skeleton/i);
  }
  assert.match(WRITE_DESCRIPTION, /over about 300 lines[^.]*skeleton[^.]*Edit/i);
});

test('a stub never supersedes the full result it points at', () => {
  const body = Array.from({length: 40}, (_, index) => `${index + 1}: some source line ${index}`).join('\n');
  const read = (id: string) => ({id, name: 'Read', arguments: JSON.stringify({file_path: '/p/a.ts'})});
  const history: ModelMessage[] = [
    {role: 'assistant', text: '', toolCalls: [read('c1')]}, {role: 'tool', callId: 'c1', name: 'Read', text: body, isError: false},
    {role: 'assistant', text: '', toolCalls: [read('c2')]}, {role: 'tool', callId: 'c2', name: 'Read', text: READ_UNCHANGED_STUB + 'c1).', isError: false},
  ];
  assert.equal(supersededReads(history, '/p').size, 0);
});

test('a stub whose earlier result was folded away is replaced by the current content for that request only', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-stub-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = join(root, 'a.ts');
  await writeFile(file, numbered(60));
  const body = (await executeRead({file_path: file}, file)).text;
  const call = (id: string) => ({id, name: 'Read', arguments: JSON.stringify({file_path: file})});
  const stub = {role: 'tool' as const, callId: 'c2', name: 'Read', text: readUnchangedStub('c1', readDigest(body)), isError: false};
  const second = {role: 'assistant' as const, text: '', toolCalls: [call('c2')]};
  const full: ModelMessage[] = [{role: 'assistant', text: '', toolCalls: [call('c1')]}, {role: 'tool', callId: 'c1', name: 'Read', text: body, isError: false}, second, stub];
  assert.deepEqual(await restoreBrokenReadStubs(full, root), full, 'a stub with its earlier result in the request stays');
  const folded = [second, stub];
  const restored = await restoreBrokenReadStubs(folded, root);
  assert.equal((restored[1] as {text: string}).text, body);
  assert.equal(stub.text.startsWith('Unchanged since'), true, 'the ledger message is untouched');
  await writeFile(file, numbered(60).replace('line 7\n', 'line 7 new\n'));
  assert.match((await restoreBrokenReadStubs(folded, root))[1]!.role === 'tool' ? ((await restoreBrokenReadStubs(folded, root))[1] as {text: string}).text : '', /7: line 7 new/);
  const tombstoned = [full[0]!, {...full[1]!, text: 'Superseded by a later read'} as ModelMessage, second, stub];
  assert.match((await restoreBrokenReadStubs(tombstoned, root))[3] !== undefined ? ((await restoreBrokenReadStubs(tombstoned, root))[3] as {text: string}).text : '', /7: line 7 new/);
});
