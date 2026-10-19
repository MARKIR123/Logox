import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Resources} from '../src/resources/manager.js';

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

    // Check visibility filtering
    const kalonSkills = resources.skillsFor({actorId: 'kalon'}).map(s => s.name);
    assert.ok(kalonSkills.includes('morandi-palette'));
    assert.ok(kalonSkills.includes('browser-screenshot')); // public is visible to all
    assert.ok(!kalonSkills.includes('tdd-workflow')); // Techne-only skill not visible without borrowing

    // Borrowing allows cross-actor access
    const borrowed = resources.skillsFor({actorId: 'kalon', borrowed: ['tdd-workflow']}).map(s => s.name);
    assert.ok(borrowed.includes('tdd-workflow'));
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
