import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {cast} from '../src/actors/ensemble.js';
import {palette} from '../src/tui/cards.js';
import {thinkingRequests} from '../src/tui/thinking-groups.js';
import {buildStageRows} from '../src/tui/stage.js';
import {decorateRow} from '../src/tui/row-presentation.js';
import {actionAt} from '../src/tui/scene.js';
import {contentPoint, selectionRange, type ContentSelection} from '../src/tui/selection.js';
import {extractSelection} from '../src/tui/viewport.js';

test('请求投影按快照缓存，界面操作复用时钟，流式只更新该请求估算 Tokens', () => {
  const f = fixture(), id = f.steps.thinking(); f.store.appendMessage(id, '先检查');
  const snapshot = f.store.getSnapshot();
  const header = (folds: Record<string, boolean>, hovered: string | null, width = 99) =>
    buildStageRows(snapshot, 's', 'logox', width, folds, hovered).find(row => row.messageId === id)!;
  const step = header({}, null).animation!.step;
  assert.equal(header({[id]: true}, id).animation!.step, step);
  assert.equal(header({}, null, 49).animation!.step, step);
  const tokens = header({}, null).displayText;
  f.store.appendMessage(id, '再确认');
  let updated = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null).find(row => row.messageId === id)!;
  assert.equal(updated.animation!.step, step); assert.notEqual(updated.displayText, tokens);
  f.steps.close('failed');
  updated = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null).find(row => row.messageId === id)!;
  assert.equal(updated.animation!.step!.state, 'failed');
  assert.ok(!buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, null).some(row => row.messageId === id));
  assert.ok(!buildStageRows(f.store.getSnapshot(), 'other', 'logox', 99, {}, null).some(row => row.messageId === id));
});

test('卡片背景保持纯净静态，正文与内层灰底不产生重绘', () => {
  const f = fixture('techne'), id = f.steps.thinking(); f.store.appendMessage(id, '中文🙂 正文');
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {a: true, [id]: true}, null);
  const raw = rows.find(row => row.messageId === 'a')!;
  const early = decorateRow(raw, 100000), later = decorateRow(raw, 102000);
  assert.equal(early.bg, raw.bg, '卡片背景保持稳定静态');
  assert.equal(later.bg, raw.bg, '不同时间点背景绝对不发生抖动重绘');
  assert.equal(early.displayText, raw.displayText); assert.deepEqual(early.selectionCells, raw.selectionCells);
  assert.equal(decorateRow(raw, 100000, false), raw, '关闭动效直接返回原行');
  const thinkingBody = rows.find(row => row.text === '中文🙂 正文')!;
  const decorated = decorateRow(thinkingBody, 100000);
  assert.equal(decorated.bg, thinkingBody.bg, '内层灰底不跟随 Actor 呼吸');
  assert.equal(decorated.displayText, thinkingBody.displayText);
});

function fixture(ownerId = 'logox') {
  const store = new RuntimeStore(); let now = 100;
  store.activities.create({sessionId: 's', ownerId, activityId: 'a', kind: ownerId === 'logox' ? 'director' : 'actor', title: '工作', status: 'running', stage: '执行', detail: ''});
  return {store, steps: new Steps(store, {sessionId: 's', ownerId, activityId: 'a'}, () => now), advance: (ms: number) => {now += ms;}, now: () => now,
    requests: () => thinkingRequests(store.getSnapshot().messages)};
}

