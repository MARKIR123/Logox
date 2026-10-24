import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorRecovery} from '../src/actors/recovery.js';
import {ActorServices} from '../src/actors/services.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import type {TaskOrigin} from '../src/actors/ensemble.js';
import {ExecutionRecoveryError, executionRecoveryInstruction, toolProgressFingerprint} from '../src/kernel/execution-recovery.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {ProviderError} from '../src/providers/http.js';
import {Resources} from '../src/resources/manager.js';
import {Journal} from '../src/store/journal.js';
import {loadConfig} from '../src/config/config.js';
import {createApplication} from '../src/application.js';
import type {ModelRequest, ModelTurn} from '../src/runtime/messages.js';

test('Actor and Director recovery share the root budget across reassignment and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-budget-')), path = join(directory, 'coordination.json');
  try {
    const recovery = new ActorRecovery('s', path);
    assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
    assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'handoff');
    assert.equal(await recovery.execution('root', 'no_delivery', 'kalon'), 'handoff');
    assert.deepEqual(await recovery.directorClaim('root', 'no_delivery'), {key: 'execution:no_delivery', attempt: 2});
    const restored = new ActorRecovery('s', path); await restored.recover(new Set(['root']));
    assert.equal(await restored.execution('root', 'no_delivery', 'logox'), 'stop');
    assert.equal(await restored.execution('root', 'no_delivery', 'aletheia'), 'stop');
    assert.equal(await restored.directorClaim('root', 'no_delivery'), undefined);
    assert.equal(await restored.execution('other-root', 'no_delivery', 'logox'), 'retry');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('only new execution evidence resets recovery; duplicate tools, labels and dispatches do not', async () => {
  const recovery = new ActorRecovery('s');
  const read = {id: 'read', name: 'read', arguments: '{"file_path":"scene.html","offset":1}'};
  const signature = toolProgressFingerprint(read, {text: '1: initial scene', isError: false})!;
  assert.equal(await recovery.progress('root', signature), true);
  assert.equal(await recovery.execution('root', 'no_delivery', 'logox'), 'retry');
  assert.equal(await recovery.execution('root', 'no_delivery', 'logox'), 'retry');
  assert.equal(await recovery.progress('root', signature), false);
  assert.equal(toolProgressFingerprint({...read, name: 'dispatch_role'}, {text: '已排队', isError: false}), undefined);
  assert.equal(toolProgressFingerprint({...read, name: 'update_task_progress'}, {text: '计划已更新', isError: false}), undefined);
  for (const name of ['UpdateTaskProgress', 'update_task_progress', 'updatetaskprogress', 'UPDATETASKPROGRESS']) {
    assert.equal(toolProgressFingerprint({...read, name, arguments: '{"label":"Reading layout"}'}, {text: 'Current activity: Reading layout.', isError: false}), undefined);
  }
  assert.equal(toolProgressFingerprint(read, {text: '未获许可', isError: true, disposition: 'denied'}), undefined);
  assert.equal(await recovery.execution('root', 'no_delivery', 'logox'), 'stop');
  const changed = toolProgressFingerprint(read, {text: '1: improved scene', isError: false})!;
  assert.equal(await recovery.progress('root', changed), true);
  assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
  const equivalent = {...read, arguments: '{ "offset": 1, "file_path": "scene.html" }'};
  assert.equal(toolProgressFingerprint(equivalent, {text: '1: improved scene', isError: false}), changed);
});

test('text and tool truncation share recovery without consuming the network budget', async () => {
  const recovery = new ActorRecovery('s');
  assert.equal(await recovery.execution('root', 'truncated_text', 'techne'), 'retry');
  assert.equal(await recovery.execution('root', 'truncated_tools', 'techne'), 'retry');
  assert.equal(await recovery.execution('root', 'truncated_tools', 'techne'), 'handoff');
  assert.deepEqual(await recovery.directorClaim('root', 'truncated_text'), {key: 'execution:truncated', attempt: 2});
  assert.equal(await recovery.directorClaim('root', 'truncated_tools'), undefined);
  assert.equal(await recovery.execution('root', 'truncated_text', 'logox'), 'stop');
  assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
  assert.equal((await recovery.next('root', new ProviderError('网络断开', true, 'temporary'))).attempt, 1);
});

