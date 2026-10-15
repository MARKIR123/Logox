import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DynamicEnsemble, type ActorContext, type ActorExecutor} from '../src/actors/ensemble.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorRecovery} from '../src/actors/recovery.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {createProvider, ProviderError, providerTimeout} from '../src/providers/http.js';
import {Resources} from '../src/resources/manager.js';
import {loadConfig} from '../src/config/config.js';
import {Journal} from '../src/store/journal.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {createApplication} from '../src/application.js';
import type {ModelRequest, ModelTurn} from '../src/runtime/messages.js';

const call = (tasks: {ownerId: string; prompt: string}[]) => ({id: 'dispatch', name: 'dispatch_role', arguments: JSON.stringify({tasks})});
async function fixture(execute: (prompt: string, context: ActorContext, services: ActorServices) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'logox-actor-recovery-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const journal = new Journal(join(directory, 'journal')), store = new RuntimeStore();
  let services!: ActorServices;
  const run: ActorExecutor<string> = async (prompt, context) => {services.definition(context); await execute(prompt, context, services);};
  const ensemble = new DynamicEnsemble('s', store, journal, run, {member: owner => catalog.find(owner),
    handoff: result => services.handoff(result), settled: (activity, status) => services.settled(activity, status)});
  services = new ActorServices({sessionId: 's', catalog, config, journal, registry: new ProviderRegistry(config, {}),
    resources: new Resources(directory, {home: directory, boundary: directory}), requireIdle() {}, approve: async () => false,
    enqueue: (owner, prompt, source, origin) => ensemble.dispatch(owner, prompt, source, origin),
    pauseBatch: id => ensemble.pauseBatch(id), resumeBatch: id => ensemble.resumeBatch(id), coordinationPath: join(directory, 'coordination.json')});
  await services.recover();
  return {directory, ensemble, services, store, journal,
    async close() {await ensemble.close(); await services.flush(); await rm(directory, {recursive: true, force: true});}};
}
function barrier() {let resolve!: () => void; const promise = new Promise<void>(finish => {resolve = finish;}); return {promise, resolve};}
async function idle(ensemble: DynamicEnsemble): Promise<void> {
  const deadline = Date.now() + 3000;
  while (ensemble.isBusy()) {if (Date.now() > deadline) throw new Error('调度未收敛'); await new Promise(resolve => setTimeout(resolve, 5));}
}

test('技术异常立即暂停同批后续，并优先接管；独立任务继续串行，不自等待', {timeout: 5000}, async () => {
  const order: string[] = [];
  let enqueueIndependent!: () => void;
  const f = await fixture(async (prompt, context, services) => {
    order.push(prompt === '开始' ? '派工' : context.ownerId);
    if (prompt === '开始') {assert.equal((await services.execute(call([{ownerId: 'aletheia', prompt: '故障'}, {ownerId: 'techne', prompt: '依赖'}]), context)).isError, false);}
    else if (context.ownerId === 'aletheia') {enqueueIndependent(); throw new Error('工具传输超时');}
    else context.say('完成');
  });
  try {
    enqueueIndependent = () => {f.ensemble.dispatch('kalon', '独立', 'direct');};
    const first = f.ensemble.dispatch('logox', '开始', 'direct');
    await first.done; await idle(f.ensemble);
    assert.deepEqual(order, ['派工', 'aletheia', 'logox', 'kalon']);
    const tasks = f.store.getSnapshot().activities;
    const failed = tasks.find(task => task.ownerId === 'aletheia')!, paused = tasks.find(task => task.ownerId === 'techne')!;
    assert.equal(paused.status, 'paused'); assert.equal(paused.batchId, failed.batchId);
    assert.equal(tasks.find(task => task.ownerId === 'logox' && task.activityId !== first.activityId)?.rootActivityId, first.activityId);
    assert.equal((await f.journal.tasks('s')).find(task => task.activityId === paused.activityId)?.status, 'paused');
  } finally {await f.close();}
});

