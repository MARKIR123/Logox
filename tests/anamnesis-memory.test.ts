import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore, parseMemoryFile, serializeMemoryFile} from '../src/anamnesis/memory.js';
import {MAX_DREAM_OPERATIONS, applyOperations, dreamDetail, dreamStage, looksSecret, parseDreamAnswer, validOperations} from '../src/anamnesis/operations.js';
import {MEMORY_RECORD_LIMIT, memorySection} from '../src/prompts/memory.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-memory-'));
  const store = new MemoryStore(join(root, 'project'), join(root, 'home'));
  return {root, store, async close() {await rm(root, {recursive: true, force: true});}};
}
const draft = (name: string, type: 'user' | 'feedback' | 'project' | 'reference' = 'project') => ({name, description: 'About ' + name, type, content: 'Fact about ' + name + '.'});

test('save validates, writes frontmatter and rebuilds the derived index; names are slugs', async () => {
  const f = await fixture();
  try {
    const file = await f.store.save({name: 'tech-stack-node24', description: 'Project uses Node 24', type: 'project', content: 'Node 24 and Ink.'}, 'project');
    const raw = await readFile(file, 'utf8');
    assert.match(raw, /^---\nname: tech-stack-node24\ndescription: Project uses Node 24\nmetadata:\n {2}type: project\n---\n\nNode 24 and Ink\.\n$/);
    assert.equal(await readFile(f.store.indexPathFor('project'), 'utf8'), '- [tech-stack-node24](tech-stack-node24.md) — Project uses Node 24\n');
    for (const name of ['Bad Name', '../escape', 'a/b', '', '-lead', 'x'.repeat(65)]) {
      await assert.rejects(f.store.save(draft(name)), /./, name);
    }
    await assert.rejects(f.store.save({...draft('ok'), description: 'two\nlines'}));
    await assert.rejects(f.store.save({...draft('ok'), content: '   '}));
    assert.deepEqual((await readdir(f.store.dirFor('project'))).sort(), ['MEMORY.md', 'tech-stack-node24.md'], 'nothing else was written');
  } finally {await f.close();}
});

test('list is sorted by scope then name, skips corrupt files and never throws', async () => {
  const f = await fixture();
  try {
    await f.store.save(draft('zeta'), 'project');
    await f.store.save(draft('alpha'), 'project');
    await f.store.save(draft('mid', 'user'), 'user');
    await f.store.save(draft('aaa', 'user'), 'user');
    const project = f.store.dirFor('project');
    await writeFile(join(project, 'no-frontmatter.md'), 'just text');
    await writeFile(join(project, 'bad-yaml.md'), '---\nname: [unclosed\n---\nbody');
    await writeFile(join(project, 'Bad Name.md'), '---\nname: x\ndescription: y\n---\nbody');
    await writeFile(join(project, 'no-description.md'), '---\nname: x\n---\nbody');
    await writeFile(join(project, 'empty-body.md'), '---\nname: x\ndescription: y\n---\n');
    await mkdir(join(project, 'folder.md'));
    const listed = await f.store.list();
    assert.deepEqual(listed.map(record => record.scope + '/' + record.name), ['project/alpha', 'project/zeta', 'user/aaa', 'user/mid']);
    assert.deepEqual((await f.store.list('user')).map(record => record.name), ['aaa', 'mid']);
    assert.deepEqual((await new MemoryStore(join(f.root, 'nowhere'), join(f.root, 'nowhere')).list()), []);
  } finally {await f.close();}
});

test('a hand-written record is read by its file name; a long description is clipped, a legacy top-level type is honoured', async () => {
  const f = await fixture();
  try {
    await mkdir(f.store.dirFor('project'), {recursive: true});
    await writeFile(join(f.store.dirFor('project'), 'by-hand.md'), '---\nname: something else\ndescription: ' + 'long '.repeat(80) + '\ntype: feedback\n---\n\nBody.\n');
    const [record] = await f.store.list();
    assert.equal(record!.name, 'by-hand');
    assert.equal(record!.type, 'feedback');
    assert.ok(record!.description.length >= 195 && record!.description.length <= 200, 'clipped to one line of at most 200 characters');
    const parsed = parseMemoryFile(serializeMemoryFile({...draft('x'), content: 'Body'}));
    assert.deepEqual(parsed, {description: 'About x', type: 'project', content: 'Body'});
  } finally {await f.close();}
});

