import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {cast} from '../src/actors/ensemble.js';
import {palette} from '../src/tui/appearance/theme.js';
import {expandedTint, faintColor} from '../src/tui/appearance/colors.js';
import {thinkingRequests} from '../src/tui/timeline/thinking-groups.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {decorateRow} from '../src/tui/timeline/row-presentation.js';
import {contentPoint, selectionRange, type ContentSelection} from '../src/tui/timeline/selection.js';
import {extractSelection} from '../src/tui/timeline/viewport.js';

type Rows = ReturnType<typeof buildStageRows>;
const thinkingRow = (rows: Rows, id: string) => rows.find(row => row.messageId === id);
const anyThinkingRow = (rows: Rows) => rows.find(row => /^[·▸▾] Thinking|^[▸▾] Thought/.test(row.text));

function fixture(ownerId = 'logox') {
  const store = new RuntimeStore(); let now = 100;
  store.activities.create({sessionId: 's', ownerId, activityId: 'a', kind: ownerId === 'logox' ? 'director' : 'actor', title: '工作', status: 'running', stage: '执行', detail: ''});
  return {store, steps: new Steps(store, {sessionId: 's', ownerId, activityId: 'a'}, () => now), advance: (ms: number) => {now += ms;}, now: () => now,
    requests: () => thinkingRequests(store.getSnapshot().messages)};
}

test('一轮只有一行 Thinking：运行中携带实时时钟，结束后为静态摘要', () => {
  const f = fixture(), id = f.steps.thinking(); f.store.appendMessage(id, '先检查');
  const snapshot = f.store.getSnapshot();
  const rowsOf = (folds: Record<string, boolean>, hovered: string | null, width = 99) => buildStageRows(snapshot, 's', 'logox', width, folds, hovered);
  const row = thinkingRow(rowsOf({}, null), id)!;
  assert.equal(row.animation!.step!.state, 'running');
  assert.equal(thinkingRow(rowsOf({[id]: true}, id), id)!.animation!.step!.state, 'running');
  assert.match(row.displayText!, /^· Thinking · /, '运行中：角色思考点阵 + Thinking + 实时时钟');
  f.store.appendMessage(id, '再确认');
  f.steps.close('failed');
  const done = thinkingRow(buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null), id)!;
  assert.match(done.displayText!, /▸ Thought for \d+s · \d+ tokens/);
  assert.ok(!done.animation?.step, '结束后没有实时时钟');
  assert.ok(!thinkingRow(buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, null), id));
  assert.ok(!thinkingRow(buildStageRows(f.store.getSnapshot(), 'other', 'logox', 99, {}, null), id));
});

test('展开后每次思考一段：以 ∴ 开头悬挂缩进、没有时长列，正文次要色斜体；背景只是所属角色色的淡染', () => {
  const f = fixture('techne'), id = f.steps.thinking(); f.store.appendMessage(id, '中文🙂 正文');
  f.advance(21000); f.steps.finish(id, 'completed'); f.steps.endGroup('completed');
  const rows = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {[id]: true}, null);
  const head = thinkingRow(rows, id)!;
  assert.match(head.displayText!, /▾ Thought for 21s/);
  assert.equal(head.bg, expandedTint(cast.techne!.color, 1), '展开背景 = 所属角色色 6% 混入背景（深度 1）');
  const body = rows.find(row => row.text.includes('中文🙂 正文'))!;
  assert.equal(body.bg, head.bg);
  assert.match(body.text, /^∴ 中文🙂 正文/);
  assert.ok(!/\d+s/.test(body.text), '没有逐段时长列');
  assert.equal(body.segments!.find(segment => segment.text === '∴ ')!.color, faintColor(), '∴ 为淡色标记');
  const text = body.segments!.find(segment => segment.text === '中文🙂 正文')!;
  assert.equal(text.color, palette.muted); assert.equal(text.italic, true);
  assert.equal(decorateRow(body, 100000), body, '没有动画的正文不重绘');
  const folded = buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, null);
  assert.equal(thinkingRow(folded, id)!.bg, undefined, '折叠行没有背景色');
});

