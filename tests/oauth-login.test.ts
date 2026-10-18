import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LoginFlow} from '../src/providers/login.js';
import {AuthStorage} from '../src/providers/auth.js';

test('LoginFlow OpenAI dual-auth branches to method selection', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-login-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    let savedProvider = '';
    const flow = new LoginFlow(auth, () => ['openai', 'deepseek'], p => {savedProvider = p;});

    // 1. Starting login with openai enters method phase
    await flow.begin('openai');
    const snapshot1 = flow.getSnapshot();
    assert.equal(snapshot1?.phase, 'method');
    assert.equal(snapshot1?.provider, 'openai');

    // 2. Selecting API Key transitions to key phase
    flow.chooseMethod('key');
    const snapshot2 = flow.getSnapshot();
    assert.equal(snapshot2?.phase, 'key');

    // 3. Submitting API key saves and finishes
    await flow.submit('sk-openai-key-test');
    assert.equal(savedProvider, 'openai');
    assert.equal(await auth.key('openai'), 'sk-openai-key-test');
    assert.equal(flow.getSnapshot(), null);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('LoginFlow non-openai provider transitions directly to key phase', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-login-non-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const flow = new LoginFlow(auth, () => ['deepseek'], () => {});

    await flow.begin('deepseek');
    const snapshot = flow.getSnapshot();
    assert.equal(snapshot?.phase, 'key');
    assert.equal(snapshot?.provider, 'deepseek');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
