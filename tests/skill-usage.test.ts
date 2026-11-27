import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readdir, rm, realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, sep} from 'node:path';
import {tmpdir} from 'node:os';
import type {ActorContext} from '../src/actors/ensemble.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {projectDataDir} from '../src/config/project-data.js';
import {Resources} from '../src/resources/manager.js';
import {SkillUsage, activeDaysSince, dayOf} from '../src/resources/skill-usage.js';
import {Tools} from '../src/tools/tools.js';

const skillText = (name: string) => '---\nname: ' + name + '\ndescription: Test skill ' + name + '\n---\n# ' + name + '\nSteps.\n';
const NOON = new Date(2026, 10, 27, 12).getTime();

async function setup(now: () => number = () => NOON) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-skill-usage-')));
  const home = join(root, 'home'), cwd = join(root, 'proj');
  const userDir = join(home, '.logox', 'skills', 'techne'), projectDir = join(cwd, '.logox', 'skills', 'techne');
  await mkdir(userDir, {recursive: true}); await mkdir(projectDir, {recursive: true});
  await writeFile(join(userDir, 'agent.md'), '---\ncategories:\n  eng: Engineering\n---\n');
  await writeFile(join(userDir, 'alpha.md'), skillText('alpha'));
  await writeFile(join(projectDir, 'beta.md'), skillText('beta'));
  await writeFile(join(cwd, 'notes.md'), '# Notes\n');
  const resources = new Resources(cwd, {home, boundary: root});
  await resources.reload();
  const dataDir = projectDataDir(cwd, home);
  const errors: unknown[] = [];
  const usage = new SkillUsage({home, cwd, dataDir, resources, now, onError: error => errors.push(error)});
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'), {home, dataDir});
  tools.onSkillRead = (path, context) => usage.read(path, context);
  const context = (activityId = 'act', via?: ActorContext['via']): ActorContext => ({sessionId: 's', activityId, ownerId: 'techne', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');},
    ...(via ? {via} : {})});
  let n = 0;
  const read = async (file: string, ctx = context()) => {
    const result = await tools.execute({id: 'c' + ++n, name: 'Read', arguments: JSON.stringify({file_path: file})}, ctx);
    await usage.idle();
    return result;
  };
  return {root, home, cwd, dataDir, usage, tools, read, context, errors, userDir, projectDir,
    async done() {await rm(root, {recursive: true, force: true});}};
}

test('a successful Read of a skill counts it in the user file; agent.md and other files never count', async () => {
  const f = await setup();
  try {
    await f.read(join(f.userDir, 'agent.md'));
    await f.read(join(f.cwd, 'notes.md'));
    assert.deepEqual((await f.usage.usage()).user, {});
    const result = await f.read(join(f.userDir, 'alpha.md'));
    assert.notEqual(result.isError, true);
    const seen = await f.usage.usage();
    assert.deepEqual(seen.user, {alpha: {count: 1, lastUsedAt: NOON, lastUsedDay: dayOf(NOON)}});
    assert.deepEqual(seen.activeDays, [dayOf(NOON)]);
    assert.ok(existsSync(join(f.home, '.logox', 'skills', '.usage.json')));
    assert.deepEqual(f.errors, []);
  } finally {await f.done();}
});

test('a skill counts once per activity and again in the next one', async () => {
  const f = await setup();
  try {
    const file = join(f.userDir, 'alpha.md');
    await f.read(file); await f.read(file); await f.read(file, f.context('act'));
    assert.equal((await f.usage.usage()).user.alpha?.count, 1);
    await f.read(file, f.context('act-2'));
    assert.equal((await f.usage.usage()).user.alpha?.count, 2);
  } finally {await f.done();}
});

test('a failed Read does not count', async () => {
  const f = await setup();
  try {
    const result = await f.read(join(f.userDir, 'missing.md'));
    assert.equal(result.isError, true);
    assert.deepEqual((await f.usage.usage()).user, {});
    // Nothing was counted, so the real read in the same activity still counts.
    await f.read(join(f.userDir, 'alpha.md'));
    assert.equal((await f.usage.usage()).user.alpha?.count, 1);
  } finally {await f.done();}
});

test('a project skill is counted in the project data folder and nothing else is written into the project', async () => {
  const f = await setup();
  try {
    await f.read(join(f.projectDir, 'beta.md'));
    const seen = await f.usage.usage();
    assert.equal(seen.project.beta?.count, 1);
    assert.deepEqual(seen.user, {});
    assert.ok(existsSync(join(f.dataDir, 'skill-usage.json')));
    assert.deepEqual((await readdir(join(f.cwd, '.logox'), {recursive: true})).map(name => name.replaceAll(sep, '/')).sort(), ['skills', 'skills/techne', 'skills/techne/beta.md']);
    assert.deepEqual((await readdir(f.cwd)).sort(), ['.logox', 'notes.md']);
    assert.deepEqual((await readdir(join(f.home, '.logox', 'skills'), {recursive: true})).map(name => name.replaceAll(sep, '/')).filter(name => name.includes('usage')), ['.usage.json']);
  } finally {await f.done();}
});

test('active days: a session start records today, days are distinct, sorted and bounded; activeDaysSince counts strictly later days', async () => {
  let now = NOON;
  const f = await setup(() => now);
  try {
    f.usage.recordDay(); f.usage.recordDay();
    for (let i = 0; i < 405; i++) {now = NOON + (i + 1) * 86_400_000; f.usage.recordDay();}
    const days = (await f.usage.usage()).activeDays;
    assert.equal(days.length, 400);
    assert.deepEqual([...days].sort(), days);
    assert.equal(days.at(-1), dayOf(now));
    assert.equal(activeDaysSince(['2026-01-01', '2026-01-02', '2026-01-02', '2026-01-05'], '2026-01-01'), 2);
    assert.equal(activeDaysSince(['2026-01-01'], '2026-01-01'), 0);
  } finally {await f.done();}
});

test('a worker read counts too', async () => {
  const f = await setup();
  try {
    await f.read(join(f.userDir, 'alpha.md'), f.context('act', {label: "Techne's reader", workerId: 'w1', grant: {} as never}));
    assert.equal((await f.usage.usage()).user.alpha?.count, 1);
  } finally {await f.done();}
});

test('concurrent records in one process do not lose updates', async () => {
  const f = await setup();
  try {
    const file = join(f.userDir, 'alpha.md');
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(id => f.tools.execute({id, name: 'Read', arguments: JSON.stringify({file_path: file})}, f.context('act-' + id))));
    await f.usage.idle();
    assert.equal((await f.usage.usage()).user.alpha?.count, 5);
  } finally {await f.done();}
});
