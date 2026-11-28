import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {ActorContext} from '../src/actors/ensemble.js';
import {createApplication} from '../src/application.js';
import {createSkillsPage} from '../src/commands/skills-page.js';
import {synopsisBlock} from '../src/context/synopsis.js';
import {projectDataDir} from '../src/config/project-data.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {ensureUserSkillsSeeded, Resources} from '../src/resources/manager.js';
import {archiveSkillFile} from '../src/resources/skill-archive.js';
import {ARCHIVE_ACTIVE_DAYS, STALE_ACTIVE_DAYS, SkillCurator, type SkillRestored} from '../src/resources/skill-curator.js';
import {SkillUsage, dayOf} from '../src/resources/skill-usage.js';
import {Tools} from '../src/tools/tools.js';

const NOON = new Date(2026, 10, 27, 12).getTime();
const TODAY = dayOf(NOON);
/** `count` distinct active days starting `first` days after 2026-02-01 (all long before NOON's day). */
const activeDays = (count: number, first = 0) => Array.from({length: count}, (_, index) => dayOf(new Date(2026, 1, 1 + first + index).getTime()));
const LONG_AGO = '2026-01-01';
const skillText = (name: string, extra = '') => '---\nname: ' + name + '\ndescription: Test skill ' + name + ' about deploy\n' + extra + '---\n# ' + name + '\nSteps for ' + name + '.\n';

async function world(now: () => number = () => NOON) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-skill-curator-')));
  const home = join(root, 'home'), cwd = join(root, 'proj');
  const userRoot = join(home, '.logox', 'skills'), projectRoot = join(cwd, '.logox', 'skills');
  await mkdir(join(userRoot, 'techne', 'eng'), {recursive: true});
  await mkdir(join(projectRoot, 'techne'), {recursive: true});
  await writeFile(join(userRoot, 'techne', 'agent.md'), '---\ncategories:\n  eng: Engineering\n---\n');
  const resources = new Resources(cwd, {home, boundary: root});
  const dataDir = projectDataDir(cwd, home);
  const errors: unknown[] = [];
  const usage = new SkillUsage({home, cwd, dataDir, resources, now, onError: error => errors.push(error)});
  const curator = resources.curator = new SkillCurator({usage, resources, now, onError: error => errors.push(error)});
  const usageFile = join(userRoot, '.usage.json');
  return {root, home, cwd, userRoot, projectRoot, dataDir, resources, usage, curator, errors, usageFile,
    /** Writes the user usage file (the active days and the skills' clocks) the way `SkillUsage` keeps it. */
    async writeUsage(value: {activeDays: string[]; skills?: object; seen?: Record<string, string>; archive?: object}) {
      await writeFile(usageFile, JSON.stringify({version: 1, skills: {}, seen: {}, archive: {}, ...value}) + '\n');
    },
    async stored() {return JSON.parse(await readFile(usageFile, 'utf8')) as {activeDays: string[]; seen: Record<string, string>; archive: Record<string, {archivedAt?: number; restores: number}>};},
    async run() {await resources.reload(); return curator.run();},
    async done() {await rm(root, {recursive: true, force: true});}};
}
type World = Awaited<ReturnType<typeof world>>;
const live = (f: World) => f.resources.snapshot().skills.map(skill => skill.name).sort();

test('thresholds count active days: stale at 14, archived at 30, never earlier', async () => {
  assert.equal(STALE_ACTIVE_DAYS, 14);
  assert.equal(ARCHIVE_ACTIVE_DAYS, 30);
  for (const [days, staleNow, archivedNow] of [[13, false, false], [14, true, false], [29, true, false], [30, false, true]] as const) {
    const f = await world();
    try {
      const file = join(f.userRoot, 'techne', 'eng', 'idle.md');
      await writeFile(file, skillText('idle'));
      await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(days)], seen: {idle: LONG_AGO}});
      const run = await f.run();
      assert.equal(f.curator.stale().has('idle'), staleNow, days + ' active days: stale');
      assert.equal(run.archived.includes('idle'), archivedNow, days + ' active days: archived');
      assert.equal(existsSync(file), !archivedNow);
      assert.equal(existsSync(join(f.userRoot, '.archive', 'techne', 'eng', 'idle.md')), archivedNow);
      assert.deepEqual(f.errors, []);
    } finally {await f.done();}
  }
});