test('每次思考独立收起并计时，工具是同级卡片，工具等待与执行不计入思考时间', () => {
  const f = fixture(), first = f.steps.thinking();
  f.store.appendMessage(first, '先检查'); f.advance(500); f.steps.finish(first, 'completed');
  const tool = f.steps.tool({id: 'read', name: 'read', arguments: '{"path":"README.md"}'});
  const resume = f.steps.wait(tool, '等待审批'); f.advance(1000);
  assert.equal(f.requests().get(first)!.step.state, 'completed');
  assert.equal(f.requests().get(first)!.step.elapsedMs, 500); resume();
  f.steps.start(tool); f.advance(3000); f.steps.finish(tool, 'failed', 'read\n暂时失败');
  const second = f.steps.thinking(); f.store.appendMessage(second, '再确认'); f.advance(800); f.steps.finish(second, 'completed'); f.steps.endGroup('completed');
  f.store.message('s', 'logox', 'assistant', '完成', {activityId: 'a'});
  const request = f.requests().get(first)!;
  assert.equal(request.step.elapsedMs, 500); assert.equal(request.tokens, 3); assert.equal(request.step.state, 'completed');
  assert.equal(f.requests().get(second)!.step.elapsedMs, 800);
  let rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null);
  assert.equal(rows.filter(row => row.text.includes('Thought for')).length, 2);
  assert.ok(rows.some(row => row.text.includes('README.md')));
  assert.ok(!rows.some(row => row.text.includes('先检查')));
  const header = rows.find(row => row.messageId === first)!;
  assert.match(header.displayText!, /▮ Thought for 1s · 3 Tokens/);
  assert.ok(!header.displayText!.includes('≈'));
  assert.equal(header.segments!.find(segment => segment.selectionKey === first + ':icon')!.color, palette.muted, '工具错误被恢复后父卡灰色');
  rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {[first]: true, [tool]: true, [second]: true}, null);
  assert.ok(rows.findIndex(row => row.text === '先检查') < rows.findIndex(row => row.text.includes('README.md')));
  assert.ok(rows.findIndex(row => row.text === '暂时失败') < rows.findIndex(row => row.text === '再确认'));
  const inner = rows.find(row => row.messageId === tool)!;
  assert.equal(inner.segments!.find(segment => segment.selectionKey === tool + ':icon')!.color, palette.error);
  assert.equal(inner.segments!.find(segment => segment.selectionKey === tool + ':title')!.color, palette.muted);
  assert.equal(inner.segments!.find(segment => segment.selectionKey === tool + ':status')!.color, palette.muted);
  const result = rows.find(row => row.text === '暂时失败')!;
  assert.equal(actionAt(result, 80)?.foldId, tool, '展开工具整块灰底可关闭');
  f.advance(10000); assert.equal(f.requests().get(first)!.step.elapsedMs, 500);
  const next = f.steps.thinking();
  assert.notEqual(f.steps.get(next).groupId, f.steps.get(first).groupId, '正文后重新建组');
});

test('Thinking 点阵在标题前，点阵和流光取角色主题色；失败红方块、停止灰方块、等待静止', () => {
  const f = fixture('techne'), id = f.steps.thinking(), theme = '#59a1e8';
  const roles = {...cast, techne: {...cast.techne!, color: theme}};
  let row = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, null, {}, roles).find(row => row.messageId === id)!;
  const early = decorateRow(row, f.now()), later = decorateRow(row, f.now() + 320);
  assert.match(early.displayText!, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking\.\.\. ·/);
  assert.equal(early.segments!.find(segment => segment.selectionKey === id + ':icon')!.color, theme);
  assert.notDeepEqual(early.segments, later.segments);
  const hovered = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, id, {}, roles).find(row => row.messageId === id)!;
  for (const now of [f.now(), f.now() + 320]) {
    const highlighted = decorateRow(hovered, now);
    assert.ok(highlighted.segments!.filter(segment => segment.selectionKey === id + ':title').every(segment => segment.color === theme), 'Thinking 悬停高亮不被流光下一帧覆盖');
  }
  for (const segment of early.segments!.filter(segment => segment.selectionKey === id + ':title')) {
    const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16));
    assert.ok(rgb(segment.color!).every((channel, index) => channel >= Math.min(rgb(theme)[index]!, rgb(palette.muted)[index]!) && channel <= Math.max(rgb(theme)[index]!, rgb(palette.muted)[index]!)));
  }
  const wait = f.steps.wait(id, '等待重试');
  row = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, null, {}, roles).find(row => row.messageId === id)!;
  assert.deepEqual(decorateRow(row, f.now()).segments, decorateRow(row, f.now() + 400).segments); wait();
  f.advance(1000); f.steps.finish(id, 'failed'); f.steps.endGroup('failed');
  row = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, null).find(row => row.messageId === id)!;
  assert.match(row.displayText!, /▮ Thought for/); assert.equal(row.segments!.find(segment => segment.selectionKey === id + ':icon')!.color, palette.error);
  assert.equal(row.segments!.find(segment => segment.selectionKey === id + ':status')!.color, palette.muted, 'Thinking 错误仅方块标红，耗时保持正常颜色');
  const stopped = f.steps.thinking(); f.steps.close('cancelled');
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {[stopped]: true}, null);
  assert.equal(rows.find(row => row.messageId === stopped)!.segments!.find(segment => segment.selectionKey === stopped + ':icon')!.color, palette.muted);
  assert.ok(rows.some(row => row.text === '已停止'));
});

