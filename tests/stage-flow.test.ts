import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/stage.js';
import {palette} from '../src/tui/cards.js';
import {cast} from '../src/actors/ensemble.js';
import {decorateRow} from '../src/tui/row-presentation.js';
import {actionAt} from '../src/tui/scene.js';
import {contentPoint, selectionRange} from '../src/tui/selection.js';
import {extractSelection} from '../src/tui/viewport.js';
import {TaskProgress} from '../src/runtime/task-progress.js';
import type {ActorContext} from '../src/actors/ensemble.js';

const skeleton = {id: 'skeleton', title: '铺好可运行骨架', purpose: '形成打开即运行的动画', activeForm: '正在铺好动画骨架'};
const riding = {id: 'riding', title: '理顺骑行动作', purpose: '核对车轮与地面的节奏', activeForm: '正在核对骑行动作'};
function fixture() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: '完成鹈鹕骑车动画',
    status: 'running', stage: '处理中', detail: '', progress: {planned: true, revision: 1, activeStageId: riding.id,
      stages: [{...skeleton, status: 'completed', result: '已生成可运行文件'}, {...riding, status: 'in_progress'}], revisions: []}});
  store.message('s', 'techne', 'user', '制作动画', {activityId: 'a', inputKind: 'director'});
  let current = skeleton, now = 100;
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'techne'}, () => now, () => current);
  const first = steps.thinking(); store.appendMessage(first, '明确SVG场景'); now += 1000; steps.finish(first, 'completed');
  const tool = steps.tool({id: 'write', name: 'write', arguments: '{"path":"pelican.html"}'});
  steps.start(tool); now += 200; steps.finish(tool, 'completed', 'write\n文件已创建');
  current = riding;
  const second = steps.thinking(); store.appendMessage(second, '核对传动比例');
  return {store, steps, first, second, tool, now: () => now};
}

test('Actor 自然动作标题，阶段只有顶格主题色粗体标题，动作同级缩进两列且单请求计时', () => {
  const f = fixture();
  for (const view of ['logox', 'techne']) {
    const rows = buildStageRows(f.store.getSnapshot(), 's', view, 99, {a: true}, null);
    assert.match(rows.find(row => row.messageId === 'a')!.text, /正在核对骑行动作/);
    assert.ok(!rows.some(row => /\d\/\d/.test(row.text)));
    const firstHeading = rows.findIndex(row => row.messageId === f.first + '-stage');
    const heading = rows[firstHeading]!;
    assert.equal(rows[firstHeading - 1]!.tone, 'spacer');
    assert.equal(heading.text, skeleton.title);
    assert.ok(heading.segments!.filter(part => part.text === skeleton.title).every(part => part.bold && part.color === cast.techne!.color));
    assert.equal(heading.hover, undefined, '阶段无单独折叠或悬停卡片');
    assert.equal(rows.find(row => row.messageId === f.first)!.gutterCols, heading.gutterCols + 2);
    assert.equal(rows.find(row => row.messageId === f.tool)!.gutterCols, heading.gutterCols + 2);
    assert.match(rows.find(row => row.messageId === f.first)!.text, /Thought for 1s/);
    assert.match(rows.find(row => row.messageId === f.tool)!.text, /write pelican.html/);
    assert.ok(rows.find(row => row.messageId === f.second + '-stage'));
    assert.equal(rows.filter(row => row.messageId.endsWith('-stage')).length, 2);
    assert.ok(!rows.some(row => row.text.includes('核对传动比例')), '每条思考独立默认收起');
  }
});

test('展开某次 Thinking 不吞掉其它动作；灰底命中和标题复制保持，恢复原因只在其详情', () => {
  const f = fixture();
  f.store.updateMessage(f.first, {step: {...f.steps.get(f.first), note: '输出已满，缩小当前步骤后接续。'}});
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true}, null);
  assert.ok(rows.some(row => row.text === '明确SVG场景'));
  assert.ok(rows.some(row => row.text === '输出已满，缩小当前步骤后接续。'));
  assert.ok(!rows.some(row => row.text === '核对传动比例'));
  const body = rows.find(row => row.text === '明确SVG场景')!;
  assert.equal(body.bg, palette.toolExpanded);
  assert.equal(actionAt(body, 80)?.foldId, f.first);
  const tool = rows.find(row => row.messageId === f.tool)!;
  assert.notEqual(tool.bg, palette.toolExpanded, '同级工具不归到展开思考的灰底内');
  assert.equal(actionAt(tool, 80)?.foldId, 'a');
  const index = rows.findIndex(row => row.messageId === f.first + '-stage'), heading = rows[index]!;
  const selection = {anchor: contentPoint(rows, index, heading.gutterCols), focus: contentPoint(rows, index, heading.gutterCols + 16)};
  const copied = extractSelection(rows, selectionRange(rows, selection));
  const narrow = buildStageRows(f.store.getSnapshot(), 's', 'logox', 24, {a: true, [f.first]: true}, null);
  assert.equal(extractSelection(narrow, selectionRange(narrow, selection)), copied);
});

