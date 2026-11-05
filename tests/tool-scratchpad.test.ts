import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {getActorScratchpadDir, getScratchpadDir, isScratchpadPath, maybePersistLargeOutput} from '../src/kernel/scratchpad.js';

const cwd = process.cwd(), session = 'scratch-test-' + process.pid;

test('every actor gets its own scratchpad directory inside the session tree', () => {
  const tree = getScratchpadDir(cwd, session);
  const techne = getActorScratchpadDir(cwd, session, 'techne'), kalon = getActorScratchpadDir(cwd, session, 'kalon');
  assert.notEqual(techne, kalon);
  assert.equal(dirname(techne), tree);
  assert.equal(getActorScratchpadDir(cwd, session, 'logox'), join(tree, 'logox'));
  assert.equal(dirname(getActorScratchpadDir(cwd, session, '../escape')), tree);
});

test('permission auto-approval covers the whole session tree, including peers', () => {
  const tree = getScratchpadDir(cwd, session);
  assert.ok(isScratchpadPath(join(getActorScratchpadDir(cwd, session, 'kalon'), 'test_ik.js'), tree));
  assert.ok(!isScratchpadPath(join(cwd, 'src', 'x.ts'), tree));
});

test('oversized tool output is offloaded into the calling actor directory', async t => {
  const tree = getScratchpadDir(cwd, session);
  t.after(() => rm(tree, {recursive: true, force: true}));
  const text = 'line\n'.repeat(10_000);
  const result = await maybePersistLargeOutput(text, cwd, 'call-1', session, 'kalon');
  const file = join(getActorScratchpadDir(cwd, session, 'kalon'), 'tool-results', 'call-1.txt');
  assert.ok(result.includes(file));
  assert.equal(await readFile(file, 'utf8'), text);
  const other = await maybePersistLargeOutput(text, cwd, 'call-2', session, 'techne');
  assert.ok(other.includes(join(getActorScratchpadDir(cwd, session, 'techne'), 'tool-results')));
});