test('无 token 的空思考完成后不展示，运行中的空思考保持可见（对齐 Claude Code 与 Pi）', () => {
  const f = fixture();
  const blank = f.steps.thinking(); f.advance(8000); f.steps.finish(blank, 'completed'); f.steps.endGroup('completed');
  let rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null);
  assert.ok(!thinkingRow(rows, blank), '完成的空思考不生成空行');

  const running = f.steps.thinking(); f.advance(2000);
  rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null);
  assert.ok(anyThinkingRow(rows)?.displayText?.includes('Thinking'), '运行中的空思考仍有一行');

  f.steps.finish(running, 'completed'); f.steps.endGroup('completed');
  rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {}, null);
  assert.ok(!anyThinkingRow(rows), '完成后无 token 自动消失');
});

test('一轮的所有思考合并为标题下的一行；工具是同级卡片，工具等待与执行不计入思考时间', () => {
  const f = fixture(), first = f.steps.thinking();
  f.store.appendMessage(first, '先检查'); f.advance(500); f.steps.finish(first, 'completed');
  const tool = f.steps.tool({id: 'read', name: 'read', arguments: '{"file_path":"README.md"}'});
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
  assert.equal(rows.filter(row => row.text.includes('Thought')).length, 1, '整轮只有一行思考');
  const headerAt = rows.findIndex(row => row.messageId.endsWith('-who'));
  assert.equal(rows[headerAt + 1]!.messageId, first, '思考行紧贴标题');
  assert.match(rows[headerAt + 1]!.displayText!, /▸ Thought 2 times · 1s · \d+ tokens/);
  assert.ok(rows.some(row => row.text.includes('README.md')));
  assert.ok(!rows.some(row => row.text.includes('先检查')));
  rows = buildStageRows(f.store.getSnapshot(), 's', 'logox', 99, {[first]: true, [tool]: true}, null);
  assert.ok(rows.findIndex(row => row.text.includes('先检查')) < rows.findIndex(row => row.text.includes('再确认')));
  const inner = rows.find(row => row.messageId === tool)!;
  assert.equal(inner.segments!.find(segment => segment.selectionKey === tool + ':icon')!.color, palette.error);
  assert.equal(inner.segments!.find(segment => segment.selectionKey === tool + ':title')!.color, palette.fg, '展开的标题用正常前景色');
  assert.equal(inner.segments!.find(segment => segment.selectionKey === tool + ':status')!.color, faintColor(), '耗时靠右、保持淡色；失败由图标与 Error 标签表达');
  f.advance(10000); assert.equal(f.requests().get(first)!.step.elapsedMs, 500);
  const next = f.steps.thinking();
  assert.notEqual(f.steps.get(next).groupId, f.steps.get(first).groupId, '正文后重新建组');
});

