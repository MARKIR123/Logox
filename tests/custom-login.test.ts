import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expandPortOrUrl, LoginFlow} from '../src/providers/login.js';
import {AuthStorage} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';

test('expandPortOrUrl expands numeric ports to localhost endpoints and validates URLs', () => {
  assert.equal(expandPortOrUrl('8045'), 'http://127.0.0.1:8045/v1');
  assert.equal(expandPortOrUrl(' 8000 '), 'http://127.0.0.1:8000/v1');
  assert.equal(expandPortOrUrl('http://192.168.1.100:8000/v1'), 'http://192.168.1.100:8000/v1');
  assert.equal(expandPortOrUrl('https://api.my-domain.com/v1'), 'https://api.my-domain.com/v1');
  assert.throws(() => expandPortOrUrl('not-a-valid-url'), /Invalid/);
});

test('LoginFlow guides user through + Custom provider registration wizard', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-custom-flow-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const custom = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    let saved = '';
    const flow = new LoginFlow(auth, () => ['openai', 'deepseek'], p => {saved = p;}, custom);

    await flow.begin();
    const snapshot1 = flow.getSnapshot();
    assert.ok(snapshot1?.providers.some(p => p.name === '+ Custom'));

    // 1. Choose + Custom
    flow.choose('+ Custom');
    assert.equal(flow.getSnapshot()?.phase, 'custom_name');

    // 2. Submit Name
    flow.submitCustomName('my-antigravity');
    assert.equal(flow.getSnapshot()?.phase, 'custom_url');

    // 3. Submit Port
    flow.submitCustomUrl('8045');
    assert.equal(flow.getSnapshot()?.phase, 'custom_key');

    // 4. Submit empty key (unauthenticated local reverse proxy)
    await flow.submitCustomKey('');
    assert.equal(saved, 'my-antigravity');
    assert.equal(flow.getSnapshot(), null);

    const record = await custom.get('my-antigravity');
    assert.equal(record?.name, 'my-antigravity');
    assert.equal(record?.base_url, 'http://127.0.0.1:8045/v1');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
