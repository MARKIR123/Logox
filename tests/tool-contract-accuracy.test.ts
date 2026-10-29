import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeRead} from '../src/tools/ReadTool/ReadTool.js';
import {composeActorSystemPrompt} from '../src/prompts/boundary.js';
import {ToolRegistry} from '../src/tools/registry.js';
import {schemas} from '../src/tools/tools.js';

async function fileFixture(run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'logox-read-contract-'));
  try {await run(join(root, 'evidence.txt'));}
  finally {await rm(root, {recursive: true, force: true});}
}

test('Read preserves a long selected line including Unicode and its evidence suffix', async () => {
  await fileFixture(async path => {
    const line = 'x'.repeat(1999) + '🌱' + 'y'.repeat(1200) + ' EVIDENCE_END';
    await writeFile(path, line);
    const result = await executeRead({file_path: path}, path);
    assert.equal(result.isError, false);
    assert.equal(result.text, '1: ' + line);
  });
});

test('Read rejects oversized output explicitly and a smaller line range still works', async () => {
  await fileFixture(async path => {
    await writeFile(path, 'x'.repeat(256 * 1024) + '\nsmall evidence\n');
    await assert.rejects(executeRead({file_path: path, limit: 1}, path), /output exceeds 256 KiB/);
    const result = await executeRead({file_path: path, offset: 2, limit: 1}, path);
    assert.equal(result.text, '2: small evidence\n(Remaining lines omitted)');
  });
});

test('Read bounds UTF-8 output bytes rather than JavaScript character count', async () => {
  await fileFixture(async path => {
    await writeFile(path, '界'.repeat(100_000));
    await assert.rejects(executeRead({file_path: path}, path), /output exceeds 256 KiB/);
  });
});

test('Read default pagination retains line numbering and exposes the remaining range', async () => {
  await fileFixture(async path => {
    await writeFile(path, Array.from({length: 2001}, (_, index) => 'evidence-' + (index + 1)).join('\n'));
    const first = await executeRead({file_path: path}, path);
    assert.match(first.text, /^1: evidence-1\n/);
    assert.match(first.text, /\n2000: evidence-2000\n\(Remaining lines omitted\)$/);
    assert.doesNotMatch(first.text, /2001: evidence-2001/);
    const last = await executeRead({file_path: path, offset: 2001}, path);
    assert.equal(last.text, '2001: evidence-2001');
  });
});

test('memory focus keeps an authored heading without adding a duplicate section label', () => {
  const input = {persona: 'A specialist.', guidelines: [], toolsIndex: '', skillsIndex: '', environmentBaseline: 'Fixture environment.'};
  const titled = composeActorSystemPrompt({...input, memoryFocus: '# Evidence focus\nPreserve proof.'}).system;
  assert.deepEqual(titled.match(/^# .+$/gm), ['# Persona', '# Execution Rules', '# Team Collaboration', '# Tools & Skills', '# Current Environment']);
  assert.match(titled, /## Evidence focus\nPreserve proof\./);
  assert.doesNotMatch(titled, /## Role Memory Focus/);
  const plain = composeActorSystemPrompt({...input, memoryFocus: 'Preserve proof.'}).system;
  assert.match(plain, /## Role Memory Focus\nPreserve proof\./);
});

test('model-facing contracts describe supported question counts and existing timeout compatibility', () => {
  const registry = new ToolRegistry('/fixture', '/fixture');
  const pool = registry.getToolsForActor('logox');
  const questions = pool.find(tool => tool.name === 'AskUserQuestion')!;
  assert.match(questions.description, /1-4/);
  const question = {header: 'Choice', question: 'Which option?', options: [{label: 'A', description: 'A'}, {label: 'B', description: 'B'}]};
  assert.equal(schemas.AskUserQuestion.parse({questions: Array(4).fill(question)}).questions.length, 4);
  assert.equal(schemas.AskUserQuestion.safeParse({questions: Array(5).fill(question)}).success, false);
  const shell = pool.find(tool => tool.name === 'Shell')!.parameters as {properties: {timeout: {description: string}}};
  assert.match(shell.properties.timeout.description, /600.*seconds/);
  for (const [timeout, parsed] of [[100, 100_000], [600, 600_000], [601, 601]]) {
    assert.equal(schemas.Shell.parse({command: 'fixture', timeout}).timeout, parsed);
  }
  const web = pool.find(tool => tool.name === 'WebFetch')!.parameters as {properties: {prompt: {description?: string}}};
  assert.match(web.properties.prompt.description ?? '', /header only/);
});