test('delete removes only an existing record of that scope and refuses names that are not slugs', async () => {
  const f = await fixture();
  try {
    await f.store.save(draft('keep'), 'project');
    await f.store.save(draft('gone'), 'project');
    assert.equal(await f.store.delete('gone', 'project'), true);
    assert.equal(await f.store.delete('gone', 'project'), false, 'already gone');
    assert.equal(await f.store.delete('keep', 'user'), false, 'other scope');
    assert.equal(await f.store.delete('../project/keep', 'project'), false);
    assert.equal(await f.store.delete('MEMORY', 'project'), false, 'the index is not a record');
    assert.deepEqual((await f.store.list()).map(record => record.name), ['keep']);
    assert.equal(await readFile(f.store.indexPathFor('project'), 'utf8'), '- [keep](keep.md) — About keep\n');
  } finally {await f.close();}
});

test('parseDreamAnswer strips a code fence and takes the outermost object', () => {
  const body = '{"operations": [{"op": "delete", "name": "x"}]}';
  for (const text of [body, '```json\n' + body + '\n```', 'Here you go: ' + body + ' Hope this helps.', '```\n' + body + '\n```']) {
    assert.deepEqual(parseDreamAnswer(text), [{op: 'delete', name: 'x'}], text);
  }
  assert.deepEqual(parseDreamAnswer('{"operations": []}'), []);
  assert.deepEqual(parseDreamAnswer('{}'), [], 'no operations key means nothing to do');
  for (const bad of ['', 'no json here', '{"operations": "nope"}', '{"operations": [', '[1,2]']) assert.equal(parseDreamAnswer(bad), undefined, bad);
});

test('operations: invalid ones are dropped, at most six remain, order is kept', () => {
  const save = (name: string) => ({op: 'save', scope: 'project', type: 'project', name, description: 'd', content: 'c'});
  const raw = [save('one'), {op: 'save', name: 'Bad Name', type: 'project', description: 'd', content: 'c'}, {op: 'nonsense'}, 'text', null,
    {op: 'save', name: 'no-type', description: 'd', content: 'c'}, {op: 'save', type: 'project', name: 'multi', description: 'a\nb', content: 'c'},
    save('two'), save('three'), save('four'), save('five'), save('six'), save('seven'), save('eight')];
  const valid = validOperations(raw);
  assert.equal(valid.length, MAX_DREAM_OPERATIONS);
  assert.deepEqual(valid.map(operation => operation.op === 'save' ? operation.name : ''), ['one', 'two', 'three', 'four', 'five', 'six']);
});

test('operations: a user record always goes to the user folder, others to the stated scope (default project); delete of a missing record is ignored', async () => {
  const f = await fixture();
  try {
    await f.store.save(draft('old-fact'), 'project');
    const result = await applyOperations(f.store, [
      {op: 'save', scope: 'project', type: 'user', name: 'who-i-am', description: 'The user is a data scientist', content: 'Works in notebooks.'},
      {op: 'save', scope: 'user', type: 'reference', name: 'dashboard', description: 'Where the dashboard lives', content: 'https://example.test/d'},
      {op: 'save', type: 'feedback', name: 'terse', description: 'Prefers terse answers', content: 'Why: said so.'},
      {op: 'delete', scope: 'project', name: 'old-fact'},
      {op: 'delete', scope: 'project', name: 'never-existed'},
      {op: 'delete', scope: 'user', name: 'old-fact'},
    ]);
    assert.deepEqual(result.saved.map(item => item.scope + '/' + item.name), ['user/who-i-am', 'user/dashboard', 'project/terse']);
    assert.deepEqual(result.deleted, [{scope: 'project', name: 'old-fact'}]);
    assert.deepEqual((await f.store.list()).map(record => record.scope + '/' + record.name), ['project/terse', 'user/dashboard', 'user/who-i-am']);
    assert.equal(dreamStage(result), 'Saved 3 memory records, removed 1');
    assert.equal(dreamDetail(result), "Remembered in your memory (all projects)\n• who-i-am (about you): The user is a data scientist\n• dashboard (pointer): Where the dashboard lives\n\nRemembered in this project's memory\n• terse (preference): Prefers terse answers\n\nForgotten from this project's memory\n• old-fact");
    assert.equal(dreamStage({saved: [result.saved[0]!], deleted: []}), 'Saved 1 memory record');
    assert.equal(dreamStage({saved: [], deleted: result.deleted}), 'Removed 1 memory record');
    assert.equal(dreamStage({saved: [], deleted: []}), 'Nothing new to remember');
    // Saving under an existing name and scope updates that record: no near-duplicate file.
    await applyOperations(f.store, [{op: 'save', scope: 'project', type: 'feedback', name: 'terse', description: 'Prefers terse answers, always', content: 'Updated.'}]);
    const terse = (await f.store.list('project')).filter(record => record.name === 'terse');
    assert.equal(terse.length, 1);
    assert.equal(terse[0]!.content, 'Updated.');
  } finally {await f.close();}
});

