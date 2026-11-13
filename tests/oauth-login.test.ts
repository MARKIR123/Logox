import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LoginFlow} from '../src/providers/login.js';
import {AuthStorage} from '../src/providers/auth.js';

test('LoginFlow.browserLogin saves the account token under the provider and closes', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-login-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const saved: string[] = [];
    const flow = new LoginFlow(auth, name => {saved.push(name);}, fetch,
      async () => ({authUrl: 'https://example.invalid/auth', waitForToken: async () => ({access_token: 'fixture-token'}), cancel: () => {}}));
    assert.equal(await flow.browserLogin('openai-auth'), 'done');
    assert.deepEqual(saved, ['openai-auth']);
    assert.equal((await auth.credential('openai-auth'))?.type, 'oauth');
    assert.equal(await auth.credential('openai'), undefined);
    assert.equal(flow.getSnapshot(), null);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('LoginFlow.browserLogin reports a failed authorization and leaves nothing saved', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-login-fail-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const errors: string[] = [];
    const flow = new LoginFlow(auth, () => {}, fetch, async () => {throw new Error('authorization refused');});
    flow.subscribe(() => {const error = flow.getSnapshot()?.error; if (error) errors.push(error);});
    assert.equal(await flow.browserLogin('openai-auth'), 'cancelled');
    assert.ok(errors.some(error => /authorization refused/.test(error)));
    assert.equal(flow.getSnapshot(), null);
    assert.deepEqual(await auth.providers(), []);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
