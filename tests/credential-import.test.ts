import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuthStorage} from '../src/providers/auth.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {LoginFlow} from '../src/providers/login.js';
import {discoverImportable} from '../src/providers/credential-import.js';

async function roots() {
  const base = await mkdtemp(join(tmpdir(), 'logox-import-'));
  const codexHome = join(base, 'codex'), dshHome = join(base, 'dsh');
  await mkdir(codexHome, {recursive: true});
  await mkdir(dshHome, {recursive: true});
  return {base, codexHome, dshHome};
}

test('discoverImportable：读取 Codex 的 ChatGPT 令牌与 API key，且不把密文放进可展示字段', async () => {
  const {base, codexHome, dshHome} = await roots();
  try {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'sk-codex-fixture',
      tokens: {access_token: 'token-codex-fixture', account_id: 'acct-42'},
    }));
    const found = await discoverImportable({codexHome, dshHome});
    assert.deepEqual(found.map(item => item.id), ['codex:oauth', 'codex:api_key']);
    const oauth = found[0]!;
    assert.equal(oauth.provider, 'openai');
    assert.equal(oauth.kind, 'oauth');
    assert.equal(oauth.secret, 'token-codex-fixture');
    assert.equal(oauth.accountId, 'acct-42');
    assert.equal(found[1]!.kind, 'api_key');
    assert.equal(found[1]!.secret, 'sk-codex-fixture');
    for (const item of found) {
      assert.ok(!item.label.includes(item.secret), 'label 不得包含密文');
      assert.ok(!item.id.includes(item.secret), 'id 不得包含密文');
    }
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});

test('discoverImportable：读取 dsh 凭据库的 refs，并按变量名映射提供商', async () => {
  const {base, codexHome, dshHome} = await roots();
  try {
    await writeFile(join(dshHome, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  DEEPSEEK_API_KEY: sk-deepseek-fixture',
      '  ANTHROPIC_API_KEY: sk-anthropic-fixture',
      '  GROK_API_KEY: xai-fixture',
      '  UNRELATED_VALUE: nope',
      'records:',
      '  deepseek-account-platform/default:',
      '    kind: grant',
    ].join('\n'));
    const found = await discoverImportable({codexHome, dshHome});
    assert.deepEqual(found.map(item => [item.id, item.provider, item.kind]), [
      ['dsh:DEEPSEEK_API_KEY', 'deepseek', 'api_key'],
      ['dsh:ANTHROPIC_API_KEY', 'anthropic', 'api_key'],
      ['dsh:GROK_API_KEY', 'xai', 'api_key'],
    ]);
    assert.equal(found[0]!.label, 'dsh credentials · DEEPSEEK_API_KEY');
    assert.ok(!JSON.stringify(found.map(item => item.label)).includes('fixture'));
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});

test('discoverImportable：缺失或损坏的文件只表示没有可导入项', async () => {
  const {base, codexHome, dshHome} = await roots();
  try {
    assert.deepEqual(await discoverImportable({codexHome, dshHome}), []);
    await writeFile(join(codexHome, 'auth.json'), '{broken');
    await writeFile(join(dshHome, '.credentials.yaml'), 'refs: [not, a, mapping]');
    assert.deepEqual(await discoverImportable({codexHome, dshHome}), []);
    await writeFile(join(dshHome, '.credentials.yaml'), 'version: 1');
    assert.deepEqual(await discoverImportable({codexHome, dshHome}), []);
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});

test('LoginFlow：+ Import 只在有可导入项时出现，导入后写入本仓凭据且快照不含密文', async () => {
  const {base} = await roots();
  try {
    const auth = new AuthStorage(join(base, 'auth.json'));
    const custom = new CustomProviderStorage(join(base, 'custom-providers.json'));
    const secret = 'sk-imported-fixture';
    const saved: string[] = [];
    const flow = new LoginFlow(auth, () => ['openai'], name => saved.push(name), custom, fetch,
      undefined, async () => [{id: 'codex:api_key', label: 'Codex · OPENAI_API_KEY', provider: 'openai', kind: 'api_key', secret}]);

    await flow.begin();
    const rows = flow.getSnapshot()!.providers.map(row => row.name);
    assert.deepEqual(rows, ['openai', '+ Add', '+ Import']);

    flow.choose('+ Import');
    const importing = flow.getSnapshot()!;
    assert.equal(importing.phase, 'import');
    assert.deepEqual(importing.importables, [{id: 'codex:api_key', label: 'Codex · OPENAI_API_KEY', provider: 'openai', kind: 'api_key'}]);
    assert.ok(!JSON.stringify(importing).includes(secret), '导入阶段快照不得包含密文');

    await flow.chooseImport('codex:api_key');
    assert.equal(flow.getSnapshot(), null);
    assert.equal(await auth.key('openai'), secret);
    assert.deepEqual(saved, ['openai']);
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});

test('LoginFlow：没有可导入项时不出现 + Import，OAuth 令牌按 oauth 存储', async () => {
  const {base} = await roots();
  try {
    const auth = new AuthStorage(join(base, 'auth.json'));
    const empty = new LoginFlow(auth, () => ['openai'], () => {}, new CustomProviderStorage(join(base, 'custom.json')), fetch, undefined, async () => []);
    await empty.begin();
    assert.ok(!empty.getSnapshot()!.providers.some(row => row.name === '+ Import'));
    await empty.close();

    const oauthFlow = new LoginFlow(auth, () => ['openai'], () => {}, new CustomProviderStorage(join(base, 'custom.json')), fetch, undefined,
      async () => [{id: 'codex:oauth', label: 'Codex · ChatGPT account', provider: 'openai', kind: 'oauth', secret: 'token-fixture', accountId: 'acct-9'}]);
    await oauthFlow.begin();
    oauthFlow.choose('+ Import');
    await oauthFlow.chooseImport('codex:oauth');
    const credential = await auth.credential('openai');
    assert.equal(credential?.type, 'oauth');
    assert.equal(credential?.type === 'oauth' ? credential.access_token : '', 'token-fixture');
    assert.equal(credential?.type === 'oauth' ? credential.account_id : '', 'acct-9');
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});
