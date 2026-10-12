import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDemo} from '../src/demo.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {waitForSnapshot as waitFor} from './runtime-fixture.js';
import {initialDemoSceneState, buildDemoSceneRows} from '../src/tui/scene.js';
import {projectPortfolioScene} from '../src/tui/scene-state.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'logox-demo-test-'));
  const runtime = createDemo('s', directory);
  await runtime.ready;
  return {...runtime, async cleanup() {await runtime.close(); await rm(directory, {recursive: true, force: true});}};
}
for (const decision of ['allow_once', 'deny'] as const) {
  test(`作品集运行时：${decision} 解开真实权限，串行提问与排队回复共用快照`, async () => {
    const runtime = await fixture();
    try {
      const {store, scenario} = runtime;
      const permission = store.interactions.list()[0]!;
      assert.equal(permission.activityId, scenario.techne);
      assert.equal(store.activities.get('s', scenario.techne)!.status, 'waiting_input');
      assert.equal(store.activities.get('s', scenario.kalon)!.status, 'queued');
      await runtime.submit('@kalon 只读检查');
      const user = store.getSnapshot().messages.find(message => message.text === '只读检查')!;
      assert.equal(user.source, 'logox');
      assert.ok(user.activityId);
      assert.equal(store.activities.get('s', user.activityId)!.status, 'queued');
      assert.ok(!store.getSnapshot().messages.some(message => message.activityId === user.activityId && message.role === 'assistant'));
      const queued = projectPortfolioScene(initialDemoSceneState, store.getSnapshot(), 's', scenario);
      assert.equal(queued.events.at(-1)!.status, '排队中');
      assert.equal(store.interactions.respond(answerEnvelope(permission, {kind: 'permission', decision})).ok, true);
      assert.equal(store.interactions.respond(answerEnvelope(permission, {kind: 'permission', decision})).ok, false, '重复回答被拒绝');
      await waitFor(store, snapshot => snapshot.interactions.some(item => item.activityId === scenario.kalon && item.status === 'pending'));
      const question = store.interactions.list().find(item => item.activityId === scenario.kalon)!;
      assert.equal(store.activities.get('s', user.activityId)!.status, 'queued');
      assert.equal(store.interactions.respond(answerEnvelope(question, {kind: 'question', answers: {style: {type: 'text', text: '像独立杂志，但不要复古装饰'}}})).ok, true);
      await waitFor(store, snapshot => snapshot.activities.some(item => item.activityId === user.activityId && item.status === 'completed'));
      const main = projectPortfolioScene(initialDemoSceneState, store.getSnapshot(), 's', scenario);
      const own = projectPortfolioScene({...initialDemoSceneState, view: 'kalon'}, store.getSnapshot(), 's', scenario);
      assert.equal(main.permission, decision === 'allow_once' ? 'allow' : 'deny');
      assert.equal(main.style, own.style);
      assert.equal(main.style, '像独立杂志，但不要复古装饰');
      assert.equal(main.events.at(-1)!.activityId, own.events.at(-1)!.activityId);
      assert.equal(main.events.at(-1)!.status, '已完成');
      assert.match(main.events.at(-1)!.reply!, /行，先不动文件/);
      const text = buildDemoSceneRows({...main, folds: {'main-techne': true}}, 99).map(row => row.text).join('\n');
      assert.doesNotMatch(text, /已完成 · 修改 2 个文件|网格断言通过/);
      assert.equal(store.getSnapshot().messages.filter(message => message.activityId === user.activityId && message.role === 'user').length, 1);
    } finally {await runtime.cleanup();}
  });
}

test('作品集取消：取消请求不伪造裁决，角色继续登场；关闭释放全部等待及排队任务', async () => {
  const runtime = await fixture();
  try {
    const {store, scenario} = runtime;
    await runtime.submit('独立窗口的任务', 'aletheia');
    const accepted = store.getSnapshot().messages.find(item => item.text === '独立窗口的任务')!;
    assert.equal(accepted.ownerId, 'aletheia');
    assert.equal(accepted.source, 'aletheia');
    runtime.cancel(accepted.activityId!);
    assert.equal(store.activities.get('s', accepted.activityId!)!.status, 'cancelled', '排队取消立即可见');
    store.interactions.cancel(store.interactions.list()[0]!.requestId);
    await waitFor(store, snapshot => snapshot.interactions.some(item => item.activityId === scenario.kalon));
    const cancelledPermission = projectPortfolioScene(initialDemoSceneState, store.getSnapshot(), 's', scenario);
    assert.equal(cancelledPermission.permission, null);
    assert.equal(cancelledPermission.runtime!.permissionRequest!.status, 'cancelled');
    assert.match(buildDemoSceneRows({...cancelledPermission, folds: {'main-techne': true}}, 99).map(row => row.text).join('\n'), /许可已取消/);
    await runtime.submit('@techne 后续任务');
    await runtime.close();
    assert.ok(store.interactions.list().every(item => item.status !== 'pending'));
    assert.ok(store.activities.list().every(item => ['completed', 'cancelled', 'failed'].includes(item.status)));
    const closed = projectPortfolioScene(initialDemoSceneState, store.getSnapshot(), 's', scenario);
    assert.equal(closed.style, null);
    assert.ok(!store.getSnapshot().messages.some(item => item.activityId === accepted.activityId && item.role === 'assistant'));
    await assert.rejects(runtime.submit('@unknown 工作'), /已知角色/);
    await assert.rejects(runtime.submit('@kalon 关闭后'), /剧团已关闭/);
  } finally {await runtime.cleanup();}
});

test('入梦命令接入场景：同一活动暂停、续做和关闭，白底卡读取真实阶段', async () => {
  const runtime = await fixture();
  try {
    const permission = runtime.store.interactions.list()[0]!;
    runtime.store.interactions.respond(answerEnvelope(permission, {kind: 'permission', decision: 'deny'}));
    await waitFor(runtime.store, snapshot => snapshot.interactions.some(item => item.activityId === runtime.scenario.kalon && item.status === 'pending'));
    const style = runtime.store.interactions.list()[1]!;
    runtime.store.interactions.respond(answerEnvelope(style, {kind: 'question', answers: {style: {type: 'option', optionId: 'minimal'}}}));
    await waitFor(runtime.store, snapshot => snapshot.activities.some(item => item.activityId === runtime.scenario.kalon && item.status === 'completed'));
    await runtime.submit('/anamnesis start');
    const activity = runtime.store.activities.list().find(item => item.kind === 'anamnesis')!;
    assert.ok(activity);
    await runtime.submit('/anamnesis stop');
    assert.equal(runtime.store.activities.get('s', activity.activityId)!.status, 'paused');
    const scene = projectPortfolioScene(initialDemoSceneState, runtime.store.getSnapshot(), 's', runtime.scenario);
    const rows = buildDemoSceneRows({...scene, folds: {[activity.activityId]: true}}, 99);
    assert.ok(rows.some(row => row.messageId === activity.activityId && row.text.includes('已暂停')));
    assert.ok(rows.some(row => row.text.includes('等待续做')));
    await runtime.submit('/anamnesis start');
    assert.equal(runtime.store.activities.list().filter(item => item.kind === 'anamnesis').length, 1);
    await runtime.close();
    assert.equal(runtime.store.activities.get('s', activity.activityId)!.status, 'cancelled');
  } finally {await runtime.cleanup();}
});