test('operations: a record that carries an obvious secret is never written', async () => {
  const secrets = ['key sk-abcdefghijklmnopqrstuvwx', 'token ghp_abcdefghijklmnopqrstuv', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIB', 'config api_key=hunter2hunter2', 'password = "swordfish"', '{"password": "swordfish"}', 'API-KEY=abc'];
  for (const text of secrets) assert.equal(looksSecret(text), true, text);
  for (const text of ['The user prefers short answers.', 'Set the api key in the environment instead.', 'sk-short', 'Bearer of bad news']) assert.equal(looksSecret(text), false, text);
  const f = await fixture();
  try {
    const result = await applyOperations(f.store, [
      ...secrets.map((text, index) => ({op: 'save', scope: 'project', type: 'reference', name: 'secret-' + index, description: 'A thing', content: text})),
      {op: 'save', scope: 'project', type: 'reference', name: 'clean', description: 'password=hunter2 in the description', content: 'fine'},
      {op: 'save', scope: 'project', type: 'reference', name: 'fine', description: 'A harmless thing', content: 'Nothing secret.'},
    ]);
    assert.deepEqual(result.saved.map(item => item.name), ['fine']);
    assert.deepEqual((await f.store.list()).map(record => record.name), ['fine']);
  } finally {await f.close();}
});

test('the memory section: exact text, stable order, capped list, empty case, byte-identical between builds', async () => {
  const f = await fixture();
  try {
    const dirs = {projectMemoryDir: f.store.dirFor('project'), userMemoryDir: f.store.dirFor('user')};
    const empty = memorySection({...dirs, records: []});
    assert.ok(empty.startsWith('# Memory\n\nLong-term memory is two folders of Markdown records: `' + dirs.projectMemoryDir + '` (this project) and `' + dirs.userMemoryDir + '` (every project of this user).'));
    assert.ok(empty.endsWith('- The user removes records under `/anamnesis`.\n\nNo records yet.'));
    assert.ok(!empty.includes('{{'), 'every placeholder is filled');
    for (const name of ['zeta', 'alpha']) await f.store.save(draft(name), 'project');
    await f.store.save(draft('mid', 'user'), 'user');
    const first = memorySection({...dirs, records: await f.store.list()}), second = memorySection({...dirs, records: await f.store.list()});
    assert.equal(first, second, 'byte-identical');
    assert.ok(first.endsWith('\n\n- ' + join(dirs.projectMemoryDir, 'alpha.md') + ' (project): About alpha\n- ' + join(dirs.projectMemoryDir, 'zeta.md') + ' (project): About zeta\n- ' + join(dirs.userMemoryDir, 'mid.md') + ' (user): About mid'), first.slice(-200));
    assert.ok(!first.includes('- user/') && !first.includes('- project/'), 'no scope prefix that reads like a subfolder');
    assert.ok(!first.includes('No records yet.'));
    const many = Array.from({length: MEMORY_RECORD_LIMIT + 5}, (_, index) => ({scope: 'project', name: 'r' + String(index).padStart(3, '0'), type: 'project', description: 'D' + index}));
    const capped = memorySection({...dirs, records: many}).split('\n').filter(line => line.startsWith('- ') && line.includes('.md ('));
    assert.equal(capped.length, MEMORY_RECORD_LIMIT);
    assert.ok(memorySection({...dirs, records: many}).endsWith('\n- … 5 more records in the folders above'));
    assert.ok(!memorySection({...dirs, records: many.slice(0, MEMORY_RECORD_LIMIT)}).includes('more records'));
  } finally {await f.close();}
});
