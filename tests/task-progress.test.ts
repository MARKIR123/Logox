import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ensemble, type ActorContext} from '../src/actors/ensemble.js';
import {TaskProgress, taskProgressTool} from '../src/runtime/task-progress.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {taskProgressSchema, type TaskProgressSnapshot} from '../src/runtime/contracts.js';
import {Journal, type HistoryStore} from '../src/store/journal.js';

const foundation = {id: 'foundation', title: '搭建可运行骨架', purpose: '先交付能够打开的动画', activeForm: '正在搭建可运行骨架'};
const motion = {id: 'motion', title: '理顺骑行动作', purpose: '统一车轮和踏板的节奏', activeForm: '正在核对骑行动作'};
function fixture(saveProgress?: (value: TaskProgressSnapshot) => Promise<void>) {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', ownerId: 'techne', activityId: 'a', kind: 'actor', title: 'Techne', stage: '已登场', detail: '', status: 'running'});
  const context: ActorContext = {sessionId: 's', ownerId: 'techne', activityId: 'a', history: [], signal: new AbortController().signal,
    report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'fixture'};}, async permission() {return true;},
    ...(saveProgress ? {saveProgress} : {})};
  return {store, context, progress: new TaskProgress(store, context)};
}

test('阶段严格校验、一次一个当前阶段、成果与取消原因保留且不可改写', async () => {
  const {store, progress} = fixture();
  assert.equal(taskProgressTool.name, 'UpdateTaskProgress');
  assert.equal(progress.snapshot().planned, false);
  assert.match(taskProgressTool.description, /(?:Simple tasks do not require phases|简单任务无需清单)/);
  for (const input of [{}, {stages: [foundation, foundation]}, {stages: [{...foundation, bogus: true}]}]) {
    assert.equal((await progress.update(input)).isError, true);
    assert.equal(progress.snapshot().revision, 0);
  }
  assert.equal((await progress.update({stages: [foundation, motion], update: {id: foundation.id, status: 'in_progress'}})).isError, false);
  const first = progress.snapshot();
  assert.equal(progress.current()?.id, foundation.id);
  assert.equal((await progress.update({update: {id: foundation.id, status: 'completed'}})).isError, true);
  assert.equal((await progress.update({update: {id: motion.id, status: 'in_progress'}})).isError, false);
  assert.equal(progress.snapshot().stages.find(stage => stage.id === foundation.id)?.status, 'pending');
  assert.equal(first.stages[0]?.status, 'in_progress', '快照和修订历史不能被后续更新污染');
  assert.equal((await progress.update({update: {id: foundation.id, status: 'completed', result: '单文件动画已落盘，可直接打开。'}})).isError, false);
  assert.equal((await progress.update({stages: [{...foundation, title: '改写旧成果'}, motion]})).isError, true);
  assert.equal((await progress.update({stages: [motion]})).isError, true);
  assert.equal((await progress.update({update: {id: foundation.id, status: 'in_progress'}})).isError, true);
  assert.equal((await progress.update({update: {id: motion.id, status: 'skipped'}})).isError, true);
  assert.equal((await progress.update({update: {id: motion.id, status: 'skipped', reason: '现场确认已有动作满足目标。'}})).isError, false);
  assert.equal(progress.current(), undefined, '计划结束不重新落入初始 planning');
  assert.deepEqual(store.activities.get('s', 'a')?.progress, progress.snapshot());
  assert.equal(progress.snapshot().revisions.length, 4);
  assert.match(progress.instruction(), /单文件动画已落盘/);
  assert.equal(taskProgressSchema.safeParse({...progress.snapshot(), activeStageId: foundation.id}).success, false);
});

test('阶段修订和持久化失败均不污染正在使用的计划', async () => {
  let reject = false;
  const {store, progress} = fixture(async () => {if (reject) throw new Error('disk full');});
  await progress.update({stages: [foundation, motion], update: {id: foundation.id, status: 'in_progress'}});
  await progress.update({stages: [foundation, {...motion, title: '核对骑行动作与节奏'}]});
  const before = progress.snapshot(); reject = true;
  const result = await progress.update({update: {id: foundation.id, status: 'completed', result: '文件已生成'}});
  assert.equal(result.isError, true); assert.match(result.text, /disk full/);
  assert.equal(progress.snapshot(), before);
  assert.deepEqual(store.activities.get('s', 'a')?.progress, before);
  assert.equal(before.revisions[0]?.stages[1]?.title, motion.title, '修订保留原计划');
});

