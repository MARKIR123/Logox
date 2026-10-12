import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {AuthStorage} from '../src/providers/auth.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {LoginFlow} from '../src/providers/login.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';

const signal = () => new AbortController().signal;

test('持久认证保留其他提供商，跨实例并发不丢失，拒绝坏文件和无效输入', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-storage-'));
  const path = join(cwd, 'auth.json');
  const a = new AuthStorage(path), b = new AuthStorage(path);
  try {
    await Promise.all([a.save('deepseek', 'test-first', signal()), b.save('anthropic', 'test-second', signal())]);
    assert.equal(await new AuthStorage(path).key('deepseek'), 'test-first');
    assert.equal(await new AuthStorage(path).key('anthropic'), 'test-second');
    await a.save('deepseek', 'test-rotated', signal());
    assert.equal(await b.key('deepseek'), 'test-rotated');
    await assert.rejects(a.save('deepseek', 'bad\nkey', signal()), /有效/);
    assert.equal(await b.key('deepseek'), 'test-rotated');
    const controller = new AbortController();controller.abort();
    await assert.rejects(a.save('deepseek', 'not-saved', controller.signal));
    assert.equal(await b.key('deepseek'), 'test-rotated');
    await writeFile(path, 'broken private-fixture');
    await assert.rejects(a.save('deepseek', 'new-secret', signal()), error => error instanceof Error && /格式无效/.test(error.message) && !error.message.includes('private-fixture'));
    assert.equal(await readFile(path, 'utf8'), 'broken private-fixture');
    assert.deepEqual(await readdir(cwd), ['auth.json']);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('登录阶段不保存密钥，取消不落盘，保存失败可以重试', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-flow-'));
  const auth = new AuthStorage(join(cwd, 'auth.json'));
  const saved: string[] = [];
  const flow = new LoginFlow(auth, () => ['deepseek'], name => saved.push(name));
  const snapshots: string[] = [];
  const unsubscribe = flow.subscribe(() => snapshots.push(JSON.stringify(flow.getSnapshot())));
  try {
    await flow.begin();assert.equal(flow.getSnapshot()?.phase, 'provider');
    flow.choose('deepseek');flow.cancel();
    assert.equal(flow.getSnapshot(), null);assert.equal(await auth.key('deepseek'), '');
    await flow.begin('deepseek');
    await flow.submit('');assert.equal(flow.getSnapshot()?.phase, 'key');assert.match(flow.getSnapshot()!.error, /有效/);
    await flow.submit('synthetic-key');
    assert.equal(flow.getSnapshot(), null);assert.deepEqual(saved, ['deepseek']);
    assert.ok(!snapshots.join('').includes('synthetic-key'));
    await flow.begin();assert.equal(flow.getSnapshot()?.providers[0]?.saved, true);
  } finally {unsubscribe();await flow.close();await rm(cwd, {recursive: true, force: true});}
});

test('/login 保存后重建应用直接认证，密钥不进入舞台或会话', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-login-app-'));
  const authPath = join(cwd, 'user', 'auth.json');
  const authorization: string[] = [];
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization ?? '');
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.end('data: ' + JSON.stringify({choices: [{delta: {content: 'LOGOX_PROVIDER_READY'}, finish_reason: 'stop'}], usage: null}) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();assert.ok(address && typeof address === 'object');
  const config = await loadConfig(cwd, {provider: {name: 'test-cloud', model: 'test'}, providers: {'test-cloud': {base_url: 'http://127.0.0.1:' + address.port, api_key_env: 'LOGIN_TEST_KEY'}}}, {}, cwd, cwd);
  let app = await createApplication({cwd, authPath, config, sessionId: 'first'});
  try {
    await app.submit('/login test-cloud');
    assert.equal(app.authentication.getSnapshot()?.phase, 'key');
    await app.authentication.submit('synthetic-persistent-key');
    await app.submit('/check-provider');
    assert.ok(!JSON.stringify(app.store.getSnapshot()).includes('synthetic-persistent-key'));
    assert.deepEqual(await app.journal.load('first', 'logox'), []);
    await app.close();
    app = await createApplication({cwd, authPath, config, sessionId: 'second'});
    assert.equal(app.authentication.getSnapshot(), null);
    await app.submit('/check-provider');
    assert.deepEqual(authorization, ['Bearer synthetic-persistent-key', 'Bearer synthetic-persistent-key']);
    const registry = new ProviderRegistry(config, {LOGIN_TEST_KEY: 'stale-env'}, fetch, new AuthStorage(authPath));
    assert.equal((await registry.settings()).key, 'synthetic-persistent-key');
  } finally {await app.close();server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));await rm(cwd, {recursive: true, force: true});}
});
