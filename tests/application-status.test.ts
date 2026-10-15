import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {builtinActors} from '../src/actors/builtins.js';
import {serializeActor} from '../src/actors/definitions.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {ProviderError} from '../src/providers/http.js';
import {waitForSnapshot} from './runtime-fixture.js';

test('Actor 状态显示当前实际任务模型；后续排队不遮住运行任务，空闲读取默认模型', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-live-status-'));
  await mkdir(join(cwd, '.logox', 'actors'), {recursive: true});
  const role = {...builtinActors[1]!, id: 'scout', name: '侦察者', defaultModel: {provider: 'local', model: 'special'}};
  await writeFile(join(cwd, '.logox', 'actors', 'scout.md'), serializeActor(role));
  const config = await loadConfig(cwd, {provider: {name: 'local', model: 'main'}, providers: {local: {base_url: 'http://127.0.0.1:7777/v1'}},
    models: {'local/main': {context_window: 131072, thinking_protocol: 'deepseek'}, 'local/special': {context_window: 131072}}}, {}, cwd, cwd);
  let calls = 0;
  const app = await createApplication({cwd, config, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd},
    provider: {async respond(_request, _delta, signal) {
      if (++calls === 1) throw new ProviderError('合成模型不可用', false, 'model_missing');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
      throw new Error('不应继续');
    }}});
  try {
    assert.equal(app.status('scout').model?.model, 'special');
    assert.equal(app.status('logox').model?.model, 'main');
    await app.submit('/effort high');
    await app.submit('@scout 核查');
    await waitForSnapshot(app.store, snapshot => snapshot.interactions.some(request => request.status === 'pending'));
    const request = app.store.interactions.list().find(item => item.status === 'pending')!;
    app.store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {task_model: {type: 'option', optionId: 'switch'}}}));
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.taskModel?.actual.model === 'main' && activity.taskModel.phase === 'ready'));
    await app.submit('@scout 排队核查');
    assert.equal(app.status('scout').state, '运行中');
    assert.equal(app.status('scout').model?.model, 'main');
    assert.equal(app.status('scout').effort, 'high');
    assert.equal(app.status('logox').state, '就绪');
    for (const activity of app.store.getSnapshot().activities) app.cancel(activity.activityId);
    await waitForSnapshot(app.store, snapshot => snapshot.activities.every(activity => activity.status === 'cancelled'));
    assert.equal(app.status('scout').model?.model, 'special');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