test('工具指示始终为灰方块，异常红方块，标题保持浅灰且等待不动画', () => {
  const f = fixture('techne');
  const tool = f.steps.tool({id: 'read', name: 'read', arguments: '{"path":"README.md"}'});
  const header = (id: string, open = false, hovered: string | null = null) => buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {[id]: open}, hovered).find(row => row.messageId === id)!;
  let row = header(tool);
  assert.match(row.displayText!, /▮ read README.md/);
  f.steps.start(tool); f.advance(1200);
  row = header(tool);
  const running = decorateRow(row, f.now());
  assert.match(running.displayText!, /▮ read README.md/);
  assert.equal(running.segments!.find(segment => segment.selectionKey === tool + ':icon')!.color, palette.muted);
  assert.equal(running.segments!.find(segment => segment.selectionKey === tool + ':title')!.color, palette.muted);
  const later = decorateRow(row, f.now() + 320);
  assert.equal(later.displayText!.length, running.displayText!.length, '工具时钟和点阵不改变布局槽位');
  f.steps.finish(tool, 'completed');
  for (const state of ['completed', 'failed', 'cancelled'] as const) {
    const id = state === 'completed' ? tool : f.steps.tool({id: state, name: 'shell', arguments: '{}'});
    if (id !== tool) f.steps.finish(id, state);
    for (const open of [false, true]) {
      row = header(id, open);
      assert.match(row.displayText!, /▮ (read|shell)/);
      assert.ok(!/[✓!×]/.test(row.displayText!));
      assert.equal(row.segments!.find(segment => segment.selectionKey === id + ':icon')!.color, state === 'failed' ? palette.error : palette.muted);
      assert.equal(row.segments!.find(segment => segment.selectionKey === id + ':title')!.color, palette.muted);
      assert.equal(header(id, open, id).segments!.find(segment => segment.selectionKey === id + ':title')!.color, cast.techne!.color, '悬停恢复执行者主题色');
    }
  }
});

test('旧记录逐请求展示而不猜阶段；展开工具选区跨追加和缩放保留', () => {
  const store = new RuntimeStore();
  const one = store.message('s', 'logox', 'assistant', '第一段思考', {kind: 'thinking'});
  const tool = store.message('s', 'logox', 'notice', 'read\n可复制的工具结果 abcdefghijklmnopqrstuvwxyz', {kind: 'tool'});
  store.message('s', 'logox', 'assistant', '第二段思考', {kind: 'thinking'});
  store.message('s', 'logox', 'assistant', '正文');
  store.message('s', 'logox', 'assistant', '后续思考', {kind: 'thinking'});
  const original = store.getSnapshot(); assert.equal(thinkingRequests(original.messages).size, 3);
  const rows = buildStageRows(original, 's', 'logox', 79, {[one]: true, [tool]: true}, null);
  const index = rows.findIndex(row => row.text.includes('可复制'));
  const selected: ContentSelection = {anchor: contentPoint(rows, index, rows[index]!.gutterCols), focus: contentPoint(rows, index, rows[index]!.gutterCols + 20)};
  const text = extractSelection(rows, selectionRange(rows, selected));
  store.message('s', 'logox', 'assistant', '追加');
  const narrow = buildStageRows(store.getSnapshot(), 's', 'logox', 25, {[one]: true, [tool]: true}, null);
  assert.equal(extractSelection(narrow, selectionRange(narrow, selected)), text);
  assert.ok(original.messages.every(message => !message.step), '不回写旧记录');
});
