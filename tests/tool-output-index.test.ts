import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {maybePersistLargeOutput, persistedIndex, settleToolResults, summarizeArguments, TOOL_OUTPUT_LIMIT} from '../src/kernel/scratchpad.js';

const lines = (count: number, width = 60) => Array.from({length: count}, (_, index) => `line ${index + 1} `.padEnd(width, '.')).join('\n');
const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from) + from.length, text.indexOf(to));

test('an offloaded result is an index: what ran, how big, where it lives, how to read it, and both ends at line boundaries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-index-'));
  try {
    const text = lines(1000);
    const result = await maybePersistLargeOutput(text, cwd, 'call-1', 'session', 'techne', TOOL_OUTPUT_LIMIT, {tool: 'Shell', arguments: JSON.stringify({command: 'npm   test\n-- --all', timeout: 600})});
    const [open, tool, size, hint, ...rest] = result.split('\n');
    assert.equal(open, '<persisted-output>');
    assert.equal(tool, 'Tool: Shell npm test -- --all');
    assert.match(size!, /^Size: \d+\.\d KB, 1000 lines\. Full output: .*call-1\.txt$/);
    assert.equal(hint, 'Read it with Read (offset/limit by line) or search it with Grep; do not re-run the tool to see it again.');
    assert.equal(rest.at(-1), '</persisted-output>');
    const file = size!.split('Full output: ')[1]!;
    assert.equal(await readFile(file, 'utf8'), text, 'the full output is on disk');
    const head = /^First lines \(1-(\d+)\):$/m.exec(result), tail = /^Last lines \((\d+)-1000\):$/m.exec(result);
    assert.ok(head && tail);
    const first = section(result, head[0] + '\n', '\n...\n'), last = section(result, tail[0] + '\n', '\n</persisted-output>');
    assert.equal(first, text.split('\n').slice(0, Number(head[1])).join('\n'), 'the head is whole lines from the start');
    assert.equal(last, text.split('\n').slice(Number(tail[1]) - 1).join('\n'), 'the tail is whole lines to the end');
    assert.ok(first.length <= 1536 && first.length > 1400, 'about 1.5 KB of head: ' + first.length);
    assert.ok(last.length <= 512 && last.length > 400, 'about 0.5 KB of tail: ' + last.length);
    assert.ok(Number(head[1]) < Number(tail[1]), 'the two ends do not overlap');
    assert.ok(result.length < 3000);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('line counts ignore a trailing newline and one long line is cut instead of a line boundary', async () => {
  const withNewline = persistedIndex(lines(500) + '\n', '/tmp/x.txt', {tool: 'Grep'});
  assert.match(withNewline, /, 500 lines\./);
  assert.match(withNewline, /^Tool: Grep$/m, 'no argument summary when the call carried none');
  assert.match(withNewline, /^Last lines \(\d+-500\):$/m);
  const single = persistedIndex('z'.repeat(40_000), '/tmp/one.txt', {tool: 'WebFetch', arguments: JSON.stringify({url: 'https://example.com/page'})});
  assert.match(single, /^Tool: WebFetch https:\/\/example\.com\/page$/m);
  assert.match(single, /, 1 line\. Full output: \/tmp\/one\.txt$/m, 'singular line count');
  assert.match(single, /^First lines \(1-1\):\nz{1536}…$/m);
  assert.ok(!single.includes('Last lines'), 'one line has no tail');
  const wide = persistedIndex('a'.repeat(5000) + '\n' + 'b'.repeat(5000), '/tmp/two.txt');
  assert.match(wide, /^First lines \(1-1\):\na{1536}…$/m);
  assert.match(wide, /^Last lines \(2-2\):\n…b{512}$/m);
  assert.ok(!/^Tool:/m.test(wide), 'no tool line without a source');
});

test('arguments are summarized to one short line', () => {
  assert.equal(summarizeArguments(JSON.stringify({file_path: '/a/b.ts', offset: 5})), '/a/b.ts');
  assert.equal(summarizeArguments(JSON.stringify({pattern: 'TODO', path: 'src'})), 'TODO in src');
  assert.equal(summarizeArguments(JSON.stringify({command: 'x '.repeat(200)})).length, 120);
  assert.equal(summarizeArguments(JSON.stringify({jobs: []})), '');
  assert.equal(summarizeArguments(undefined), '');
  assert.equal(summarizeArguments('not json'), 'not json');
});

test('text that is already an index is not persisted again, and small output is untouched', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-index-'));
  try {
    const index = await maybePersistLargeOutput(lines(1000), cwd, 'a', 'session', 'techne', TOOL_OUTPUT_LIMIT, {tool: 'Shell'});
    assert.equal(await maybePersistLargeOutput(index, cwd, 'b', 'session', 'techne', 0, {tool: 'Shell'}), index);
    assert.equal(await maybePersistLargeOutput('small', cwd, 'c', 'session', 'techne'), 'small');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('settled results carry the tool name and arguments of their call', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-index-'));
  try {
    const [big, small] = await settleToolResults([
      {callId: 'big', text: lines(900), tool: 'Read', arguments: JSON.stringify({file_path: '/repo/src/huge.ts'})},
      {callId: 'small', text: 'ok', tool: 'Read', arguments: '{}'},
    ], cwd, 'session', 'techne');
    assert.match(big!.text, /^<persisted-output>\nTool: Read \/repo\/src\/huge\.ts\nSize: /);
    assert.equal(small!.text, 'ok');
  } finally {await rm(cwd, {recursive: true, force: true});}
});
