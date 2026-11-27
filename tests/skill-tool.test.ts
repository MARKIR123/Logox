import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {ActorContext} from '../src/actors/ensemble.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {projectDataDir} from '../src/config/project-data.js';
import {Resources} from '../src/resources/manager.js';
import {SkillUsage} from '../src/resources/skill-usage.js';
import {Tools} from '../src/tools/tools.js';
import {schemas, descriptions} from '../src/tools/index.js';

const skill = (name: string, description: string, body = 'Steps.') => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n${body}\n`;
const names = (text: string) => text.split('\n').map(line => line.split(' · ')[0]);

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-skill-tool-')));
  const home = join(root, 'home'), cwd = join(root, 'proj');
  const base = join(home, '.logox', 'skills');
  await mkdir(join(base, 'techne', 'eng'), {recursive: true});
  await mkdir(join(base, 'kalon'), {recursive: true});
  await writeFile(join(base, 'techne', 'agent.md'), '---\ncategories:\n  eng: Engineering\n---\n');
  await writeFile(join(base, 'techne', 'deploy-guide.md'), skill('deploy-guide', 'How to deploy a service', 'Deploy body line.'));
  await writeFile(join(base, 'techne', 'eng', 'ship-notes.md'), skill('ship-notes', 'Notes on deploy checklists'));
  await writeFile(join(base, 'techne', 'eng', 'lint-rules.md'), skill('lint-rules', 'Lint configuration rules'));
  await writeFile(join(base, 'kalon', 'secret-palette.md'), skill('secret-palette', 'Private palette for deploy screens'));
  await mkdir(cwd, {recursive: true});
  const resources = new Resources(cwd, {home, boundary: root});
  await resources.reload();
  const dataDir = projectDataDir(cwd, home);
  const usage = new SkillUsage({home, cwd, dataDir, resources});
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'default'), {home, dataDir});
  tools.onSkillRead = (path, context) => usage.read(path, context);
  tools.skills = {visible: actorId => resources.skillsFor({actorId}), uses: skills => usage.entriesFor(skills)};
  let prompts = 0;
  const context = (activityId = 'act', ownerId = 'techne'): ActorContext => ({sessionId: 's', activityId, ownerId, history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};},
    async permission() {prompts++; throw new Error('Unexpected approval');}});
  let n = 0;
  const run = async (args: object, ctx = context()) => {
    const result = await tools.execute({id: 'c' + ++n, name: 'Skill', arguments: JSON.stringify(args)}, ctx);
    await usage.idle();
    return result;
  };
  return {root, usage, resources, run, context, prompts: () => prompts, base,
    async done() {await rm(root, {recursive: true, force: true});}};
}

test('Skill is a registered strict tool with a description', () => {
  assert.ok('Skill' in schemas && descriptions.Skill.length > 50);
  assert.equal(schemas.Skill.safeParse({action: 'search', query: 'x', extra: 1}).success, false);
});

test('search matches every word over name, description and category, and says so when nothing matches', async () => {
  const f = await setup();
  try {
    const hit = await f.run({action: 'search', query: 'DEPLOY'});
    assert.equal(hit.isError, false);
    const lines = hit.text.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^deploy-guide · core · uses 0 · How to deploy a service · .*deploy-guide\.md$/);
    assert.match(lines[1]!, /^ship-notes · eng · uses 0 /);
    assert.match((await f.run({action: 'search', query: 'deploy lint'})).text, /No skill matches/);
    assert.match((await f.run({action: 'search', query: 'kubernetes'})).text, /No skill matches "kubernetes".*broader/);
    assert.equal(names((await f.run({action: 'search', query: 'eng ship'})).text)[0], 'ship-notes');
    assert.equal((await f.run({action: 'search', query: '  '})).isError, true);
  } finally {await f.done();}
});

test('an actor cannot find or load another actor private skill', async () => {
  const f = await setup();
  try {
    assert.match((await f.run({action: 'search', query: 'palette'})).text, /No skill matches/);
    const load = await f.run({action: 'load', name: 'secret-palette'});
    assert.equal(load.isError, true);
    assert.match(load.text, /No skill named "secret-palette"/);
    assert.match((await f.run({action: 'search', query: 'palette'}, f.context('act', 'kalon'))).text, /^secret-palette · core/);
  } finally {await f.done();}
});

test('search ranks name hits first, then usage, then name', async () => {
  const f = await setup();
  try {
    // "deploy" is in deploy-guide's name and only in ship-notes' description: the name hit wins even against more uses.
    await f.run({action: 'load', name: 'ship-notes'});
    await f.run({action: 'load', name: 'ship-notes'}, f.context('act-2'));
    assert.deepEqual(names((await f.run({action: 'search', query: 'deploy'})).text), ['deploy-guide', 'ship-notes']);
    assert.match((await f.run({action: 'search', query: 'deploy'})).text, /ship-notes · eng · uses 2/);
    // Equal name hits: usage decides, then the name.
    await writeFile(join(f.base, 'techne', 'alpha-rules.md'), skill('alpha-rules', 'Rules for alpha'));
    await f.resources.reload();
    assert.deepEqual(names((await f.run({action: 'search', query: 'rules'})).text), ['alpha-rules', 'lint-rules']);
    await f.run({action: 'load', name: 'lint-rules'});
    assert.deepEqual(names((await f.run({action: 'search', query: 'rules'})).text), ['lint-rules', 'alpha-rules']);
  } finally {await f.done();}
});

test('search lists at most ten skills', async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 12; i++) await writeFile(join(f.base, 'techne', `bulk-${String(i).padStart(2, '0')}.md`), skill(`bulk-${String(i).padStart(2, '0')}`, 'Bulk'));
    await f.resources.reload();
    const lines = (await f.run({action: 'search', query: 'bulk'})).text.split('\n');
    assert.equal(lines.filter(line => line.startsWith('bulk-')).length, 10);
    assert.match(lines.at(-1)!, /2 more/);
  } finally {await f.done();}
});

test('load returns the body without frontmatter, counts a use and asks nothing', async () => {
  const f = await setup();
  try {
    const result = await f.run({action: 'load', name: 'Deploy-Guide'});
    assert.equal(result.isError, false);
    assert.match(result.text, /^Skill deploy-guide \(.*deploy-guide\.md\)\n\n# deploy-guide\nDeploy body line\.$/);
    assert.doesNotMatch(result.text, /description:|---/);
    assert.equal((await f.usage.usage()).user['deploy-guide']?.count, 1);
    await f.run({action: 'load', name: 'deploy-guide'});
    assert.equal((await f.usage.usage()).user['deploy-guide']?.count, 1, 'once per activity');
    await f.run({action: 'search', query: 'deploy'});
    assert.equal(f.prompts(), 0);
  } finally {await f.done();}
});

test('an unknown name lists the closest visible names', async () => {
  const f = await setup();
  try {
    const result = await f.run({action: 'load', name: 'deploy'});
    assert.equal(result.isError, true);
    assert.match(result.text, /Closest names: deploy-guide/);
    assert.match((await f.run({action: 'load', name: 'zzz'})).text, /Use action "search"/);
    assert.equal((await f.run({action: 'load'})).isError, true);
  } finally {await f.done();}
});
