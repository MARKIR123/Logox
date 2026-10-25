import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {MemoryStore} from '../src/anamnesis/memory.js';
import {executeRecap, executeAutoDream} from '../src/anamnesis/runner.js';
import type {ModelMessage} from '../src/runtime/messages.js';

test('executeRecap generates 3-part recap from journals and git status without throwing on non-git dir', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-recap-test-'));
  const journal = new Journal(join(cwd, 'sessions'));
  const controller = new AbortController();

  try {
    // Append simulated journal entries
    await journal.append({
      version: 1,
      sessionId: 'session-recap',
      ownerId: 'techne',
      role: 'user',
      text: 'Implement memory storage engine',
    });
    await journal.append({
      version: 1,
      sessionId: 'session-recap',
      ownerId: 'techne',
      role: 'assistant',
      text: 'Created src/anamnesis/memory.ts and verified tests pass.',
    });

    const mockProvider = {
      async respond(params: {system: string; messages: readonly ModelMessage[]}) {
        return {
          message: {
            role: 'assistant' as const,
            text: `### What Was Done\nImplemented memory storage engine with YAML frontmatter.\n\n### Working Tree State\nClean working tree.\n\n### Recommended Next Step\nProceed to Task 2 runner implementation.`,
          },
          stop: 'complete' as const,
        };
      },
    };

    const recap = await executeRecap({
      cwd,
      sessionId: 'session-recap',
      journal,
      provider: mockProvider,
    }, controller.signal);

    assert.ok(recap.whatWasDone.includes('Implemented memory storage'));
    assert.ok(recap.workingTreeState.includes('Clean'));
    assert.ok(recap.recommendedNextStep.includes('Task 2'));
    assert.ok(recap.oneLineSummary.length > 0);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('executeAutoDream extracts high-confidence facts and persists to MemoryStore', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-dream-test-'));
  const journal = new Journal(join(cwd, 'sessions'));
  const memoryStore = new MemoryStore(cwd, cwd);
  const controller = new AbortController();

  try {
    await journal.append({
      version: 1,
      sessionId: 'session-dream',
      ownerId: 'logox',
      role: 'user',
      text: 'Remember to always keep terminal status notices strictly in English.',
    });
    await journal.append({
      version: 1,
      sessionId: 'session-dream',
      ownerId: 'logox',
      role: 'assistant',
      text: 'Confirmed. I will keep all internal prompts and notices in English.',
    });

    const mockProvider = {
      async respond() {
        return {
          message: {
            role: 'assistant' as const,
            text: JSON.stringify([
              {
                name: 'english-system-notices',
                description: 'All system notices and internal prompts must be in English',
                type: 'feedback',
                content: 'System notices and internal diagnostics must be strictly English.',
              },
            ]),
          },
          stop: 'complete' as const,
        };
      },
    };

    const result = await executeAutoDream({
      cwd,
      sessionId: 'session-dream',
      journal,
      memoryStore,
      provider: mockProvider,
    }, controller.signal);

    assert.equal(result.consolidated, 1);
    const memories = await memoryStore.list();
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.name, 'english-system-notices');
    assert.equal(memories[0]!.type, 'feedback');
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});