test('主循环停止不联动取消子任务，晚到结果只交接给下一次正式输入', {timeout: 5000}, async () => {
  const dispatched = barrier(), release = barrier(); let actorRuns = 0;
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === '开始') {
      await services.execute(call([{ownerId: 'techne', prompt: '子任务'}]), context);
      dispatched.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true}));
    } else {actorRuns++; await release.promise; context.say('子任务完成');}
  });
  try {
    const parent = f.ensemble.dispatch('logox', '开始', 'direct');
    await dispatched.promise;
    f.services.stopDirector(parent.activityId); f.ensemble.cancel(parent.activityId);
    await parent.done; release.resolve(); await idle(f.ensemble);
    assert.equal(actorRuns, 1); assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'logox').length, 1);
    assert.equal(f.store.getSnapshot().activities.find(task => task.ownerId === 'techne')?.status, 'completed');
    assert.match(f.services.resumeDirector('next-user-input'), /子任务完成/);
    await f.services.settled('next-user-input', 'completed');
    assert.equal(f.services.resumeDirector(), '');
  } finally {release.resolve(); await f.close();}
});

test('卡片停止只取消目标工具并暂停后续，独立 Actor 仍完成；不自动补救用户停止', {timeout: 5000}, async () => {
  const started = barrier(); let sideEffects = 0;
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === '开始') await services.execute(call([{ownerId: 'techne', prompt: '等待工具'}, {ownerId: 'aletheia', prompt: '依赖'}]), context);
    else if (prompt === '等待工具') {
      started.resolve(); await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), {once: true}));
      context.signal.throwIfAborted(); sideEffects++;
    } else context.say('独立完成');
  });
  try {
    await f.ensemble.dispatch('logox', '开始', 'direct').done;
    await started.promise;
    const actor = f.store.getSnapshot().activities.find(task => task.ownerId === 'techne')!;
    f.ensemble.dispatch('kalon', '独立', 'direct');
    f.services.stopActor(actor.activityId); f.ensemble.cancel(actor.activityId, 'user');
    await idle(f.ensemble);
    assert.equal(sideEffects, 0);
    assert.equal(f.store.activities.get('s', actor.activityId)?.stopReason, 'user');
    assert.equal(f.store.getSnapshot().activities.find(task => task.ownerId === 'aletheia')?.status, 'paused');
    assert.equal(f.store.getSnapshot().activities.find(task => task.ownerId === 'kalon')?.status, 'completed');
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'logox').length, 1);
    assert.match(f.services.resumeDirector(), /不要自动重试/);
  } finally {await f.close();}
});

test('直接 Actor 技术异常也交 Director，配置不可用维持用户选择', {timeout: 5000}, async () => {
  const f = await fixture(async (_prompt, context) => {
    if (context.ownerId === 'techne') throw new Error('工具异常');
    if (context.ownerId === 'kalon') throw new ProviderError('模型不存在', false, 'model_missing');
    context.say('核对并收束');
  });
  try {
    await f.ensemble.dispatch('techne', '直接任务', 'direct').done; await idle(f.ensemble);
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'logox').length, 1);
    await f.ensemble.dispatch('kalon', '配置问题', 'direct').done; await idle(f.ensemble);
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'logox').length, 1);
    assert.match(f.services.resumeDirector(), /模型不存在|任务/);
  } finally {await f.close();}
});

