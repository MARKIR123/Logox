import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadConfig, modelSettings} from '../src/config/config.js';

test('tool disclosure configuration uses model over selected provider over named provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-disclosure-config-'));
  try {
    const config = await loadConfig(root, {provider: {name: 'local', model: 'fixture', tool_discovery: 'none'},
      providers: {local: {kind: 'anthropic', base_url: 'http://127.0.0.1:9999/v1', tool_discovery: 'anthropic'}},
      models: {'local/fixture': {tool_discovery: 'anthropic'}}}, {}, root, root);
    assert.equal(modelSettings(config, {}).toolDiscovery, 'anthropic');
    delete config.models['local/fixture'];
    assert.equal(modelSettings(config, {}).toolDiscovery, 'none');
    delete config.provider.tool_discovery;
    assert.equal(modelSettings(config, {}).toolDiscovery, 'anthropic');
    config.provider.kind = 'openai_compat';
    assert.throws(() => modelSettings(config, {}), /Anthropic.*protocol/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('配置按用户、祖先项目、当前项目、环境和命令覆盖，凭据仅在环境读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-config-'));
  const home = join(root, 'home'), project = join(root, 'project'), child = join(project, 'child');
  try {
    for (const directory of [home, project, child]) await mkdir(join(directory, '.logox'), {recursive: true});
    await writeFile(join(home, '.logox', 'config.toml'), '[provider]\nname="custom"\nmodel="home"\n[providers.custom]\nbase_url="http://127.0.0.1:9999/v1"\napi_key_env="TEST_KEY"\n');
    await writeFile(join(project, '.logox', 'config.toml'), '[provider]\nmodel="project"\n[kernel]\nmax_iterations=8\n');
    await writeFile(join(child, '.logox', 'config.toml'), '[provider]\nmodel="child"\n');
    const config = await loadConfig(child, {provider: {model: 'cli'}}, {LOGOX__PROVIDER__MODEL: 'env', TEST_KEY: 'private'}, home, root);
    assert.equal(config.provider.model, 'cli');
    assert.equal(config.provider.name, 'custom');
    assert.equal(config.providers.custom?.api_key_env, 'TEST_KEY');
    assert.equal(config.kernel.max_iterations, 8);
    assert.equal(modelSettings(config, {TEST_KEY: 'private'}).key, 'private');
    assert.ok(!JSON.stringify(config).includes('private'));
    const numeric = await loadConfig(child, {}, {LOGOX__PROVIDER__MODEL: '123'}, home, root);
    assert.equal(numeric.provider.model, '123');
  } finally {await rm(root, {recursive: true, force: true});}
});
test('配置拒绝明文 api_key、危险键、无效 TOML 和带凭据的地址', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-config-'));
  try {
    await mkdir(join(root, '.logox'));
    await writeFile(join(root, '.logox', 'config.toml'), '[provider]\napi_key="secret"');
    await assert.rejects(loadConfig(root, {}, {}, root, root), /api_key_env/);
    await writeFile(join(root, '.logox', 'config.toml'), 'broken=[');
    await assert.rejects(loadConfig(root, {}, {}, root, root), /配置无效/);
    await writeFile(join(root, '.logox', 'config.toml'), '');
    await assert.rejects(loadConfig(root, {}, {LOGOX__PROVIDER__CONSTRUCTOR: 'bad'}, root, root), /键无效/);
    const config = await loadConfig(root, {provider: {base_url: 'https://user:secret@example.com/v1'}}, {}, root, root);
    assert.throws(() => modelSettings(config), /无凭据/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('跨层或 CLI 改换提供商时清除旧接口字段，保留通用请求选项', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-config-switch-'));
  try {
    await mkdir(join(cwd, '.logox'));
    await writeFile(join(cwd, '.logox', 'config.toml'), '[provider]\nname="ollama"\nmodel="local"\nbase_url="http://127.0.0.1:9999/v1"\nauth_file="local-auth.json"\napi_key_env="LOCAL_KEY"\ntimeout=240\n');
    const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'cloud'}}, {}, cwd, cwd);
    assert.equal(config.provider.base_url, undefined);
    assert.equal(config.provider.auth_file, undefined);
    assert.equal(config.provider.api_key_env, undefined);
    assert.equal(config.provider.timeout, 240);
    assert.equal(modelSettings(config).baseUrl, 'https://api.deepseek.com');
    assert.equal(modelSettings(config).model, 'cloud');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('同一环境层中的模型、地址和提供商不受变量枚举顺序影响', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-config-env-'));
  try {
    await mkdir(join(cwd, '.logox'));
    await writeFile(join(cwd, '.logox', 'config.toml'), '[provider]\nname="ollama"\nmodel="old"');
    const config = await loadConfig(cwd, {}, {LOGOX__PROVIDER__MODEL: 'new', LOGOX__PROVIDER__BASE_URL: 'https://example.com/v1', LOGOX__PROVIDER__NAME: 'work'}, cwd, cwd);
    assert.deepEqual([config.provider.name, config.provider.model, config.provider.base_url], ['work', 'new', 'https://example.com/v1']);
  } finally {await rm(cwd, {recursive: true, force: true});}
});
