import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
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

const BS = String.fromCharCode(92);
const win = (path: string) => path.split('/').join(BS);

test('scratchpad matching treats a Windows short-name alias as the same directory', () => {
  const existing = ['c:/users', 'c:/users/administrator', 'c:/users/administrator/appdata', 'c:/users/administrator/appdata/local',
    'c:/users/administrator/appdata/local/temp', 'c:/users/administrator/appdata/local/temp/logox-scratchpad'];
  const resolve = (path: string) => {
    const slashed = path.split(BS).join('/').toLowerCase().replace('c:/users/admini~1', 'c:/users/administrator');
    if (!existing.includes(slashed)) throw new Error('ENOENT');
    return win(slashed.replace('c:/users/administrator', 'C:/Users/Administrator'));
  };
  const dir = win('C:/Users/ADMINI~1/AppData/Local/Temp/logox-scratchpad/abc/s1');
  assert.equal(isScratchpadPath(win('C:/Users/Administrator/AppData/Local/Temp/logox-scratchpad/abc/s1/kalon/a.txt'), dir, resolve, true), true);
  assert.equal(isScratchpadPath(win('c:/users/admini~1/appdata/local/temp/logox-scratchpad/abc/s1'), dir, resolve, true), true);
  assert.equal(isScratchpadPath(win('C:/Users/Administrator/AppData/Local/Temp/logox-scratchpad/abc/s10/x'), dir, resolve, true), false);
  assert.equal(isScratchpadPath(win('C:/Users/Administrator/project/x'), dir, resolve, true), false);
});

test('scratchpad matching accepts the real and the reported spelling of the actual tmpdir', () => {
  const dir = getActorScratchpadDir(cwd, session, 'kalon');
  const real = dir.replace(tmpdir(), realpathSync.native(tmpdir()));
  assert.equal(isScratchpadPath(join(real, 'x.txt'), dir), true);
  assert.equal(isScratchpadPath(join(dir, 'x.txt'), real), true);
});