test('explicit continuation grants a new recovery group while rewind removes invalid roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-grant-')), path = join(directory, 'coordination.json');
  try {
    const recovery = new ActorRecovery('s', path);
    await recovery.progress('root', 'stage:build:骨架已落盘');
    await recovery.execution('root', 'no_delivery', 'logox'); await recovery.execution('root', 'no_delivery', 'logox');
    await recovery.execution('root', 'truncated_text', 'techne'); await recovery.execution('root', 'truncated_tools', 'techne');
    await recovery.directorClaim('root', 'truncated_tools');
    await recovery.grantExecution('root');
    assert.equal(await recovery.progress('root', 'stage:build:骨架已落盘'), false);
    assert.equal(await recovery.execution('root', 'no_delivery', 'techne'), 'retry');
    assert.equal(await recovery.execution('root', 'truncated_tools', 'techne'), 'retry');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.execution.root.noDelivery.total, 3);
    assert.equal(saved.execution.root.truncation.total, 3);
    assert.ok(saved.execution.root.history.some((event: {event: string}) => event.event === 'grant'));
    const rewind = new ActorRecovery('s', path); await rewind.recover(new Set());
    assert.equal(await rewind.execution('root', 'no_delivery', 'logox'), 'retry');
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('legacy coordination state loads without execution fields or empty-session writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-old-')), path = join(directory, 'coordination.json');
  try {
    const empty = new ActorRecovery('s', path); await empty.recover(); await empty.flush();
    await assert.rejects(readFile(path), {code: 'ENOENT'});
    await writeFile(path, JSON.stringify({version: 1, sessionId: 's', stopped: false, roots: {}, pending: []}));
    const restored = new ActorRecovery('s', path); await restored.recover();
    assert.equal(await restored.execution('root', 'no_delivery', 'kalon'), 'retry');
  } finally {await rm(directory, {recursive: true, force: true});}
});

async function servicesFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-handoff-'));
  const config = await loadConfig(directory, {}, {}, directory, directory);
  const catalog = new ActorCatalog(directory, {home: directory}); await catalog.load();
  const queued: {owner: string; prompt: string; source: string; origin: TaskOrigin}[] = [];
  const registry = new ProviderRegistry(config, {});
  const services = new ActorServices({sessionId: 's', catalog, config, registry, journal: new Journal(join(directory, 'journal')),
    resources: new Resources(directory, {home: directory, boundary: directory}), requireIdle() {}, approve: async () => false,
    enqueue(owner, prompt, source, origin = {}) {
      queued.push({owner, prompt, source, origin});
      return {activityId: 'director-' + queued.length, done: Promise.resolve(), cancel() {}};
    }, coordinationPath: join(directory, 'coordination.json')});
  return {services, queued, async close() {await services.flush(); await registry.close(); await rm(directory, {recursive: true, force: true});}};
}
const summary = {title: '当前步骤尚未交付', report: '保留已完成读取；下一步需要落盘骨架。', source: 'local' as const};

test('no-delivery handoff retains Actor identity and breakpoint without an extra explanation request', async () => {
  const f = await servicesFixture();
  try {
    await f.services.recovery.execution('root', 'no_delivery', 'techne');
    await f.services.handoff({ownerId: 'techne', activityId: 'failed-actor', rootActivityId: 'root', source: 'logox', status: 'failed',
      summary, error: new ExecutionRecoveryError('no_delivery', 'handoff')});
    assert.equal(f.queued.length, 1); assert.equal(f.queued[0]!.source, 'techne');
    assert.equal(f.queued[0]!.origin.inputKind, 'actor');
    assert.deepEqual(f.queued[0]!.origin.recovery, {key: 'execution:no_delivery', attempt: 2});
    const event = f.services.deliveries.pending('logox')[0]!;
    assert.match(event.text, /resumeTask/); assert.equal(event.sourceActivityId, 'failed-actor');
    assert.doesNotMatch(event.text, /模型请求超时|工具全部|1\/2/);
    await f.services.handoff({ownerId: 'logox', activityId: 'director-1', rootActivityId: 'root', source: 'techne',
      recovery: f.queued[0]!.origin.recovery!, status: 'failed', summary, error: new ExecutionRecoveryError('no_delivery', 'stop')});
    assert.equal(f.queued.length, 1);
    assert.ok(f.services.deliveries.pending('logox').some(item => item.deferredUntilHuman && item.text.includes('当前步骤尚未交付')));
  } finally {await f.close();}
});