test('同故障跨执行者仅两次补救，重启预算与停止门保留，回退清除无效根预算', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-recovery-budget-')), path = join(directory, 'state.json');
  try {
    const recovery = new ActorRecovery('s', path); await recovery.recover();
    const first = await recovery.next('root', new ProviderError('工具超时', true, 'temporary'));
    const second = await recovery.next('root', new ProviderError('不同执行者包装的超时', true, 'temporary'), first);
    assert.equal(second.attempt, 2); assert.equal(second.exhausted, undefined);
    recovery.stop(); recovery.defer('root', '待处理结果'); await recovery.flush();
    const restored = new ActorRecovery('s', path); await restored.recover(new Set(['root']));
    assert.equal(restored.stopped(), true);
    assert.equal((await restored.next('root', new ProviderError('第三次失败', true, 'temporary'), second)).exhausted, true);
    assert.equal((await restored.next('root', new Error('另一个独立故障'), second)).attempt, 1);
    assert.match(restored.resume('next'), /待处理结果/); await restored.settled('next', 'completed'); await restored.flush();
    const rewound = new ActorRecovery('s', path); await rewound.recover(new Set());
    assert.equal((await rewound.next('root', new ProviderError('工具超时', true, 'temporary'))).attempt, 1);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('Actor换执行者和Director接手共享两次预算，耗尽回合拒绝再派工并收束', {timeout: 5000}, async () => {
  let actorRuns = 0, directorRuns = 0;
  const attempts: number[] = [];
  const f = await fixture(async (_prompt, context, services) => {
    if (context.ownerId !== 'logox') {actorRuns++; throw new Error('相同工具故障');}
    directorRuns++; attempts.push(context.recovery?.attempt ?? 0);
    if (context.recovery?.exhausted) {
      assert.equal((await services.execute(call([{ownerId: 'aletheia', prompt: '不能第三次派工'}]), context)).isError, true);
      context.say('补救上限已到，需要用户决定');
    } else if (directorRuns === 1) await services.execute(call([{ownerId: 'kalon', prompt: '换执行者补救'}]), context);
    else throw new Error('相同工具故障');
  });
  try {
    await f.ensemble.dispatch('techne', '直接任务', 'direct').done; await idle(f.ensemble);
    assert.equal(actorRuns, 2); assert.equal(directorRuns, 3); assert.deepEqual(attempts, [1, 2, 2]);
    assert.equal(f.store.getSnapshot().activities.at(-1)?.status, 'completed');
  } finally {await f.close();}
});

test('用户新指示可恢复原暂停批次，不重新派发已经完成的工作', {timeout: 5000}, async () => {
  let batchId = '', dependentRuns = 0;
  const f = await fixture(async (prompt, context, services) => {
    if (prompt === '开始') await services.execute(call([{ownerId: 'techne', prompt: '故障'}, {ownerId: 'kalon', prompt: '依赖'}]), context);
    else if (prompt === '故障') throw new Error('暂时工具故障');
    else if (prompt === '用户允许继续') {
      const result = await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({resumeBatch: batchId})}, context);
      assert.equal(result.isError, false);
    } else if (prompt === '依赖') {dependentRuns++; context.say('依赖任务完成');}
    else context.say('等待用户新指示');
  });
  try {
    await f.ensemble.dispatch('logox', '开始', 'direct').done; await idle(f.ensemble);
    const dependent = f.store.getSnapshot().activities.find(task => task.ownerId === 'kalon')!;
    batchId = dependent.batchId!; assert.equal(dependent.status, 'paused');
    const user = f.ensemble.dispatch('logox', '用户允许继续', 'direct');
    assert.match(f.services.resumeDirector(user.activityId), /dispatch_role/);
    await user.done; await idle(f.ensemble);
    assert.equal(dependentRuns, 1);
    assert.equal(f.store.activities.get('s', dependent.activityId)?.status, 'completed');
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'techne').length, 1);
  } finally {await f.close();}
});