test('idle time starts at the last use, not at the first sighting, and calendar days alone never archive', async () => {
  const f = await world();
  try {
    await writeFile(join(f.userRoot, 'techne', 'eng', 'recent.md'), skillText('recent'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'quiet.md'), skillText('quiet'));
    // `recent` was last used on the 10th of 30 active days, so 20 active days follow its last use.
    const days = activeDays(30);
    await f.writeUsage({activeDays: days, seen: {recent: LONG_AGO, quiet: LONG_AGO},
      skills: {recent: {count: 3, lastUsedAt: 1, lastUsedDay: days[9]}}});
    const run = await f.run();
    assert.deepEqual(run.archived, ['quiet']);
    assert.ok(f.curator.stale().has('recent'), '20 active days after the last use is stale');
    assert.ok(!f.curator.stale().has('quiet'));
    // Many calendar days but no new active day: nothing changes.
    const later = await world(() => NOON + 400 * 24 * 3600 * 1000);
    try {
      await writeFile(join(later.userRoot, 'techne', 'eng', 'calm.md'), skillText('calm'));
      await later.writeUsage({activeDays: [LONG_AGO], seen: {calm: LONG_AGO}});
      assert.deepEqual((await later.run()).archived, []);
    } finally {await later.done();}
  } finally {await f.done();}
});

test('pinned skills are never touched, however idle', async () => {
  const f = await world();
  try {
    await writeFile(join(f.userRoot, 'techne', 'eng', 'keeper.md'), skillText('keeper', 'pinned: true\n'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'plain.md'), skillText('plain'));
    await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(80)], seen: {keeper: LONG_AGO, plain: LONG_AGO}});
    const run = await f.run();
    assert.deepEqual(run.archived, ['plain']);
    assert.ok(existsSync(join(f.userRoot, 'techne', 'eng', 'keeper.md')));
    assert.ok(f.resources.snapshot().skills.find(skill => skill.name === 'keeper')?.pinned);
    assert.ok(!f.curator.stale().has('keeper'));
  } finally {await f.done();}
});

test('a skill never seen before starts its idle clock at first sight and survives day one', async () => {
  const f = await world();
  try {
    const file = join(f.userRoot, 'techne', 'eng', 'fresh.md');
    await writeFile(file, skillText('fresh'));
    await f.writeUsage({activeDays: activeDays(60)});
    const first = await f.run();
    assert.deepEqual(first.archived, []);
    assert.deepEqual(first.seen, ['fresh']);
    assert.equal((await f.stored()).seen.fresh, TODAY);
    assert.ok(existsSync(file));
    // Thirty active days after the first sighting it goes (Dec 2026 is after TODAY).
    await f.writeUsage({activeDays: [...activeDays(60), ...Array.from({length: 29}, (_, i) => dayOf(new Date(2026, 11, 1 + i).getTime()))], seen: {fresh: TODAY}});
    assert.deepEqual((await f.run()).archived, [], '29 active days since the first sighting');
    await f.writeUsage({activeDays: [...activeDays(60), ...Array.from({length: 30}, (_, i) => dayOf(new Date(2026, 11, 1 + i).getTime()))], seen: {fresh: TODAY}});
    assert.deepEqual((await f.run()).archived, ['fresh']);
  } finally {await f.done();}
});