test('实时思考：标题行显示 Thinking 与旋转点阵，思考行保留并流光；点阵取角色色', () => {
  const f = fixture('techne'), id = f.steps.thinking(), theme = '#59a1e8';
  const frames = ['▖', '▌', '▘', '▀'];
  const roles = {...cast, techne: {...cast.techne!, color: theme, thinkingAnimation: frames}};
  const rowsOf = (hovered: string | null = null) => buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {}, hovered, {}, roles);
  const rows = rowsOf();
  const header = rows.find(row => row.messageId.endsWith('-who'))!;
  assert.equal(header.railGlyph, roles.techne!.symbol);
  const early = decorateRow(header, f.now()), later = decorateRow(header, f.now() + 320);
  assert.match(early.displayText!, /^Techne · [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*$/, 'no stage yet: spinner only, no Thinking, no clock');
  assert.equal(early.segments!.find(segment => segment.selectionKey?.endsWith(':activity_icon'))!.color, theme);
  assert.notDeepEqual(early.segments, later.segments);
  const row = thinkingRow(rows, id)!;
  const glyph = decorateRow(row, f.now()).displayText!.trimStart()[0]!;
  assert.ok(frames.includes(glyph), '运行中思考行使用角色自己的思考动画帧：' + glyph);
  assert.match(decorateRow(row, f.now()).displayText!, /^\S Thinking · /);
  const hovered = thinkingRow(rowsOf(id), id)!;
  for (const now of [f.now(), f.now() + 320]) {
    const highlighted = decorateRow(hovered, now);
    assert.ok(highlighted.segments!.filter(segment => segment.selectionKey === id + ':title').every(segment => segment.color === theme), '悬停高亮不被流光下一帧覆盖');
  }
  for (const segment of decorateRow(row, f.now()).segments!.filter(segment => segment.selectionKey === id + ':title')) {
    const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16));
    assert.ok(rgb(segment.color!).every((channel, index) => channel >= Math.min(rgb(theme)[index]!, rgb(palette.fg)[index]!) && channel <= Math.max(rgb(theme)[index]!, rgb(palette.fg)[index]!)));
  }
  f.advance(1000); f.steps.finish(id, 'completed'); f.store.appendMessage(id, '想完了'); f.steps.endGroup('completed');
  assert.ok(rowsOf().find(row => row.messageId.endsWith('-who'))!.animation, 'between steps the running activity keeps the header spinner');
  f.store.activities.update('s', 'a', {status: 'completed'});
  const finished = rowsOf().find(row => row.messageId.endsWith('-who'))!;
  assert.ok(!finished.animation, '活动结束后标题行不再显示旋转点阵');
});

test('工具运行中呈现角色流光动效，完成恢复浅灰，异常红方块；展开后 ▾ 加正常前景色标题', () => {
  const f = fixture('techne');
  const tool = f.steps.tool({id: 'read', name: 'read', arguments: '{"file_path":"README.md"}'});
  const header = (id: string, open = false, hovered: string | null = null) => buildStageRows(f.store.getSnapshot(), 's', 'techne', 99, {[id]: open}, hovered).find(row => row.messageId === id)!;
  let row = header(tool);
  assert.match(row.displayText!, /▮\s*read[\s(]README\.md/i);
  f.steps.start(tool); f.advance(1200);
  row = header(tool);
  const running = decorateRow(row, f.now());
  assert.match(running.displayText!, /▮\s*read[\s(]README\.md/i);
  assert.ok(running.segments!.find(segment => segment.selectionKey === tool + ':icon')!.color);
  assert.notEqual(running.segments!.find(segment => segment.selectionKey === tool + ':title')!.color, palette.muted, '运行中呈现角色流光渐变');
  const later = decorateRow(row, f.now() + 320);
  assert.equal(later.displayText!.length, running.displayText!.length, '工具时钟和点阵不改变布局槽位');
  f.steps.finish(tool, 'completed');
  for (const state of ['completed', 'failed', 'cancelled'] as const) {
    const id = state === 'completed' ? tool : f.steps.tool({id: state, name: 'shell', arguments: '{}'});
    if (id !== tool) f.steps.finish(id, state);
    for (const open of [false, true]) {
      row = header(id, open);
      assert.match(row.displayText!, open ? /▾\s*(read|shell)/i : /▮\s*(read|shell)/i);
      assert.ok(!/[✓!×]/.test(row.displayText!));
      const icon = row.segments!.find(segment => segment.selectionKey === id + ':icon')!.color;
      assert.equal(icon, state === 'failed' ? palette.error : open ? palette.fg : palette.muted);
      assert.equal(row.segments!.find(segment => segment.selectionKey === id + ':title')!.color, open ? palette.fg : palette.muted, open ? '展开的标题更亮一档' : '完成恢复浅灰');
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