test('模型流重置后优先交原Actor续做，Director断流保留原目标与预算', {timeout: 5000}, async () => {
  let original = '', actorRuns = 0, directorRuns = 0;
  const targets: Array<string | undefined> = [], reports: string[] = [];
  const disconnected = () => new ProviderError('模型流连接中断：连接被重置（ECONNRESET）', true, 'temporary',
    {phase: 'stream', status: 200, code: 'ECONNRESET'});
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'kalon') {
      if (++actorRuns === 1) {
        original = context.activityId;
        await context.record({role: 'assistant', text: '', toolCalls: [{id: 'read-before-reset', name: 'read', arguments: '{}'}]});
        await context.record({role: 'tool', callId: 'read-before-reset', name: 'read', text: '已完成读取', isError: false});
        throw disconnected();
      }
      assert.match(prompt, /原目标：打磨原文件/);
      assert.ok(context.history.some(entry => entry.message?.role === 'tool' && entry.message.callId === 'read-before-reset'));
      context.say('使用已有读取结果完成打磨'); return;
    }
    if (prompt.startsWith('角色结果已返回。')) {context.say('打磨已完成'); return;}
    targets.push(context.recovery?.actorTask?.activityId); reports.push(prompt);
    if (++directorRuns === 1) throw disconnected();
    assert.equal(context.recovery?.attempt, 2);
    const result = await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [
      {ownerId: 'kalon', resumeTask: original, prompt: '继续剩余打磨'},
    ]})}, context);
    assert.equal(result.isError, false);
    context.say('已安排原角色继续');
  });
  try {
    await f.ensemble.dispatch('kalon', '打磨原文件', 'direct').done; await idle(f.ensemble);
    assert.deepEqual(targets, [original, original], 'Actor断流和Director再断流都必须保留原续做目标');
    assert.ok(reports.every(prompt => /优先指派原 Actor/.test(prompt) && /ECONNRESET/.test(prompt)));
    assert.equal(actorRuns, 2); assert.equal(directorRuns, 2);
    assert.equal((await f.journal.load('s', 'kalon')).filter(entry => entry.message?.role === 'tool').length, 1);
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'kalon').at(-1)?.status, 'completed');
  } finally {await f.close();}
});

test('超时优先交原Actor续做，Director自身超时仍保留续做目标及共享预算', {timeout: 5000}, async () => {
  let directorRuns = 0, actorRuns = 0, original = '';
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'techne') {
      if (++actorRuns === 1) {
        original = context.activityId;
        await context.record({role: 'assistant', text: '', toolCalls: [{id: 'written', name: 'write', arguments: '{"path":"result"}'}]});
        await context.record({role: 'tool', callId: 'written', name: 'write', text: '文件已写入', isError: false});
        throw providerTimeout();
      }
      assert.match(prompt, /原目标：写文件并报告/);
      assert.ok(context.history.some(entry => entry.message?.role === 'tool' && entry.message.callId === 'written'));
      context.say('根据已有写入结果完成报告'); return;
    }
    if (context.recovery && prompt.includes('优先指派原 Actor')) {
      assert.equal(context.recovery.actorTask?.activityId, original);
      assert.match(prompt, /优先指派原 Actor/);
      if (++directorRuns === 1) throw providerTimeout();
      assert.equal(context.recovery.attempt, 2);
      const resumeCall = {id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [
        {ownerId: 'techne', resumeTask: original, prompt: '完成报告'},
      ]})};
      const result = await services.execute(resumeCall, context);
      assert.equal(result.isError, false);
      assert.equal((await services.execute(resumeCall, context)).isError, true, '同一失败活动不能重复排入续做队列');
    }
    context.say('导演完成');
  });
  try {
    await f.ensemble.dispatch('techne', '写文件并报告', 'direct').done; await idle(f.ensemble);
    assert.equal(actorRuns, 2); assert.equal(directorRuns, 2);
    assert.equal((await f.journal.load('s', 'techne')).filter(entry => entry.message?.role === 'tool').length, 1);
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId === 'techne').at(-1)?.status, 'completed');
  } finally {await f.close();}
});

test('用户下一次输入接到待处理结果后可以续做原Actor，保留原根目标', {timeout: 5000}, async () => {
  let original = '', actorRuns = 0, childRoot = '';
  const results: Array<{text: string; isError: boolean}> = [];
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'kalon') {
      if (++actorRuns === 1) {original = context.activityId; throw providerTimeout();}
      childRoot = context.rootActivityId ?? ''; context.say('继续完成原任务'); return;
    }
    if (prompt === '继续') results.push(await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [
      {ownerId: 'kalon', resumeTask: original, prompt: '完成剩余部分'},
    ]})}, context));
    context.say('处理完成');
  });
  try {
    f.services.stopDirector('stopped');
    await f.ensemble.dispatch('kalon', '原目标', 'direct').done; await idle(f.ensemble);
    const next = f.ensemble.dispatch('logox', '继续', 'direct');
    assert.match(f.services.resumeDirector(next.activityId), /原目标/);
    await next.done; await idle(f.ensemble);
    assert.equal(results[0]?.isError, false, results[0]?.text);
    assert.equal(actorRuns, 2); assert.equal(childRoot, original, '续做仍属于原目标');
  } finally {await f.close();}
});

