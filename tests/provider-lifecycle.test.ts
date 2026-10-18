import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderRegistry} from '../src/providers/registry.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {AuthStorage} from '../src/providers/auth.js';
import {loadConfig} from '../src/config/config.js';

test('Provider lifecycle unregister removes custom provider entry and credentials', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-life-test-'));
  try {
    const customStorage = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    const authStorage = new AuthStorage(join(tempDir, 'auth.json'));
    await customStorage.save({name: 'my-vllm', base_url: 'http://127.0.0.1:8000/v1', kind: 'openai_compat'});
    await authStorage.save('my-vllm', 'token-123', new AbortController().signal);

    const config = await loadConfig(process.cwd(), {}, {});
    const registry = new ProviderRegistry(config, process.env, fetch, authStorage, customStorage);
    await registry.syncCustom();

    assert.ok(registry.names().includes('my-vllm'));
    assert.equal(await authStorage.key('my-vllm'), 'token-123');

    await registry.unregister('my-vllm');
    assert.equal(await customStorage.get('my-vllm'), undefined);
    assert.equal(await authStorage.key('my-vllm'), '');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('Provider lifecycle unregister preset clears credentials while keeping preset definition', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-life-preset-'));
  try {
    const authStorage = new AuthStorage(join(tempDir, 'auth.json'));
    await authStorage.save('deepseek', 'sk-deepseek-test', new AbortController().signal);

    const config = await loadConfig(process.cwd(), {}, {});
    const registry = new ProviderRegistry(config, process.env, fetch, authStorage);

    assert.equal(await authStorage.key('deepseek'), 'sk-deepseek-test');
    await registry.unregister('deepseek');
    assert.equal(await authStorage.key('deepseek'), '');
    assert.ok(registry.names().includes('deepseek'), 'preset still remains in names()');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
