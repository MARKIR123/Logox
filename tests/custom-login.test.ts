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

test('LoginFlow guides user through the + Add URL wizard', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-custom-flow-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const custom = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    let saved = '';
    const flow = new LoginFlow(auth, () => ['openai', 'deepseek'], p => {saved = p;}, custom);

    await flow.begin();
    const snapshot1 = flow.getSnapshot();
    assert.ok(snapshot1?.providers.some(p => p.name === '+ Add'));

    // 1. Choose + Add, then the URL path
    flow.choose('+ Add');
    assert.equal(flow.getSnapshot()?.phase, 'add');
    flow.chooseAddMode('url');
    assert.equal(flow.getSnapshot()?.phase, 'custom_name');

    // 2. Submit Name
    flow.submitCustomName('my-antigravity');
    assert.equal(flow.getSnapshot()?.phase, 'custom_url');

    // 3. Submit Port
    flow.submitCustomUrl('8045');
    assert.equal(flow.getSnapshot()?.phase, 'custom_kind');

    // 4. Choose wire protocol
    flow.chooseCustomKind('anthropic');
    assert.equal(flow.getSnapshot()?.phase, 'custom_key');

    // 5. Submit empty key (unauthenticated local reverse proxy)
    await flow.submitCustomKey('');
    assert.equal(saved, 'my-antigravity');
    assert.equal(flow.getSnapshot(), null);

    const record = await custom.get('my-antigravity');
    assert.equal(record?.name, 'my-antigravity');
    assert.equal(record?.base_url, 'http://127.0.0.1:8045/v1');
    assert.equal(record?.kind, 'anthropic');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('LoginFlow annotates custom providers and deletes record plus credential', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-custom-delete-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const custom = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    await custom.save({name: 'local-proxy', base_url: 'http://127.0.0.1:9000/v1', kind: 'openai_compat'});
    await auth.save('local-proxy', 'local-key', new AbortController().signal);
    const removed: string[] = [];
    const flow = new LoginFlow(auth, () => ['openai', 'local-proxy'], () => {}, custom, fetch, async name => {
      removed.push(name);
      await custom.remove(name);
      await auth.remove(name);
    }, async () => []);

    await flow.begin();
    const snapshot = flow.getSnapshot();
    const row = snapshot?.providers.find(provider => provider.name === 'local-proxy');
    assert.equal(row?.custom, true);
    assert.equal(row?.deletable, true);
    assert.equal(row?.baseUrl, 'http://127.0.0.1:9000/v1');
    assert.equal(row?.kind, 'openai_compat');
    assert.equal(row?.saved, true);
    assert.equal(snapshot?.providers.at(-1)?.name, '+ Add', '新增入口始终排在最后');

    // 预设供应商不可删除：请求被忽略。
    await flow.delete('openai');
    assert.deepEqual(removed, []);

    await flow.delete('local-proxy');
    assert.deepEqual(removed, ['local-proxy']);
    assert.ok(!flow.getSnapshot()!.providers.some(provider => provider.name === 'local-proxy'));
    assert.equal(await custom.get('local-proxy'), undefined);
    assert.equal(await auth.key('local-proxy'), '');
    assert.deepEqual(await auth.providers(), []);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('LoginFlow edits a custom provider in place and keeps the saved key when the field is blank', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-custom-edit-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const custom = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    await custom.save({name: 'local-proxy', base_url: 'http://127.0.0.1:9000/v1', kind: 'openai_compat'});
    await auth.save('local-proxy', 'old-key', new AbortController().signal);
    const flow = new LoginFlow(auth, () => ['local-proxy'], () => {}, custom, fetch, undefined, async () => []);

    await flow.begin();
    flow.choose('local-proxy');
    const editing = flow.getSnapshot()!;
    assert.equal(editing.phase, 'custom_url');
    assert.equal(editing.editing, true);
    assert.equal(editing.customUrl, 'http://127.0.0.1:9000/v1', '地址以当前值预填');
    assert.equal(editing.customKind, 'openai_compat', '协议沿用当前值');

    flow.submit('http://127.0.0.1:9100/v1');
    assert.equal(flow.getSnapshot()?.phase, 'custom_kind');
    flow.chooseCustomKind('anthropic');
    assert.equal(flow.getSnapshot()?.phase, 'custom_key');
    await flow.submitCustomKey('');

    const updated = await custom.get('local-proxy');
    assert.equal(updated?.base_url, 'http://127.0.0.1:9100/v1');
    assert.equal(updated?.kind, 'anthropic');
    assert.equal(await auth.key('local-proxy'), 'old-key', '留空不覆盖已保存的 key');
    assert.equal(flow.getSnapshot(), null);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

test('LoginFlow account add routes to the authorization method picker', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-custom-account-test-'));
  try {
    const auth = new AuthStorage(join(tempDir, 'auth.json'));
    const flow = new LoginFlow(auth, () => ['openai', 'deepseek'], () => {}, new CustomProviderStorage(join(tempDir, 'custom.json')), fetch,
      undefined, async () => []);

    await flow.begin();
    flow.choose('+ Add');
    flow.chooseAddMode('account');
    assert.equal(flow.getSnapshot()?.phase, 'account');
    assert.deepEqual(flow.getSnapshot()?.providers.map(row => row.name), ['openai', 'deepseek', '+ Add']);

    flow.chooseAccount('deepseek');
    assert.equal(flow.getSnapshot()?.phase, 'account', '未登记的账号入口被忽略');
    flow.chooseAccount('openai');
    assert.equal(flow.getSnapshot()?.phase, 'method');
    assert.deepEqual(flow.getSnapshot()?.methods?.map(method => method.id), ['key', 'oauth']);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});
