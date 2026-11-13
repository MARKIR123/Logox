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

test('Provider lifecycle unregister of a template-based provider removes record and credential, the template stays', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-life-preset-'));
  try {
    const authStorage = new AuthStorage(join(tempDir, 'auth.json'));
    const customStorage = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    await authStorage.save('anthropic', 'sk-anthropic-test', new AbortController().signal);

    const config = await loadConfig(process.cwd(), {provider: {name: 'deepseek', model: 'fixture'}}, {});
    const registry = new ProviderRegistry(config, {}, fetch, authStorage, customStorage);
    await registry.syncCustom();

    assert.ok(registry.names().includes('anthropic'), 'a template with a credential is a provider (reconciled record)');
    await registry.unregister('anthropic');
    assert.equal(await authStorage.key('anthropic'), '');
    assert.equal(await customStorage.get('anthropic'), undefined);
    assert.ok(!registry.names().includes('anthropic'), 'removed provider is no longer listed');
    assert.ok(registry.templateNames().includes('anthropic'), 'the template remains available to add again');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