test('user cancellation and Director pause do not consume recovery attempts', async () => {
  const f = await servicesFixture();
  try {
    await f.services.recovery.execution('user-root', 'no_delivery', 'kalon');
    await f.services.handoff({ownerId: 'kalon', activityId: 'user-stop', rootActivityId: 'user-root', source: 'direct', status: 'cancelled',
      stopReason: 'user', summary, error: new ExecutionRecoveryError('no_delivery', 'handoff')});
    assert.equal(f.queued.length, 0);
    assert.equal(await f.services.recovery.execution('user-root', 'no_delivery', 'logox'), 'retry');
    f.services.stopDirector('main');
    await f.services.recovery.execution('paused-root', 'no_delivery', 'techne');
    await f.services.handoff({ownerId: 'techne', activityId: 'late-actor', rootActivityId: 'paused-root', source: 'logox', status: 'failed',
      summary, error: new ExecutionRecoveryError('no_delivery', 'handoff')});
    assert.equal(f.queued.length, 0);
    assert.equal(await f.services.recovery.execution('paused-root', 'no_delivery', 'logox'), 'retry');
  } finally {await f.close();}
});

test('recovery instructions narrow the step without raising model output limits', () => {
  assert.match(executionRecoveryInstruction('no_delivery', 'techne'), /minimum deliverable step/i);
  assert.match(executionRecoveryInstruction('no_delivery', 'logox', true), /Pivot the action plan/i);
  assert.match(executionRecoveryInstruction('truncated_tools', 'techne'), /batch was not executed/i);
  assert.match(executionRecoveryInstruction('truncated_text', 'logox'), /from the break point/i);
});

test('application continuation retains Actor labels and root identity without tool replay', {timeout: 10000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-execution-application-'));
  const config = await loadConfig(directory, {provider: {model: 'fixture', context_window: 131072},
    kernel: {max_retries: 0}, permissions: {mode: 'creative'}}, {}, directory, directory);
  const requests: ModelRequest[] = [];
  let allowedContinue = false;
  const app = await createApplication({cwd: directory, config, sessionId: 's', resourceOptions: {home: directory, boundary: directory},
    env: {}, authPath: join(directory, 'auth.json'), provider: {async respond(request, delta): Promise<ModelTurn> {
      requests.push(request);
      if (requests.length === 1) return {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id: 'plan',
        name: 'update_task_progress', arguments: JSON.stringify({label: 'Building the runnable baseline'})}]}};
      if (allowedContinue) {
        assert.match(request.system, /Current activity label.*Building the runnable baseline/);
        assert.ok(request.messages.every(message => message.role !== 'assistant' || !!message.text || !!message.toolCalls?.length));
        return {stop: 'complete', message: {role: 'assistant', text: '已有阶段和工具结果已核对，当前步骤可以继续。'}};
      }
      delta({kind: 'reasoning', text: '只在思考，没有交付'});
      return {stop: 'length', message: {role: 'assistant', text: '', reasoning: '只在思考，没有交付'}};
    }}});
  const idle = async () => {
    const end = Date.now() + 4000;
    while (app.ensemble.isBusy()) {if (Date.now() > end) throw new Error('执行恢复没有收敛'); await new Promise(resolve => setTimeout(resolve, 5));}
  };
  try {
    await app.ensemble.dispatch('techne', '建立可运行页面', 'logox', {inputKind: 'director', authorization: ['建立可运行页面']}).done; await idle();
    assert.equal(requests.length, 4, 'One label update, two Actor no-delivery turns and one Director recovery turn');
    const tasks = app.store.getSnapshot().activities;
    const actor = tasks.find(task => task.ownerId === 'techne')!;
    assert.equal(actor.status, 'failed'); assert.deepEqual(actor.progress, {label: 'Building the runnable baseline'});
    assert.equal(tasks.filter(task => task.ownerId === 'logox').length, 1, 'No extra model request merely to explain failure');
    allowedContinue = true;
    await app.submit('@techne 继续'); await idle();
    const continued = app.store.getSnapshot().activities.filter(task => task.ownerId === 'techne').at(-1)!;
    assert.equal(continued.rootActivityId, actor.rootActivityId ?? actor.activityId);
    assert.equal(continued.status, 'completed'); assert.deepEqual(continued.progress, {label: 'Building the runnable baseline'});
    const records = await app.journal.load('s', 'techne');
    assert.equal(records.filter(entry => entry.message?.role === 'tool' && entry.message.name === 'update_task_progress').length, 1);
    assert.ok(app.store.getSnapshot().messages.every(message => message.ownerId !== 'logox' ||
      message.role !== 'user' || message.inputKind !== 'actor'));
  } finally {await app.close(); await rm(directory, {recursive: true, force: true});}
});