test('单请求 Thinking 和工具领取稳定阶段，初始探查不事后归类', async () => {
  const {store, progress} = fixture(); let time = 0;
  const steps = new Steps(store, {sessionId: 's', ownerId: 'techne', activityId: 'a'}, () => time, () => progress.current());
  const initial = steps.thinking(); time = 10; steps.finish(initial, 'completed');
  const probe = steps.tool({id: 'probe', name: 'read', arguments: '{"path":"README.md"}'});
  await progress.update({stages: [foundation, motion], update: {id: foundation.id, status: 'in_progress'}});
  const build = steps.thinking(); time = 40; steps.finish(build, 'completed');
  await progress.update({update: {id: motion.id, status: 'in_progress'}});
  const edit = steps.tool({id: 'edit', name: 'edit', arguments: '{"path":"animation.html"}'});
  steps.finish(edit, 'failed', '被权限规则拒绝', 'denied');
  assert.equal(steps.get(initial).stage?.id, 'planning');
  assert.equal(steps.get(probe).stage?.id, 'planning');
  assert.equal(steps.get(build).stage?.id, foundation.id);
  assert.equal(steps.get(edit).stage?.id, motion.id);
  assert.notEqual(steps.get(initial).groupId, steps.get(build).groupId);
  assert.equal(steps.get(edit).disposition, 'denied');
  assert.equal(steps.get(build).elapsedMs, 30);
});

test('失败任务检查点保存阶段，原 Actor 续做继承成果和修订历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-task-progress-'));
  const history = new Journal(directory), store = new RuntimeStore();
  const ensemble = new Ensemble('s', store, history, async (prompt, context) => {
    const progress = new TaskProgress(store, context);
    if (prompt === 'first') {
      await progress.update({stages: [foundation, motion], update: {id: foundation.id, status: 'in_progress'}});
      await progress.update({update: {id: foundation.id, status: 'completed', result: '动画骨架已落盘'}});
      await progress.update({update: {id: motion.id, status: 'in_progress'}});
      throw new Error('fixture disconnect');
    }
    assert.equal(progress.current()?.id, motion.id);
    assert.equal(progress.snapshot().stages[0]?.result, '动画骨架已落盘');
    assert.equal(progress.snapshot().revisions.length, 3);
    await progress.update({update: {id: motion.id, status: 'completed', result: '骑行动作已核对'}});
    context.say('动画和骑行动作已完成。');
  });
  try {
    const first = ensemble.dispatch('techne', 'first', 'logox', {recovery: {key: 'execution:no_delivery', attempt: 1,
      actorTask: {ownerId: 'techne', activityId: 'previous'}}}); await first.done;
    const failed = (await history.tasks('s')).find(task => task.activityId === first.activityId)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.progress?.activeStageId, motion.id);
    assert.deepEqual(failed.recovery, {key: 'execution:no_delivery', attempt: 1}, '恢复检查点只保存公共字段');
    const second = ensemble.dispatch('techne', 'resume', 'logox', {resumeTaskId: first.activityId}); await second.done;
    const completed = (await new Journal(directory).tasks('s')).find(task => task.activityId === second.activityId)!;
    assert.equal(completed.status, 'completed'); assert.equal(completed.resumeTaskId, first.activityId);
    assert.equal(completed.progress?.stages[1]?.result, '骑行动作已核对');
    assert.equal(completed.progress?.revisions.length, 4);
    assert.deepEqual(await history.progress('s', 'techne', second.activityId), completed.progress);
    assert.equal(await history.progress('s', 'kalon', second.activityId), undefined);
  } finally {await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});

test('阶段落盘期间主动停止保留提交记录，终态不被晚到 running 检查点覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logox-progress-cancel-')), journal = new Journal(directory), store = new RuntimeStore();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve;}), blocked = new Promise<void>(resolve => {entered = resolve;});
  const history: HistoryStore = {
    load: (session, owner) => journal.load(session, owner), append: entry => journal.append(entry),
    finish: (session, owner, activity, status) => journal.finish(session, owner, activity, status),
    checkpoint: async (session, task) => {if (task.progress && task.status === 'running') {entered(); await pending;} await journal.checkpoint(session, task);},
  };
  const ensemble = new Ensemble('s', store, history, async (_prompt, context) => {
    await new TaskProgress(store, context).update({stages: [foundation], update: {id: foundation.id, status: 'in_progress'}});
    assert.fail('停止后不能继续执行任务');
  });
  try {
    const task = ensemble.dispatch('techne', 'build');
    await blocked; ensemble.cancel(task.activityId); release(); await task.done;
    const checkpoint = (await journal.tasks('s')).find(entry => entry.activityId === task.activityId)!;
    assert.equal(checkpoint.status, 'cancelled'); assert.equal(checkpoint.stopReason, 'user');
    assert.equal(checkpoint.progress?.activeStageId, foundation.id);
    assert.equal(store.activities.get('s', task.activityId)?.status, 'cancelled');
  } finally {release(); await ensemble.close(); await rm(directory, {recursive: true, force: true});}
});