test('Denied 和 Error 使用运行时分类，红方块红粗体后缀，正常工具无异常后缀', () => {
  const f = fixture();
  for (const disposition of ['denied', 'error'] as const) {
    const id = f.steps.tool({id: disposition, name: 'read', arguments: '{"path":"README.md"}'});
    f.steps.finish(id, 'failed', 'read\n原始错误可展开查看', disposition);
    const row = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true}, null).find(row => row.messageId === id)!;
    assert.match(row.text, disposition === 'denied' ? /Denied$/ : /Error$/);
    assert.equal(row.segments!.find(part => part.selectionKey === id + ':icon')!.color, palette.error);
    const fault = row.segments!.find(part => part.selectionKey === id + ':fault')!;
    assert.equal(fault.color, palette.error); assert.equal(fault.bold, true);
    assert.ok(!row.text.includes('失败') && !row.text.includes('许可已拒绝'));
  }
  const row = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true}, null).find(row => row.messageId === f.tool)!;
  assert.ok(!row.text.includes('Error') && !row.text.includes('Denied'));
  const running = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true}, null).find(row => row.messageId === f.second)!;
  assert.match(decorateRow(running, f.now()).text, /Thinking/);
  assert.notDeepEqual(decorateRow(running, f.now()).segments, decorateRow(running, f.now() + 320).segments);
});

test('恢复时只显示自然状态，完成标题回到摘要，旧无阶段记录不伪造阶段', () => {
  const f = fixture();
  for (const stage of ['接续中', '调整中']) {
    f.store.activities.update('s', 'a', {stage});
    const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null);
    assert.ok(rows.find(row => row.messageId === 'a')!.text.includes(stage));
    assert.ok(!rows.some(row => /\d\/\d/.test(row.text)));
  }
  f.steps.close('completed');
  f.store.activities.update('s', 'a', {status: 'completed', summary: {title: '骑行动画已完成', report: '已落盘并核对骑行节奏', source: 'model'}});
  assert.match(buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null).find(row => row.messageId === 'a')!.text, /骑行动画已完成/);
  const store = new RuntimeStore();
  store.message('s', 'logox', 'assistant', '旧思考', {kind: 'thinking'});
  store.message('s', 'logox', 'notice', 'read\n文件内容', {kind: 'tool'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 99, {}, null);
  assert.ok(!rows.some(row => row.messageId.endsWith('-stage')));
  assert.ok(rows.some(row => /▮ read/.test(row.text)));
});

test('没有思考文本的纠偏请求仍显示并复制独立说明，原始消息与其它选区不受影响', () => {
  const f = fixture(), id = f.steps.thinking(); f.steps.finish(id, 'completed');
  const note = '本次只有思考，缩小当前步骤并先交付可核对成果。';
  f.store.updateMessage(id, {step: {...f.steps.get(id), note}});
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [id]: true}, null);
  const index = rows.findIndex(row => row.messageId === id + '-note'), row = rows[index]!;
  assert.equal(row.text, note); assert.equal(row.color, palette.muted);
  assert.equal(f.store.getSnapshot().messages.find(message => message.id === id)!.text, '', '恢复说明不拼入模型原文');
  const selection = {anchor: contentPoint(rows, index, row.gutterCols), focus: contentPoint(rows, index, row.gutterCols + 30)};
  const copied = extractSelection(rows, selectionRange(rows, selection));
  f.store.appendMessage(f.second, '继续核对');
  const narrow = buildStageRows(f.store.getSnapshot(), 's', 'logox', 24, {a: true, [id]: true}, null);
  assert.equal(extractSelection(narrow, selectionRange(narrow, selection)), copied);
  assert.ok(copied.length > 0);
});

