import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {palette} from '../src/tui/appearance/theme.js';
import {decorateRow} from '../src/tui/timeline/row-presentation.js';
import {actionAt} from '../src/tui/timeline/scene.js';
import {expandedTint} from '../src/tui/appearance/colors.js';
import {cast} from '../src/actors/ensemble.js';
import {contentPoint, selectionRange} from '../src/tui/timeline/selection.js';
import {extractSelection} from '../src/tui/timeline/viewport.js';
import type {ActorContext} from '../src/actors/ensemble.js';

// CJK fixtures exercise wrapping, selection and historical stage snapshots.
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
  const tool = steps.tool({id: 'write', name: 'write', arguments: '{"file_path":"pelican.html"}'});
  steps.start(tool); now += 200; steps.finish(tool, 'completed', 'write\n文件已创建');
  current = riding;
  const second = steps.thinking(); store.appendMessage(second, '核对传动比例');
  return {store, steps, first, second, tool, now: () => now};
}

test('the card shows the live state, never the label of a legacy stage snapshot, and legacy snapshots create no body headings', () => {
  const f = fixture();
  for (const view of ['logox', 'techne']) {
    const rows = buildStageRows(f.store.getSnapshot(), 's', view, 99, {a: true}, null);
    assert.match(rows.find(row => row.messageId === 'a')!.text, /完成鹈鹕骑车动画 · Thinking/, 'a request is generating: the thinking state');
    assert.doesNotMatch(rows.find(row => row.messageId === 'a')!.text, /正在核对骑行动作/, 'the legacy active-stage label is no longer a subtitle');
    assert.ok(!rows.some(row => /\d\/\d/.test(row.text)));
    assert.equal(rows.filter(row => row.messageId.endsWith('-stage')).length, 0);
    assert.equal(rows.filter(row => /^[·▸▾] Thinking|^[▸▾] Thought/.test(row.text) && row.messageId === f.first).length, 1, 'one live thinking row, no per-request rows');
    assert.ok(rows.some(row => row.messageId === f.first && /^· Thinking/.test(row.text)));
    assert.match(rows.find(row => row.messageId === f.tool)!.text, /write[\s(]pelican\.html/i);
    assert.ok(!rows.some(row => row.text.includes('核对传动比例')));
    assert.equal(f.steps.get(f.first).stage?.id, skeleton.id, 'Historical step snapshots remain unchanged');
  }
});

test('expanding one Thinking preserves sibling actions, selection and local recovery notes', () => {
  const f = fixture();
  f.store.updateMessage(f.first, {step: {...f.steps.get(f.first), note: '输出已满，缩小当前步骤后接续。'}});
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true}, null);
  assert.ok(rows.some(row => row.text.includes('明确SVG场景')));
  assert.ok(rows.some(row => row.text === '输出已满，缩小当前步骤后接续。'));
  assert.ok(rows.some(row => row.text.includes('核对传动比例')), 'every thought of the round is in the one body');
  const body = rows.find(row => row.text.includes('明确SVG场景'))!;
  assert.equal(body.bg, expandedTint(cast.techne!.color, 2), 'thinking inside an open actor card is depth 2');
  assert.equal(actionAt(body, 80)?.foldId, f.first);
  const tool = rows.find(row => row.messageId === f.tool)!;
  assert.equal(actionAt(tool, tool.gutterCols)?.foldId, f.tool, 'the tool row text belongs to the tool');
  assert.equal(actionAt(tool, 80)?.foldId, 'a', 'empty cells beside a folded row fall through to the actor card');
  const index = rows.findIndex(row => row.messageId === f.first), heading = rows[index]!;
  const selection = {anchor: contentPoint(rows, index, heading.gutterCols), focus: contentPoint(rows, index, heading.gutterCols + 16)};
  const copied = extractSelection(rows, selectionRange(rows, selection));
  const narrow = buildStageRows(f.store.getSnapshot(), 's', 'logox', 24, {a: true, [f.first]: true}, null);
  assert.equal(extractSelection(narrow, selectionRange(narrow, selection)), copied);
});

