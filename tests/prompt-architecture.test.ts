import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {assertActorProfiles, seedActorProfiles} from '../src/actors/profiles.js';
import {ActorCatalog} from '../src/actors/catalog.js';

const root = process.cwd();

function files(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) output.push(full);
  }
  return output;
}

test('prompt tree keeps rules separated and composed by category indexes', () => {
  const promptDir = join(root, 'src', 'prompts');
  const sources = files(promptDir);
  assert.ok(sources.length > 0);
  for (const file of sources) {
    const path = relative(promptDir, file).replaceAll('\\', '/');
    assert.ok(statSync(file).size < 16 * 1024, path + ' is too large for a rule file');
    const text = readFileSync(file, 'utf8');
    if (path !== 'index.ts' && !path.endsWith('/index.ts') && path !== 'boundary.ts') {
      assert.match(text, /export (?:const|function)/, path + ' must export a rule or composer');
    }
  }
  const charter = readFileSync(join(promptDir, 'charter.ts'), 'utf8');
  for (const name of ['CORE_EXECUTION_CHARTER', 'TASK_PROGRESS_RULE', 'TOOL_USAGE_RULES', 'ROUND_SUMMARY_CONTRACT']) {
    assert.match(charter, new RegExp('export const ' + name));
  }
  const collaboration = files(join(promptDir, 'collaboration'));
  for (const name of ['common.ts', 'reporting.ts']) {
    assert.ok(collaboration.some(file => file.endsWith(name)), name);
  }
  const all = sources.map(file => readFileSync(file, 'utf8')).join('\n');
  assert.equal(all.split('ROUND_SUMMARY_CONTRACT =').length - 1, 1, 'round summary contract must have one source');
  assert.equal(all.split('TASK_REPORT_CONTRACT =').length - 1, 1, 'task report contract must have one source');
  assert.equal(all.split('HISTORY_MEMO_INSTRUCTION =').length - 1, 1, 'compaction memo must have one source');
});

test('base prompt exposes a fixed static zone order and runtime sections stay dynamic', () => {
  const result = composeBaseSystemPrompt({
    cwd: '/workspace', ownerId: 'techne', builtinPrompt: 'Techne persona', memoryFocus: 'remember the plan',
    rulesContext: 'project rules', scratchpadDir: '/tmp/scratchpad', includeSummary: true,
  });
  assert.deepEqual(result.sections.map(section => section.name),
    ['persona', 'tool_rules', 'execution_charter', 'activity_visibility', 'round_memory', 'memory_focus', 'guidelines', 'collaboration', 'environment']);
  assert.ok(result.sections.every(section => section.zone === 'static'));
  const summary = composeBaseSystemPrompt({cwd: '/workspace', ownerId: 'logox', builtinPrompt: 'Logox persona', includeSummary: false});
  assert.ok(!summary.system.includes('Round memory contract'));
});

test('shipped actor profiles seed missing-only and assert a complete install', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-profiles-'));
  try {
    const installed = await seedActorProfiles(home);
    assert.deepEqual(installed.sort(), ['aletheia', 'kalon', 'logox', 'techne']);
    assert.deepEqual(await seedActorProfiles(home), []);
    await assertActorProfiles(home);
    await writeFile(join(home, '.logox', 'actors', 'techne', 'persona.md'), 'custom');
    assert.deepEqual(await seedActorProfiles(home), [], 'never overwrite user edits');
    await rm(join(home, '.logox', 'actors', 'aletheia', 'config.yaml'));
    await assert.rejects(assertActorProfiles(home), /install-profiles/);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test('config.yaml drives built-in actor parameters in the user directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-config-yaml-'));
  try {
    await seedActorProfiles(home);
    const config = join(home, '.logox', 'actors', 'techne', 'config.yaml');
    const source = await readFile(config, 'utf8');
    await writeFile(config, source.replace(/^title:.*$/m, 'title: Changed Title'));
    const catalog = new ActorCatalog(home, {home});
    await catalog.load();
    assert.equal(catalog.find('techne')?.title, 'Changed Title');
    assert.equal(catalog.find('techne')?.id, 'techne');
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});
