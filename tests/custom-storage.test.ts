import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {AuthStorage} from '../src/providers/auth.js';

test('CustomProviderStorage saves, retrieves, and deletes custom providers in isolated JSON', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-storage-test-'));
  try {
    const storage = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    assert.deepEqual(await storage.list(), []);

    await storage.save({name: 'antigravity', base_url: 'http://127.0.0.1:8045/v1', kind: 'openai_compat'});
    const providers = await storage.list();
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.name, 'antigravity');
    assert.equal(providers[0]?.base_url, 'http://127.0.0.1:8045/v1');

    const single = await storage.get('antigravity');
    assert.equal(single?.name, 'antigravity');

    await storage.remove('antigravity');
    assert.deepEqual(await storage.list(), []);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('AuthStorage supports OAuth credentials alongside API keys', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-auth-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    await auth.saveOAuth('openai', {access_token: 'test-oauth-token', refresh_token: 'refresh-token', expires_at: Date.now() + 3600000}, new AbortController().signal);
    const cred = await auth.credential('openai');
    assert.equal(cred?.type, 'oauth');
    if (cred?.type === 'oauth') {
      assert.equal(cred.access_token, 'test-oauth-token');
      assert.equal(await auth.key('openai'), 'test-oauth-token');
    }

    await auth.save('deepseek', 'sk-deepseek-123', new AbortController().signal);
    const keyCred = await auth.credential('deepseek');
    assert.equal(keyCred?.type, 'api_key');
    assert.equal(await auth.key('deepseek'), 'sk-deepseek-123');

    await auth.remove('openai', new AbortController().signal);
    assert.equal(await auth.credential('openai'), undefined);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