test('末位Actor失败后续做可以携带已结束的原批次，不恢复其它批次', {timeout: 5000}, async () => {
  let original = '', actorRuns = 0, batchId = '';
  const results: Array<{text: string; isError: boolean}> = [];
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'kalon') {
      if (++actorRuns === 1) {original = context.activityId; batchId = context.batchId ?? ''; throw providerTimeout();}
      context.say('已完成'); return;
    }
    if (prompt === '开始') await services.execute(call([{ownerId: 'kalon', prompt: '原任务'}]), context);
    else if (context.recovery?.actorTask) {
      const task = {ownerId: 'kalon', resumeTask: original, prompt: '续做'};
      results.push(await services.execute({id: 'bad', name: 'dispatch_role', arguments: JSON.stringify({tasks: [task], resumeBatch: '其它批次'})}, context));
      results.push(await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [task], resumeBatch: batchId})}, context));
    }
    context.say('处理完成');
  });
  try {
    await f.ensemble.dispatch('logox', '开始', 'direct').done; await idle(f.ensemble);
    assert.equal(results[0]?.isError, true);
    assert.equal(results[1]?.isError, false, results[1]?.text);
    assert.equal(actorRuns, 2);
  } finally {await f.close();}
});

test('断点续做拒绝其它根目标及角色错配', {timeout: 5000}, async () => {
  let original = '';
  const f = await fixture(async (prompt, context, services) => {
    if (context.ownerId === 'techne') {original = context.activityId; throw providerTimeout();}
    if (prompt === '新目标') {
      const result = await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [
        {ownerId: 'techne', resumeTask: original, prompt: '不应执行'},
      ]})}, context);
      assert.equal(result.isError, true);
    } else {
      const result = await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [
        {ownerId: 'kalon', resumeTask: original, prompt: '不应换角色'},
      ]})}, context);
      assert.equal(result.isError, true);
    }
    context.say('结束');
  });
  try {
    await f.ensemble.dispatch('techne', '原目标', 'direct').done; await idle(f.ensemble);
    await f.ensemble.dispatch('logox', '新目标', 'direct').done; await idle(f.ensemble);
    assert.equal(f.store.getSnapshot().activities.filter(task => task.ownerId !== 'logox').length, 1);
  } finally {await f.close();}
});

test('Actor续做成功或转为不同故障后，不再把旧超时活动当作续做目标', {timeout: 5000}, async () => {
  for (const nextFault of [undefined, new Error('另一种工具故障'),
    new ProviderError('模型服务暂时不可用', true, 'temporary', {status: 503})]) {
    let actorRuns = 0, directorRuns = 0;
    const f = await fixture(async (_prompt, context, services) => {
      if (context.ownerId === 'techne') {
        if (++actorRuns === 1) throw providerTimeout();
        if (nextFault) throw nextFault;
        context.say('已完成'); return;
      }
      if (++directorRuns === 1) {
        const target = context.recovery?.actorTask; assert.ok(target);
        const result = await services.execute({id: 'resume', name: 'dispatch_role', arguments: JSON.stringify({tasks: [
          {ownerId: target.ownerId, resumeTask: target.activityId, prompt: '完成剩余部分'},
        ]})}, context);
        assert.equal(result.isError, false);
      } else assert.equal(context.recovery?.actorTask, undefined, '不能再指派旧超时活动');
      context.say('核对并收束');
    });
    try {
      await f.ensemble.dispatch('techne', '原目标', 'direct').done; await idle(f.ensemble);
      assert.equal(actorRuns, 2); assert.equal(directorRuns, 2);
    } finally {await f.close();}
  }
});

