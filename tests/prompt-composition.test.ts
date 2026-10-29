import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseActorProfile, parseActor, serializeActor} from '../src/actors/definitions.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {builtinActors} from '../src/actors/builtins.js';
import {composeBaseSystemPrompt} from '../src/prompts/boundary.js';
import {Resources} from '../src/resources/manager.js';

const config = 'id: custom-specialist\nname: Specialist\ntitle: Specialist\ndescription: A custom specialist\ncolor: "#112233"\nsymbol: ◈\nskills: []\n';

test('optional role rules survive directory and legacy definition round trips', () => {
  const files = {config, persona: 'A precise specialist.', compression: 'Remember evidence.',
    execution: 'Investigate interfaces first.', collaboration: 'Deliver evidence to the requester.'};
  const role = parseActorProfile(files);
  assert.equal(Reflect.get(role, 'execution'), files.execution);
  assert.equal(Reflect.get(role, 'collaboration'), files.collaboration);
  assert.deepEqual(parseActor(serializeActor(role)), role);
  const minimal = parseActorProfile({config, persona: files.persona, compression: files.compression});
  assert.equal(Reflect.get(minimal, 'execution'), undefined);
});

test('system assembly has five themes and keeps environment facts after stable rules', () => {
  const {system} = composeBaseSystemPrompt({cwd: '/workspace', ownerId: 'custom-specialist',
    customPrompt: 'A precise specialist.', memoryFocus: 'Remember evidence.',
    rulesContext: 'A project constraint.', scratchpadDir: '/tmp/probes'});
  assert.deepEqual(system.match(/^# .+$/gm), [
    '# Persona', '# Execution Rules', '# Team Collaboration', '# Tools & Skills', '# Current Environment',
  ]);
  assert.ok(system.indexOf('Remember evidence.') < system.indexOf('# Team Collaboration'));
  assert.ok(system.indexOf('A project constraint.') < system.indexOf('# Team Collaboration'));
  assert.ok(system.indexOf('Working directory: /workspace') > system.indexOf('# Current Environment'));
  assert.equal(system.split('Working directory: /workspace').length - 1, 1);
});

test('catalog appends user and project role rules and rejects invalid optional assets atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-role-rules-'));
  try {
    const home = join(root, 'home'), cwd = join(root, 'project');
    const user = join(home, '.logox', 'actors', 'custom-specialist');
    const project = join(cwd, '.logox', 'actors', 'custom-specialist');
    for (const dir of [user, project]) {
      await mkdir(dir, {recursive: true});
      await writeFile(join(dir, 'config.yaml'), config);
      await writeFile(join(dir, 'compression.md'), 'Remember evidence.');
    }
    await writeFile(join(user, 'persona.md'), 'User identity.');
    await writeFile(join(project, 'persona.md'), 'Project extension.');
    await writeFile(join(user, 'execution.md'), 'User work method.');
    await writeFile(join(project, 'execution.md'), 'Project work method.');
    await writeFile(join(project, 'collaboration.md'), 'Project collaboration.');
    const catalog = new ActorCatalog(cwd, {home});
    assert.equal((await catalog.load()).issues.length, 0);
    const role = catalog.find('custom-specialist')!;
    assert.match(role.prompt, /User identity\.[\s\S]*Project extension\./);
    assert.match(String(Reflect.get(role, 'execution')), /User work method\.[\s\S]*Project work method\./);
    assert.equal(Reflect.get(role, 'collaboration'), 'Project collaboration.');
    const before = catalog.list();
    for (const invalid of [Buffer.from([0xff]), Buffer.alloc(65537, 120)]) {
      await writeFile(join(project, 'execution.md'), invalid);
      assert.ok((await catalog.reload()).issues.length > 0);
      assert.equal(catalog.list(), before);
    }
    await rm(join(project, 'execution.md'));
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(project, 'execution.md'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.ok((await catalog.reload()).issues.length > 0);
    assert.equal(catalog.list(), before);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('shipped personas keep identity separate from orchestration procedures', () => {
  for (const role of builtinActors) {
    assert.match(role.prompt, new RegExp(role.name, 'i'));
    assert.doesNotMatch(role.prompt, /Ensemble Orchestration Principles|Conclude Turn After Dispatch|_FinishRound|scratchpad|SendMessage/);
  }
});

test('resources expose guidelines and skill discovery as separate prompt inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-prompt-resources-'));
  try {
    await writeFile(join(root, 'AGENTS.md'), 'Project-only constraint.');
    const skill = join(root, '.logox', 'skills', 'public');
    await mkdir(skill, {recursive: true});
    await writeFile(join(skill, 'example.md'), '---\nname: example\ndescription: A short skill\n---\nFull skill body stays on disk.');
    const resources = new Resources(root, {home: root, boundary: root});
    await resources.reload();
    const split = Reflect.get(resources, 'promptSections');
    assert.equal(typeof split, 'function');
    const result = split.call(resources, {actorId: 'custom-specialist'});
    assert.ok(result.guidelines.some((item: {text: string}) => item.text.includes('Project-only constraint.')));
    assert.match(result.skills, /example: A short skill/);
    assert.doesNotMatch(result.skills, /Project-only constraint|Full skill body/);
  } finally {await rm(root, {recursive: true, force: true});}
});
