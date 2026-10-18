import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelPool} from '../src/providers/model-pool.js';

test('ModelPool resolves unique shorthand and handles ambiguous model names', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-pool-test-'));
  try {
    const pool = new ModelPool(undefined, join(tempDir, 'models-cache.json'));
    pool.setMockModels([
      {provider: 'antigravity', id: 'gemini-3.8-flash', window: 1000000},
      {provider: 'antigravity', id: 'claude-sonnet-4-6', window: 1000000},
      {provider: 'anthropic', id: 'claude-sonnet-4-6', window: 200000},
      {provider: 'openai', id: 'gpt-4o', window: 128000},
    ]);

    // 1. Direct qualified format
    assert.deepEqual(pool.resolveShorthand('antigravity/claude-sonnet-4-6', 'anthropic'), {
      provider: 'antigravity',
      model: 'claude-sonnet-4-6',
    });

    // 2. Unique shorthand
    assert.deepEqual(pool.resolveShorthand('gemini-3.8-flash', 'openai'), {
      provider: 'antigravity',
      model: 'gemini-3.8-flash',
    });
    assert.deepEqual(pool.resolveShorthand('gpt-4o', 'antigravity'), {
      provider: 'openai',
      model: 'gpt-4o',
    });

    // 3. Ambiguous shorthand matching activeProvider
    assert.deepEqual(pool.resolveShorthand('claude-sonnet-4-6', 'antigravity'), {
      provider: 'antigravity',
      model: 'claude-sonnet-4-6',
    });
    assert.deepEqual(pool.resolveShorthand('claude-sonnet-4-6', 'anthropic'), {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });

    // 4. Ambiguous shorthand without activeProvider match -> Error
    assert.throws(
      () => pool.resolveShorthand('claude-sonnet-4-6', 'deepseek'),
      /Ambiguous model 'claude-sonnet-4-6'/
    );
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('ModelPool caches discovered models to disk and reads cache on startup', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-cache-test-'));
  const cachePath = join(tempDir, 'models-cache.json');
  try {
    const pool1 = new ModelPool(undefined, cachePath);
    pool1.setMockModels([
      {provider: 'antigravity', id: 'gemini-3.8-flash', window: 1000000},
      {provider: 'openai', id: 'gpt-4o', window: 128000},
    ]);
    await pool1.saveCache();

    const pool2 = new ModelPool(undefined, cachePath);
    const cached = await pool2.loadCache();
    assert.equal(cached.length, 2);
    assert.equal(cached[0]?.id, 'gemini-3.8-flash');
    assert.equal(cached[1]?.id, 'gpt-4o');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
