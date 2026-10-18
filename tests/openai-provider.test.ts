import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderRegistry} from '../src/providers/registry.js';
import {loadConfig} from '../src/config/config.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {AuthStorage} from '../src/providers/auth.js';

test('ProviderRegistry includes openai in presets and identifies reasoning models', async () => {
  const config = await loadConfig(process.cwd(), {}, {});
  const registry = new ProviderRegistry(config, process.env);
  assert.ok(registry.names().includes('openai'), 'presets should contain openai');

  const settings = await registry.candidate('openai', 'o1').settings(false);
  assert.equal(settings.baseUrl, 'https://api.openai.com/v1');
  assert.equal(settings.kind, 'openai_compat');
  assert.equal(settings.thinkingProtocol, 'reasoning-effort');
});

test('ProviderRegistry merges custom providers from CustomProviderStorage', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-reg-test-'));
  try {
    const customStorage = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    const authStorage = new AuthStorage(join(tempDir, 'auth.json'));
    await customStorage.save({name: 'my-vllm', base_url: 'http://127.0.0.1:8000/v1', kind: 'openai_compat'});

    const config = await loadConfig(process.cwd(), {}, {});
    const registry = new ProviderRegistry(config, process.env, fetch, authStorage, customStorage);
    await registry.syncCustom();

    assert.ok(registry.names().includes('my-vllm'), 'custom provider should appear in names()');
    const settings = await registry.candidate('my-vllm', 'llama3').settings(false);
    assert.equal(settings.baseUrl, 'http://127.0.0.1:8000/v1');
    assert.equal(settings.kind, 'openai_compat');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