test('archiving keeps the relative path, covers skill directories and project skills, records the archive and deletes nothing', async () => {
  const f = await world();
  try {
    const body = skillText('docs-skill');
    await writeFile(join(f.userRoot, 'techne', 'eng', 'docs-skill.md'), body);
    await mkdir(join(f.userRoot, 'techne', 'eng', 'folder-skill'), {recursive: true});
    await writeFile(join(f.userRoot, 'techne', 'eng', 'folder-skill', 'SKILL.md'), skillText('folder-skill'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'folder-skill', 'notes.txt'), 'sidecar');
    await writeFile(join(f.projectRoot, 'techne', 'local-skill.md'), skillText('local-skill'));
    await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(40)], seen: {'docs-skill': LONG_AGO, 'folder-skill': LONG_AGO}});
    await mkdir(f.dataDir, {recursive: true});
    await writeFile(join(f.dataDir, 'skill-usage.json'), JSON.stringify({version: 1, activeDays: [], skills: {}, seen: {'local-skill': LONG_AGO}, archive: {}}) + '\n');
    const run = await f.run();
    assert.deepEqual([...run.archived].sort(), ['docs-skill', 'folder-skill', 'local-skill']);
    assert.equal(await readFile(join(f.userRoot, '.archive', 'techne', 'eng', 'docs-skill.md'), 'utf8'), body);
    assert.ok(existsSync(join(f.userRoot, '.archive', 'techne', 'eng', 'folder-skill', 'SKILL.md')));
    assert.equal(await readFile(join(f.userRoot, '.archive', 'techne', 'eng', 'folder-skill', 'notes.txt'), 'utf8'), 'sidecar');
    assert.ok(!existsSync(join(f.userRoot, 'techne', 'eng', 'folder-skill')));
    assert.ok(existsSync(join(f.projectRoot, '.archive', 'techne', 'local-skill.md')), 'project skills archive inside the project skill root');
    const stored = await f.stored();
    assert.equal(stored.archive['docs-skill']?.restores, 0);
    assert.ok((stored.archive['docs-skill']?.archivedAt ?? 0) > 0);
    // The normal listings ignore the archive; it is only reported.
    assert.deepEqual(live(f), []);
    assert.deepEqual(f.resources.snapshot().archivedSkills.map(skill => skill.name).sort(), ['docs-skill', 'folder-skill', 'local-skill']);
    assert.deepEqual(f.errors, []);
  } finally {await f.done();}
});

test('the prompt names the archive in one line only when something is archived, and a restore never changes it mid-session', async () => {
  const f = await world();
  try {
    await writeFile(join(f.userRoot, 'techne', 'eng', 'old-one.md'), skillText('old-one'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'kept-one.md'), skillText('kept-one'));
    await f.resources.reload();
    const line = /\d+ archived skills — searchable with Skill search/;
    const visibility = {actorId: 'techne'};
    assert.doesNotMatch(f.resources.promptSections(visibility).skills, line);
    await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(40)], seen: {'old-one': LONG_AGO, 'kept-one': TODAY}});
    await f.run();
    const prompt = f.resources.promptSections(visibility).skills;
    assert.match(prompt, /^1 archived skills — searchable with Skill search$/m);
    assert.ok(!prompt.includes('old-one'));
    assert.ok(prompt.includes('kept-one'));
    // Restoring makes the skill usable at once, but the prompt (frozen per reload) stays byte-identical.
    await f.curator.restore('old-one');
    assert.equal(f.resources.promptSections(visibility).skills, prompt);
    assert.ok(f.resources.skillsFor(visibility).some(skill => skill.name === 'old-one'));
    assert.equal(f.resources.archived().length, 0);
    await f.resources.reload();
    const after = f.resources.promptSections(visibility).skills;
    assert.doesNotMatch(after, line);
    assert.ok(after.includes('old-one'));
  } finally {await f.done();}
});