test('runtime dispositions control Denied and Error styling without marking successful tools', () => {
  const f = fixture();
  for (const disposition of ['denied', 'error'] as const) {
    const id = f.steps.tool({id: disposition, name: 'read', arguments: '{"file_path":"README.md"}'});
    f.steps.finish(id, 'failed', 'read\n原始错误可展开查看', disposition);
    const row = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true}, null).find(row => row.messageId === id)!;
    assert.match(row.text, disposition === 'denied' ? /Denied · 原始错误可展开查看 · 0\.0s/ : /Read\(README\.md\) · 原始错误可展开查看 · 0\.0s/);
    assert.ok(!/Error/.test(row.text), 'no trailing Error label');
    assert.equal(row.segments!.find(part => part.selectionKey === id + ':icon')!.color, palette.error);
    const fault = row.segments!.find(part => part.selectionKey === id + ':fault');
    if (disposition === 'denied') {assert.equal(fault!.color, palette.error); assert.equal(fault!.bold, true);} else assert.ok(!fault);
    assert.ok(!row.text.includes('失败') && !row.text.includes('许可已拒绝'));
  }
  const row = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true}, null).find(row => row.messageId === f.tool)!;
  assert.ok(!row.text.includes('Error') && !row.text.includes('Denied'));
  const running = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true}, null).find(row => row.messageId === f.first)!;
  assert.match(decorateRow(running, f.now()).text, /Thinking/);
  assert.notDeepEqual(decorateRow(running, f.now()).segments, decorateRow(running, f.now() + 320).segments);
});

test('recovery uses runtime status and terminal titles use reports without inventing legacy stages', () => {
  const f = fixture();
  for (const stage of ['Resuming', 'Adjusting']) {
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
  assert.ok(rows.some(row => /▮\s*read/i.test(row.text)));
});

test('empty reasoning can show a separate recovery note without changing original text or selections', () => {
  const f = fixture(), id = f.steps.thinking(); f.steps.finish(id, 'completed');
  const note = '本次只有思考，缩小当前步骤并先交付可核对成果。';
  f.store.updateMessage(id, {step: {...f.steps.get(id), note}});
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true}, null);
  const index = rows.findIndex(row => row.messageId === id + '-note'), row = rows[index]!;
  assert.equal(row.text, note); assert.equal(row.color, palette.muted);
  assert.equal(f.store.getSnapshot().messages.find(message => message.id === id)!.text, '', 'Recovery notes do not alter original model text');
  const selection = {anchor: contentPoint(rows, index, row.gutterCols), focus: contentPoint(rows, index, row.gutterCols + 30)};
  const copied = extractSelection(rows, selectionRange(rows, selection));
  f.store.appendMessage(f.second, '继续核对');
  const narrow = buildStageRows(f.store.getSnapshot(), 's', 'logox', 24, {a: true, [f.first]: true}, null);
  assert.equal(extractSelection(narrow, selectionRange(narrow, selection)), copied);
  assert.ok(copied.length > 0);
});

test('progress labels never draw on the card; the live state appears only while running and disappears on every terminal outcome', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const store = new RuntimeStore();
    store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'Animation task', status: 'running', stage: 'Working', detail: ''});
    store.message('s', 'techne', 'user', 'Create an animation', {activityId: 'a', inputKind: 'director'});
    const context: ActorContext = {sessionId: 's', activityId: 'a', ownerId: 'techne', signal: new AbortController().signal, history: [],
      say() {}, report() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'test'};}, async permission() {return true;}};
    const steps = new Steps(store, context, () => 100);
    const initial = steps.thinking(); steps.finish(initial, 'completed');
    store.activities.update('s', 'a', {progress: {label: 'Building animation'}});
    store.activities.update('s', 'a', {progress: {label: 'Comparing screenshots'}});
    steps.thinking();
    for (const view of ['logox', 'techne']) {
      const rows = buildStageRows(store.getSnapshot(), 's', view, 99, {a: true}, null);
      assert.match(rows.find(row => row.messageId === 'a')!.text, /Animation task · Thinking/);
      assert.doesNotMatch(rows.find(row => row.messageId === 'a')!.text, /Comparing screenshots/, 'a progress label is not the subtitle');
      assert.ok(!rows.some(row => row.messageId.endsWith('-stage')));
      assert.ok(!rows.some(row => row.messageId === initial));
      assert.equal(steps.get(initial).stage, undefined);
    }
    steps.close(status);
    store.activities.update('s', 'a', {status, summary: {title: 'Report delivered', report: 'Verification remains separate.', source: 'model'}});
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 99, {}, null);
    assert.ok(!rows.some(row => row.text.includes('Comparing screenshots') || row.text.includes('Thinking ·')));
    assert.deepEqual(store.activities.get('s', 'a')?.progress, {label: 'Comparing screenshots'}, 'History is not rewritten as accepted/completed');
  }
});