test('HTTP402额度不足在正式应用只失败一次，不触发Logox反复接管，保留API原因', {timeout: 5000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-quota-application-'));
  let requests = 0;
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://example.invalid', model: 'fixture', key: '',
    temperature: 0.2, maxTokens: 100, timeoutMs: 1000}, async () => {
    requests++;
    return Response.json({error: {type: 'unknown_error', code: 'invalid_request_error', message: 'Insufficient Balance'}}, {status: 402});
  });
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}, kernel: {max_retries: 3}}, {}, cwd, cwd);
  const app = await createApplication({cwd, config, provider, sessionId: 'quota', resourceOptions: {home: cwd, boundary: cwd},
    env: {}, authPath: join(cwd, 'auth.json')});
  try {
    await app.submit('@techne 继续剩余报告'); await idle(app.ensemble);
    const tasks = app.store.getSnapshot().activities;
    assert.equal(requests, 1); assert.equal(tasks.length, 1); assert.equal(tasks[0]?.ownerId, 'techne');
    assert.equal(tasks[0]?.status, 'failed'); assert.match(tasks[0]?.detail ?? '', /Insufficient Balance.*余额不足/);
    assert.ok(!tasks[0]?.detail.includes('格式无效'));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('交接携带实际模型终止原因，不把之前可继续的工具失败当根因', {timeout: 5000}, async () => {
  const f = await fixture(async (prompt, context) => {
    if (context.ownerId === 'techne') {
      await context.record({role: 'tool', callId: 'wc', name: 'shell', text: 'wc 命令不存在', isError: true});
      await context.record({role: 'tool', callId: 'read', name: 'read', text: '之后读取成功', isError: false});
      throw new ProviderError('模型流连接中断', true);
    }
    assert.match(prompt, /终止原因（运行时）：模型流连接中断/);
    assert.match(prompt, /此前工具报错不等于本次终止原因/);
    context.say('按模型连接故障处理');
  });
  try {
    await f.ensemble.dispatch('techne', '原任务', 'direct').done; await idle(f.ensemble);
    assert.equal(f.store.getSnapshot().activities.at(-1)?.status, 'completed');
    assert.equal(f.store.getSnapshot().activities.length, 2);
  } finally {await f.close();}
});

test('正式应用超时续做保留真实文件写入与中断输出，补救上限不伪造工具环境变化', {timeout: 10000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-timeout-application-'));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072},
    kernel: {max_retries: 0}, permissions: {mode: 'creative'}}, {}, cwd, cwd);
  const seen: ModelRequest[] = [];
  const complete = (text: string): ModelTurn => ({message: {role: 'assistant', text}, stop: 'complete'});
  let writes = 0, resumes = 0, repeatFailure = false, limited = false;
  const app = await createApplication({cwd, config, sessionId: 's', resourceOptions: {home: cwd, boundary: cwd},
    env: {}, authPath: join(cwd, 'auth.json'), provider: {async respond(request, delta) {
      seen.push(request);
      const messages = request.messages.filter(message => !message.text.startsWith('【角色直接对话索引】'));
      const input = messages.findLast(message => message.role === 'user')?.text ?? '';
      const last = messages.at(-1);
      if (!request.tools.length) {
        assert.match(request.system, /本任务同一故障已补救两次/);
        assert.ok(!request.system.includes('当前可用工具：无'));
        limited = true; return complete('本任务补救已达上限');
      }
      if (last?.role === 'tool' && last.name === 'dispatch_role') return complete('等待原角色');
      if (input.includes('优先指派原 Actor')) {
        const match = /dispatch_role\((\{[^\n]+\})\)/.exec(input); assert.ok(match);
        return {message: {role: 'assistant', text: '', toolCalls: [{id: 'resume', name: 'dispatch_role', arguments: match[1]!}]}, stop: 'tools'};
      }
      if (input.includes('【原 Actor 任务断点续做】')) {
        resumes++;
        if (repeatFailure) {delta({kind: 'reasoning', text: '续做仍停滞'}); throw providerTimeout();}
        assert.match(JSON.stringify(request.messages), /result\.txt/);
        assert.match(JSON.stringify(request.messages), /中断的报告/);
        assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'done');
        return complete('【轮次摘要】\n标题：写入与报告完成\n报告：沿用已写文件，完成剩余报告。');
      }
      if (input.includes('仅子角色：写文件后报告')) {
        if (last?.role === 'tool') {delta({kind: 'text', text: '中断的报告'}); throw providerTimeout();}
        writes++;
        return {message: {role: 'assistant', text: '', toolCalls: [{id: 'write-once', name: 'write',
          arguments: JSON.stringify({path: 'result.txt', content: 'done'})}]}, stop: 'tools'};
      }
      if (input.includes('仅子角色：重复超时')) {delta({kind: 'reasoning', text: '故障前思考'}); throw providerTimeout();}
      return complete('Logox 已接收结果');
    }}});
  try {
    await app.submit('@techne 仅子角色：写文件后报告'); await idle(app.ensemble);
    assert.equal(writes, 1); assert.equal(resumes, 1);
    assert.equal((await app.journal.load('s', 'techne')).filter(entry => entry.message?.role === 'tool' && entry.message.name === 'write').length, 1);
    assert.equal(app.store.getSnapshot().activities.filter(task => task.ownerId === 'techne').at(-1)?.status, 'completed');
    repeatFailure = true;
    await app.submit('@techne 仅子角色：重复超时'); await idle(app.ensemble);
    assert.equal(limited, true, JSON.stringify(app.store.getSnapshot().activities.map(task => ({owner: task.ownerId, status: task.status, detail: task.detail}))));
    assert.equal(resumes, 3, '第一次成功续做加本任务两次补救');
    const events = await app.journal.systemEvents('s');
    assert.ok(events.every(event => event.kind !== 'environment_change' || !event.text.includes('当前可用工具：无')));
    await app.submit('继续新目标'); await idle(app.ensemble);
    assert.ok(seen.at(-1)!.tools.some(tool => tool.name === 'write'), '新输入仍拥有正常工具能力');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('已绑定Director但尚未消费的报告跨重启恢复，失败退回，完成只消费一次', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-assigned-reports-')), path = join(directory, 'state.json');
  try {
    const first = new ActorRecovery('s', path); await first.recover();
    first.defer('actor-root', '已完成读取，尚待Logox核对'); await first.flush();
    assert.match(first.resume('queued-director'), /已完成读取/); await first.flush();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.pending.length, 0); assert.equal(saved.assigned[0].activityId, 'queued-director');

    const restarted = new ActorRecovery('s', path);
    await restarted.recover(new Set(['actor-root'])); // 接收方的排队检查点可能尚未完成，原Actor结果仍有效。
    assert.match(restarted.resume(), /已完成读取/);
    assert.match(restarted.resume('retry-director'), /已完成读取/);
    await restarted.settled('retry-director', 'failed');
    assert.match(restarted.resume(), /已完成读取/);
    assert.match(restarted.resume('cancelled-director'), /已完成读取/);
    await restarted.settled('cancelled-director', 'cancelled');
    assert.match(restarted.resume('completed-director'), /已完成读取/);
    await restarted.settled('completed-director', 'completed');
    const completed = new ActorRecovery('s', path); await completed.recover(new Set(['actor-root']));
    assert.equal(completed.resume('later-input'), '');

    completed.defer('rewound-root', '应被回退清除'); completed.resume('another-director'); await completed.flush();
    const rewound = new ActorRecovery('s', path); await rewound.recover(new Set(['actor-root']));
    assert.equal(rewound.resume(), '');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('空白协调恢复及空白resume不创建文件，旧版状态兼容assigned默认值', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-empty-recovery-')), path = join(directory, 'state.json');
  try {
    const recovery = new ActorRecovery('s', path); await recovery.recover();
    assert.equal(recovery.resume('empty'), ''); await recovery.flush();
    await assert.rejects(readFile(path), {code: 'ENOENT'});
    recovery.defer('root', '报告'); await recovery.flush();
    const old = JSON.parse(await readFile(path, 'utf8')); delete old.assigned;
    await writeFile(path, JSON.stringify(old));
    const compatible = new ActorRecovery('s', path); await compatible.recover(new Set(['root']));
    assert.match(compatible.resume('receiver'), /报告/); await compatible.flush();
  } finally {await rm(directory, {recursive: true, force: true});}
});