test('seeding skips built-in skills whose archived copy exists, and a shipped skill stays archived across reloads', async () => {
  const f = await world();
  try {
    const builtin = join(f.root, 'builtin');
    await mkdir(join(builtin, 'techne', 'eng'), {recursive: true});
    await writeFile(join(builtin, 'techne', 'eng', 'shipped.md'), skillText('shipped'));
    await writeFile(join(builtin, 'techne', 'eng', 'other.md'), skillText('other'));
    await ensureUserSkillsSeeded(f.userRoot, builtin);
    const seeded = join(f.userRoot, 'techne', 'eng', 'shipped.md');
    assert.ok(existsSync(seeded));
    await archiveSkillFile(f.userRoot, await realpath(seeded));
    assert.ok(!existsSync(seeded));
    await ensureUserSkillsSeeded(f.userRoot, builtin);
    assert.ok(!existsSync(seeded), 'seeding must not bring an archived built-in back');
    assert.ok(existsSync(join(f.userRoot, 'techne', 'eng', 'other.md')));
    // With a never-deleted archive but a missing one, seeding still fills in the gap.
    await rm(join(f.userRoot, 'techne', 'eng', 'other.md'));
    await ensureUserSkillsSeeded(f.userRoot, builtin);
    assert.ok(existsSync(join(f.userRoot, 'techne', 'eng', 'other.md')));
  } finally {await f.done();}
});

test('the shipped skills archive through their seeded copy and no reload brings them back', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-skill-curator-ship-')));
  try {
    const home = join(root, 'home'), cwd = join(root, 'proj');
    await mkdir(cwd, {recursive: true});
    await mkdir(join(home, '.logox', 'skills'), {recursive: true});
    const resources = new Resources(cwd, {home});
    await resources.reload();
    assert.ok(resources.snapshot().skills.some(skill => skill.name === 'browser-screenshot'), 'the shipped skill is seeded and loaded');
    const usage = new SkillUsage({home, cwd, dataDir: projectDataDir(cwd, home), resources, now: () => NOON});
    const curator = resources.curator = new SkillCurator({usage, resources, now: () => NOON});
    await writeFile(join(home, '.logox', 'skills', '.usage.json'), JSON.stringify({version: 1, activeDays: [LONG_AGO, ...activeDays(40)], skills: {}, seen: {'browser-screenshot': LONG_AGO}, archive: {}}) + '\n');
    const run = await curator.run();
    assert.ok(run.archived.includes('browser-screenshot'));
    assert.ok(!resources.snapshot().skills.some(skill => skill.name === 'browser-screenshot'));
    await resources.reload();
    assert.ok(!resources.snapshot().skills.some(skill => skill.name === 'browser-screenshot'), 'neither the seeded copy nor the shipped root loads it');
    assert.ok(resources.snapshot().archivedSkills.some(skill => skill.name === 'browser-screenshot'));
    await curator.restore('browser-screenshot');
    await resources.reload();
    assert.ok(resources.snapshot().skills.some(skill => skill.name === 'browser-screenshot'));
  } finally {await rm(root, {recursive: true, force: true});}
});

async function skillTool(f: World) {
  const tools = new Tools(f.cwd, undefined, new PermissionEngine(f.cwd, 'default'), {home: f.home, dataDir: f.dataDir});
  tools.onSkillRead = (path, context) => f.usage.read(path, context);
  tools.skills = {visible: actorId => f.resources.skillsFor({actorId}), uses: skills => f.usage.entriesFor(skills),
    archived: actorId => f.resources.archivedFor({actorId}), restore: name => f.curator.restore(name)};
  const context = (): ActorContext => ({sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}});
  let n = 0;
  return async (args: object) => {
    const result = await tools.execute({id: 'c' + ++n, name: 'Skill', arguments: JSON.stringify(args)}, context());
    await f.usage.idle();
    return result;
  };
}