test('legacy progress and empty completed Thinking never leave a heading before a Director reply', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'director', title: 'Logox', status: 'completed', stage: 'Done', detail: '',
    progress: {planned: true, revision: 1, activeStageId: riding.id, stages: [{...riding, status: 'in_progress'}], revisions: []}});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: 'logox'}, () => 100, () => riding);
  const empty = steps.thinking(); steps.finish(empty, 'completed');
  store.message('s', 'logox', 'assistant', 'A normal conversational reply.', {activityId: 'a'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 99, {}, null);
  assert.ok(rows.some(row => row.text.includes('A normal conversational reply.')));
  assert.ok(!rows.some(row => row.messageId.endsWith('-stage') || row.text.includes(riding.title)));
  assert.equal(steps.get(empty).stage?.id, riding.id);
});

test('a failed round keeps one thinking row; only the activity failure owns the error text', () => {
  const f = fixture(); f.steps.finish(f.first, 'failed');
  f.store.activities.update('s', 'a', {detail: '第 4 次往返'});
  let rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true}, null);
  assert.ok(!rows.some(row => row.messageId.endsWith('-error')));
  f.steps.finish(f.second, 'failed');
  f.store.activities.update('s', 'a', {status: 'failed', detail: '最终请求连接中断'});
  rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [f.first]: true}, null);
  assert.equal(rows.filter(row => row.messageId === f.first).length, 1);
  assert.ok(rows.find(row => row.messageId === 'a')!.text.includes('最终请求连接中断'), 'the header owns the one-line failure');
  assert.equal(rows.find(row => row.messageId === 'a-error'), undefined, 'the body does not repeat the title');
});

test('actor resume follows same-owner links to the complete original goal', () => {
  const store = new RuntimeStore(), goal = '创建独立的鹈鹕骑车 SVG 动画。\n' + '保持车轮、踏板与地面运动同步，并保留细节。'.repeat(12);
  store.activities.create({sessionId: 's', activityId: 'original', ownerId: 'techne', kind: 'actor', title: '构建匠人', status: 'failed', stage: '失败', detail: '输出耗尽'});
  store.message('s', 'techne', 'user', goal, {activityId: 'original', inputKind: 'director'});
  for (const [activityId, resumeTaskId] of [['resume', 'original'], ['resume-again', 'resume']] as const) {
    store.activities.create({sessionId: 's', activityId, resumeTaskId, ownerId: 'techne', kind: 'actor', title: '构建匠人', status: 'running', stage: '调整中', detail: ''});
    store.message('s', 'techne', 'user', '继续', {activityId, inputKind: 'human'});
  }
  for (const view of ['logox', 'techne']) {
    const rows = buildStageRows(store.getSnapshot(), 's', view, 40, {'resume-again': true, 'resume-again-goal': true}, null);
    assert.ok(rows.some(row => row.text.includes('Task from ◈ Logox')));
    const goalRows = rows.filter(row => row.messageId === 'resume-again-goal-body');
    assert.equal(goalRows.map((row, index) => row.text + (index < goalRows.length - 1 && !row.softWrap ? '\n' : '')).join(''), goal);
    assert.ok(goalRows.length > 2, 'The full goal wraps without truncation');
  }
});

test('actor goal lookup safely handles foreign owners, broken links, missing input and cycles', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'foreign', ownerId: 'kalon', kind: 'actor', title: 'Kalon职能', status: 'failed', stage: '失败', detail: ''});
  store.message('s', 'kalon', 'user', '其它角色的目标', {activityId: 'foreign'});
  for (const [activityId, resumeTaskId] of [['foreign-link', 'foreign'], ['broken-link', 'missing'], ['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a']] as const) {
    store.activities.create({sessionId: 's', activityId, resumeTaskId, ownerId: 'techne', kind: 'actor', title: '目标信息缺失', status: 'running', stage: '处理中', detail: ''});
    store.message('s', 'techne', 'assistant', '已有回复', {activityId});
  }
  store.message('s', 'techne', 'user', '自己的正式目标', {activityId: 'foreign-link'});
  store.message('s', 'techne', 'user', '断链后的正式目标', {activityId: 'broken-link'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 99, {
    'foreign-link': true, 'foreign-link-goal': true,
    'broken-link': true, 'broken-link-goal': true,
    'cycle-a': true, 'cycle-a-goal': true,
  }, null);
  assert.equal(rows.find(row => row.messageId === 'foreign-link-goal-body')!.text, '自己的正式目标');
  assert.equal(rows.find(row => row.messageId === 'broken-link-goal-body')!.text, '断链后的正式目标');
  assert.equal(rows.find(row => row.messageId === 'cycle-a-goal-body')!.text, '目标信息缺失');
});
