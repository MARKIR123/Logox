import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Resources, ensureUserSkillsSeeded} from '../src/resources/manager.js';

test('Hierarchical Skills: loads built-in skills and assigns actor visibility by directory path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-skills-'));
  try {
    const resources = new Resources(root, {home: root});
    const snapshot = await resources.reload();

    const skillNames = snapshot.skills.map(s => s.name);
    // Logox workflow SOPs
    assert.ok(skillNames.includes('feature-assembly'));
    assert.ok(skillNames.includes('bugfix-rootcause'));
    assert.ok(skillNames.includes('codebase-refactor'));
    assert.ok(skillNames.includes('deep-research'));

    // Kalon design & literature SOPs
    assert.ok(skillNames.includes('morandi-palette'));
    assert.ok(skillNames.includes('semantic-palette'));
    assert.ok(skillNames.includes('material-design'));
    assert.ok(skillNames.includes('flat-design'));
    assert.ok(skillNames.includes('text-polishing'));

    // Techne engineering SOPs
    assert.ok(skillNames.includes('tdd-workflow'));
    assert.ok(skillNames.includes('defensive-coding'));
    assert.ok(skillNames.includes('single-writer'));
    assert.ok(skillNames.includes('state-machine'));

    // Aletheia audit & academic SOPs
    assert.ok(skillNames.includes('literature-review'));
    assert.ok(skillNames.includes('paper-writing'));
    assert.ok(skillNames.includes('repo-audit'));
    assert.ok(skillNames.includes('visual-qa'));

    // Public SOPs
    assert.ok(skillNames.includes('browser-screenshot'));
    assert.ok(skillNames.includes('skill-internalization'));

    // Check level classification
    const designPrinciples = snapshot.skills.find(s => s.name === 'design-principles');
    assert.equal(designPrinciples?.level, 'core');
    const flatDesign = snapshot.skills.find(s => s.name === 'flat-design');
    assert.equal(flatDesign?.level, 'domain');
    assert.equal(flatDesign?.category, 'styling');

    // Check categories parsed from agent.md
    assert.ok(snapshot.categories.some(c => c.actor === 'kalon' && c.category === 'styling'));
    assert.ok(snapshot.categories.some(c => c.actor === 'kalon' && c.category === 'color'));
    assert.ok(snapshot.categories.some(c => c.actor === 'techne' && c.category === 'engineering'));
    assert.ok(snapshot.categories.some(c => c.actor === 'aletheia' && c.category === 'inspection'));

    // Check visibility filtering
    const kalonSkills = resources.skillsFor({actorId: 'kalon'}).map(s => s.name);
    assert.ok(kalonSkills.includes('morandi-palette'));
    assert.ok(kalonSkills.includes('browser-screenshot')); // public is visible to all
    assert.ok(!kalonSkills.includes('tdd-workflow')); // Techne-only skill not visible without borrowing

    // Borrowing allows cross-actor access
    const borrowed = resources.skillsFor({actorId: 'kalon', borrowed: ['tdd-workflow']}).map(s => s.name);
    assert.ok(borrowed.includes('tdd-workflow'));

    // Progressive Prompt Formatting: Kalon sees Core Principles and Domain Repositories, but NOT individual domain files
    const kalonPrompt = resources.prompt({actorId: 'kalon'}).context;
    assert.ok(kalonPrompt.includes('【Core Principles】'));
    assert.ok(kalonPrompt.includes('design-principles'));
    assert.ok(kalonPrompt.includes('browser-screenshot'));
    assert.ok(kalonPrompt.includes('skill-internalization'));
    assert.ok(kalonPrompt.includes('【Domain Repositories】'));
    assert.ok(kalonPrompt.includes('styling/: Visual UI design languages'));
    assert.ok(kalonPrompt.includes('color/: Specialized palettes'));
    assert.ok(kalonPrompt.includes('literature/: Narrative storytelling'));
    // Crucial: Domain SOP file names MUST NOT be flattened into the system prompt!
    assert.ok(!kalonPrompt.includes('flat-design.md'));
    assert.ok(!kalonPrompt.includes('morandi-palette.md'));
    assert.ok(!kalonPrompt.includes('material-design.md'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Hierarchical Skills: project-level skill overrides built-in skill with same name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-override-'));
  try {
    const customKalonDir = join(root, '.logox', 'skills', 'kalon', 'color');
    await mkdir(customKalonDir, {recursive: true});
    await writeFile(
      join(customKalonDir, 'morandi-palette.md'),
      '---\nname: morandi-palette\ndescription: Custom project Morandi palette\n---\n# Project Morandi Guidelines',
      'utf8',
    );

    const resources = new Resources(root, {home: root, boundary: root});
    const snapshot = await resources.reload();

    const morandi = snapshot.skills.find(s => s.name === 'morandi-palette')!;
    assert.ok(morandi);
    assert.equal(morandi.description, 'Custom project Morandi palette');
    assert.ok(morandi.path.includes(join('.logox', 'skills', 'kalon', 'color')));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Only unchanged shipped browser skills are refreshed during seeding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-skill-migration-'));
  try {
    const builtin = join(root, 'builtin'), user = join(root, 'home', 'skills');
    await mkdir(join(builtin, 'public'), {recursive: true});
    await mkdir(join(user, 'public'), {recursive: true});
    const original = await readFile(new URL('../../tests/fixtures/browser-screenshot-v1.md', import.meta.url), 'utf8');
    const replacement = '---\nname: browser-screenshot\ndescription: Playwright browser verification\n---\nUse the local Playwright MCP session.\n';
    const target = join(user, 'public', 'browser-screenshot.md');
    await writeFile(join(builtin, 'public', 'browser-screenshot.md'), replacement);
    await writeFile(target, original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    await ensureUserSkillsSeeded(user, builtin);
    assert.equal((await readFile(target, 'utf8')).replace(/\r\n/g, '\n'), replacement.replace(/\r\n/g, '\n'));
    await writeFile(target, original + '\nUser-specific workflow.\n');
    await ensureUserSkillsSeeded(user, builtin);
    assert.equal(await readFile(target, 'utf8'), original + '\nUser-specific workflow.\n');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('Hierarchical Skills: non-destructively seeds builtin skills to ~/.logox/skills on first run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-seed-'));
  try {
    const userSkillsDir = join(root, '.logox', 'skills');
    assert.equal(existsSync(userSkillsDir), false);

    const resources = new Resources(root, {home: root});
    await resources.reload();

    // Verify seeded into user directory
    assert.ok(existsSync(join(userSkillsDir, 'kalon', 'agent.md')));
    assert.ok(existsSync(join(userSkillsDir, 'kalon', 'design-principles.md')));
    assert.ok(existsSync(join(userSkillsDir, 'public', 'skill-internalization.md')));

    // Modify a seeded file in user directory to test non-destructive behavior
    const testFile = join(userSkillsDir, 'kalon', 'design-principles.md');
    await writeFile(testFile, '---\nname: design-principles\ndescription: User customized principles\n---\n# Custom', 'utf8');

    // Reload again
    await resources.reload();

    // Verify it was NOT overwritten
    const content = await readFile(testFile, 'utf8');
    assert.ok(content.includes('User customized principles'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