test('Skill search finds archived skills marked archived, and load restores one and counts a use', async () => {
  const f = await world();
  try {
    const file = join(f.userRoot, 'techne', 'eng', 'ship-it.md');
    await writeFile(file, skillText('ship-it'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'ship-live.md'), skillText('ship-live'));
    await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(40)], seen: {'ship-it': LONG_AGO, 'ship-live': TODAY}});
    await f.run();
    const run = await skillTool(f);
    const found = await run({action: 'search', query: 'deploy'});
    assert.equal(found.isError, false);
    const lines = found.text.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.find(line => line.startsWith('ship-it · '))?.includes(' · archived · '));
    assert.ok(!lines.find(line => line.startsWith('ship-live · '))?.includes('archived'));
    assert.ok(!existsSync(file));
    const loaded = await run({action: 'load', name: 'ship-it'});
    assert.equal(loaded.isError, false);
    assert.match(loaded.text, /Restored from the archive\./);
    assert.match(loaded.text, /Steps for ship-it\./);
    assert.ok(existsSync(file), 'the skill is back at its original path');
    assert.ok(!existsSync(join(f.userRoot, '.archive', 'techne', 'eng', 'ship-it.md')));
    const stored = await f.stored();
    assert.equal(stored.archive['ship-it']?.restores, 1);
    assert.equal(stored.archive['ship-it']?.archivedAt, undefined);
    assert.equal(stored.seen['ship-it'], TODAY, 'the idle clock restarts');
    assert.equal((await f.usage.usage()).user['ship-it']?.count, 1, 'the load counts as a use');
    const again = await run({action: 'search', query: 'ship-it'});
    assert.ok(!again.text.includes('archived'));
    const second = await run({action: 'load', name: 'ship-it'});
    assert.doesNotMatch(second.text, /Restored from the archive/);
  } finally {await f.done();}
});

test('the second restore of a skill suggests pinning it; the first does not', async () => {
  const f = await world();
  try {
    await writeFile(join(f.userRoot, 'techne', 'eng', 'boomerang.md'), skillText('boomerang'));
    const seen: SkillRestored[] = [];
    f.curator.onRestored = info => seen.push(info);
    for (const round of [1, 2, 3]) {
      await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(40)], seen: {boomerang: LONG_AGO}, archive: (await f.stored().catch(() => undefined))?.archive ?? {}});
      assert.deepEqual((await f.run()).archived, ['boomerang'], 'round ' + round);
      await f.curator.restore('boomerang');
      assert.equal(seen.at(-1)?.restores, round);
      assert.equal(seen.at(-1)?.pinSuggested, round >= 2);
    }
    assert.deepEqual(seen.map(item => item.pinSuggested), [false, true, true]);
  } finally {await f.done();}
});

test('restore refuses to overwrite a skill that stands at the original place', async () => {
  const f = await world();
  try {
    const file = join(f.userRoot, 'techne', 'eng', 'twin.md');
    await writeFile(file, skillText('twin'));
    await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(40)], seen: {twin: LONG_AGO}});
    await f.run();
    await writeFile(file, skillText('twin', 'description-note: made again\n'));
    await f.resources.reload();
    await assert.rejects(f.curator.restore('twin'), /already exists/);
    assert.ok(existsSync(join(f.userRoot, '.archive', 'techne', 'eng', 'twin.md')), 'the archived copy is kept');
    await assert.rejects(f.curator.restore('nobody'), /No archived skill/);
  } finally {await f.done();}
});