test('实际阶段更新保存 Actor 自然标题与不可改写步骤快照，恢复后保留当前阶段', async () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: '动画任务', status: 'running', stage: '处理中', detail: ''});
  store.message('s', 'techne', 'user', '制作动画', {activityId: 'a', inputKind: 'director'});
  const context: ActorContext = {sessionId: 's', activityId: 'a', ownerId: 'techne', signal: new AbortController().signal, history: [],
    say() {}, report() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'test'};}, async permission() {return true;}};
  const progress = new TaskProgress(store, context), steps = new Steps(store, context, () => 100, () => progress.current());
  const initial = steps.thinking(); steps.finish(initial, 'completed');
  await progress.update({stages: [skeleton, riding], update: {id: skeleton.id, status: 'in_progress'}});
  const build = steps.thinking(); steps.finish(build, 'completed');
  await progress.update({update: {id: skeleton.id, status: 'completed', result: '文件已生成'}});
  await progress.update({update: {id: riding.id, status: 'in_progress'}});
  const resumed = new TaskProgress(store, {...context, progress: progress.snapshot()});
  const resumedSteps = new Steps(store, context, () => 200, () => resumed.current());
  const final = resumedSteps.thinking();
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 99, {a: true}, null);
  assert.match(rows.find(row => row.messageId === 'a')!.text, /正在核对骑行动作/);
  assert.equal(rows.find(row => row.messageId === initial + '-stage')!.text, '梳理目标与制定阶段');
  assert.equal(rows.find(row => row.messageId === build + '-stage')!.text, skeleton.title);
  assert.equal(rows.find(row => row.messageId === final + '-stage')!.text, riding.title);
  assert.equal(steps.get(initial).stage!.id, 'planning');
});

test('历史失败请求不借用后续活动详情，最终失败原因只归最后一次失败 Thinking', () => {
  const f = fixture(); f.steps.finish(f.first, 'failed');
  f.store.activities.update('s', 'a', {detail: '第 4 次往返'});
  let rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true}, null);
  assert.ok(!rows.some(row => row.messageId === f.first + '-error'));
  f.steps.finish(f.second, 'failed');
  f.store.activities.update('s', 'a', {status: 'failed', detail: '最终请求连接中断'});
  rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true, [f.second]: true}, null);
  assert.ok(!rows.some(row => row.messageId === f.first + '-error'));
  assert.equal(rows.find(row => row.messageId === f.second + '-error')!.text, '最终请求连接中断');
});

test('Actor 续做沿同角色任务链显示完整原目标，不把职能和“继续”当作任务目标', () => {
  const store = new RuntimeStore(), goal = '创建独立的鹈鹕骑车 SVG 动画。\n' + '保持车轮、踏板与地面运动同步，并保留细节。'.repeat(12);
  store.activities.create({sessionId: 's', activityId: 'original', ownerId: 'techne', kind: 'actor', title: '精工 · 构建匠人', status: 'failed', stage: '失败', detail: '输出耗尽'});
  store.message('s', 'techne', 'user', goal, {activityId: 'original', inputKind: 'director'});
  for (const [activityId, resumeTaskId] of [['resume', 'original'], ['resume-again', 'resume']] as const) {
    store.activities.create({sessionId: 's', activityId, resumeTaskId, ownerId: 'techne', kind: 'actor', title: '精工 · 构建匠人', status: 'running', stage: '调整中', detail: ''});
    store.message('s', 'techne', 'user', '继续', {activityId, inputKind: 'human'});
  }
  for (const view of ['logox', 'techne']) {
    const rows = buildStageRows(store.getSnapshot(), 's', view, 40, {'resume-again': true}, null);
    const goalRows = rows.filter(row => row.messageId === 'resume-again-goal');
    assert.equal(goalRows.map((row, index) => row.text + (index < goalRows.length - 1 && !row.softWrap ? '\n' : '')).join(''), '目标：' + goal);
    assert.ok(goalRows.length > 2, '完整目标折行呈现，不截断');
  }
});

test('Actor 目标链忽略其它角色、断链回落原消息，无消息与环形关系均安全回落', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'foreign', ownerId: 'kalon', kind: 'actor', title: 'Kalon职能', status: 'failed', stage: '失败', detail: ''});
  store.message('s', 'kalon', 'user', '其它角色的目标', {activityId: 'foreign'});
  for (const [activityId, resumeTaskId] of [['foreign-link', 'foreign'], ['broken-link', 'missing'], ['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a']] as const) {
    store.activities.create({sessionId: 's', activityId, resumeTaskId, ownerId: 'techne', kind: 'actor', title: '目标信息缺失', status: 'running', stage: '处理中', detail: ''});
    store.message('s', 'techne', 'assistant', '已有回复', {activityId});
  }
  store.message('s', 'techne', 'user', '自己的正式目标', {activityId: 'foreign-link'});
  store.message('s', 'techne', 'user', '断链后的正式目标', {activityId: 'broken-link'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 99, {'foreign-link': true, 'broken-link': true, 'cycle-a': true}, null);
  assert.equal(rows.find(row => row.messageId === 'foreign-link-goal')!.text, '目标：自己的正式目标');
  assert.equal(rows.find(row => row.messageId === 'broken-link-goal')!.text, '目标：断链后的正式目标');
  assert.equal(rows.find(row => row.messageId === 'cycle-a-goal')!.text, '目标：目标信息缺失');
});
