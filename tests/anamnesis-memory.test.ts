import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStore, type MemoryRecord} from '../src/anamnesis/memory.js';

test('MemoryStore parses and saves Markdown memory with YAML frontmatter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-memory-'));
  const projectDir = join(dir, 'project');
  const userDir = join(dir, 'user');

  try {
    const store = new MemoryStore(projectDir, userDir);

    // Save a project memory
    await store.save({
      name: 'tech-stack-node24',
      description: 'Project uses Node 24 and React/Ink',
      type: 'project',
      content: 'This repository runs on Node.js 24 and Ink 5.',
    }, 'project');

    // Verify file on disk
    const filePath = join(projectDir, '.logox', 'memory', 'tech-stack-node24.md');
    const raw = await readFile(filePath, 'utf8');
    assert.ok(raw.includes('name: tech-stack-node24'));
    assert.ok(raw.includes('description: Project uses Node 24 and React/Ink'));
    assert.ok(raw.includes('type: project'));
    assert.ok(raw.includes('This repository runs on Node.js 24 and Ink 5.'));

    // Verify MEMORY.md index
    const indexPath = join(projectDir, '.logox', 'memory', 'MEMORY.md');
    const indexRaw = await readFile(indexPath, 'utf8');
    assert.ok(indexRaw.includes('- [tech-stack-node24](tech-stack-node24.md) — Project uses Node 24 and React/Ink'));

    // Save a user memory (preference)
    await store.save({
      name: 'concise-replies',
      description: 'User prefers concise direct technical answers',
      type: 'user',
      content: 'Keep conversational replies concise without excessive greetings.',
    }, 'user');

    // List all memories (merges project and user scopes)
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.ok(list.some(m => m.name === 'tech-stack-node24' && m.scope === 'project'));
    assert.ok(list.some(m => m.name === 'concise-replies' && m.scope === 'user'));

    // Format prompt block
    const promptBlock = await store.formatPromptBlock();
    assert.ok(promptBlock.includes('<project-memory>'));
    assert.ok(promptBlock.includes('tech-stack-node24'));
    assert.ok(promptBlock.includes('concise-replies'));
    assert.ok(promptBlock.includes('</project-memory>'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('MemoryStore deletes memory and updates MEMORY.md index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-memory-del-'));
  const projectDir = join(dir, 'project');
  const userDir = join(dir, 'user');

  try {
    const store = new MemoryStore(projectDir, userDir);
    await store.save({
      name: 'temp-fact',
      description: 'Temporary fact',
      type: 'project',
      content: 'Temporary content',
    }, 'project');

    let list = await store.list();
    assert.equal(list.length, 1);

    const deleted = await store.delete('temp-fact', 'project');
    assert.equal(deleted, true);

    list = await store.list();
    assert.equal(list.length, 0);

    const indexPath = join(projectDir, '.logox', 'memory', 'MEMORY.md');
    const indexRaw = await readFile(indexPath, 'utf8');
    assert.ok(!indexRaw.includes('temp-fact'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