test('the /skills page marks stale and pinned skills and restores from the Archived tab', async () => {
  const f = await world();
  try {
    await writeFile(join(f.userRoot, 'techne', 'eng', 'dusty.md'), skillText('dusty'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'gone.md'), skillText('gone'));
    await writeFile(join(f.userRoot, 'techne', 'eng', 'always.md'), skillText('always', 'pinned: true\n'));
    await f.writeUsage({activeDays: [LONG_AGO, ...activeDays(40)], seen: {dusty: activeDays(40)[20]!, always: LONG_AGO, gone: LONG_AGO}});
    await f.run();
    let refreshed = 0;
    const page = createSkillsPage({resources: f.resources, actors: {find: () => undefined}, pageOwner: () => 'techne', refreshPage: () => {refreshed++;}});
    const content = page.content();
    const skills = content.skills.map(line => typeof line === 'string' ? line : 'label' in line ? line.label + ': ' + line.value : 'text' in line ? line.text : '');
    assert.ok(skills.some(line => line.startsWith('dusty [stale]: ')), skills.join('\n'));
    assert.ok(skills.some(line => line.startsWith('always [pinned]: ')));
    assert.ok(!skills.some(line => line.startsWith('gone')));
    assert.deepEqual(content.archivedActions.map(action => action.key), ['n', 'p', 'r']);
    assert.ok(JSON.stringify(content.archived).includes('❯ gone'));
    const result = await page.action('restore');
    assert.equal(result.message, 'Restored skill gone');
    assert.equal(refreshed, 1);
    assert.ok(existsSync(join(f.userRoot, 'techne', 'eng', 'gone.md')));
    assert.deepEqual(page.content().archivedActions, []);
    assert.ok(JSON.stringify(page.content().skills).includes('gone'));
  } finally {await f.done();}
});

test('application: the session start archives idle skills, /<name> restores one, and the second restore posts the pin notice', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-skill-curator-app-')));
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const home = join(root, 'home'), cwd = join(root, 'proj');
    const skills = join(home, '.logox', 'skills');
    await mkdir(join(skills, 'logox', 'eng'), {recursive: true});
    await mkdir(join(cwd, '.logox'), {recursive: true});
    await writeFile(join(skills, 'logox', 'eng', 'ancient.md'), skillText('ancient'));
    await writeFile(join(skills, 'logox', 'eng', 'pinned-old.md'), skillText('pinned-old', 'pinned: true\n'));
    await writeFile(join(skills, 'logox', 'eng', 'middling.md'), skillText('middling'));
    await writeFile(join(skills, '.usage.json'), JSON.stringify({version: 1, activeDays: [LONG_AGO, ...activeDays(40)], skills: {},
      seen: {ancient: LONG_AGO, 'pinned-old': LONG_AGO, middling: activeDays(40)[20]!}, archive: {ancient: {restores: 1}}}) + '\n');
    app = await createApplication({cwd, env: {}, resourceOptions: {home, boundary: root}, authPath: join(home, '.logox', 'auth.json'),
      statusbarPath: join(home, '.logox', 'statusbar.json'),
      provider: {async respond() {return {message: {role: 'assistant' as const, text: 'ok\n\n' + synopsisBlock({title: 'Done', summary: 'Round outcome.'})}, stop: 'complete' as const};}}});
    assert.ok(!existsSync(join(skills, 'logox', 'eng', 'ancient.md')), 'archived at session start');
    assert.ok(existsSync(join(skills, '.archive', 'logox', 'eng', 'ancient.md')));
    assert.ok(existsSync(join(skills, 'logox', 'eng', 'pinned-old.md')));
    await app.submit('/skills');
    const surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'page');
    if (surface?.kind !== 'page') return;
    assert.deepEqual(surface.tabs.map(tab => tab.id), ['skills', 'archived']);
    assert.ok(surface.tabs[0]!.lines.some(line => line.startsWith('middling [stale]: ')));
    assert.ok(surface.tabs[1]!.lines.some(line => line.includes('ancient')));
    assert.deepEqual(surface.tabs[1]!.actions?.map(action => action.id), ['archived_next', 'archived_prev', 'restore']);
    app.surfaces.cancel();
    await app.submit('/ancient');
    assert.ok(existsSync(join(skills, 'logox', 'eng', 'ancient.md')), '/<name> restores the archived skill');
    const flagged = app.notices.getSnapshot().find(item => item.id === 'skill-pin:ancient');
    assert.ok(flagged, 'the second restore posts a read notice');
    assert.match(flagged.parts[0]!.text, /Restored ancient twice — add `pinned: true` to keep it/);
    await assert.rejects(app.submit('/missing-skill'), /Unknown command/);
  } finally {
    try {await app?.close();} finally {await rm(root, {recursive: true, force: true});}
  }
});
