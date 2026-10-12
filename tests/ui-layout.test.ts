import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {cursorAt, emptyDraft, erase, graphemes, inputViewport, insert, layoutInput, move, moveToLineEdge, moveVertical} from '../src/tui/editor.js';
import {buildDemoSceneRows, demoRoles, hoveredCardAt, initialDemoSceneState, type DemoSceneState} from '../src/tui/scene.js';
import {actorCardPalette, palette} from '../src/tui/cards.js';
import {extractSelection, parseSgrMouse} from '../src/tui/viewport.js';

test('视觉折行保留草稿原文与完整字形，行尾光标不制造额外空行', () => {
  const text = '中文🙂ab\n👨‍👩‍👧‍👦é尾\n';
  const draft = insert(emptyDraft, text);
  const layout = layoutInput(draft, 6);
  assert.equal(draft.text, text);
  assert.equal(layout.cursorRow, layout.lines.length - 1);
  assert.equal(layout.cursorColumn, 0);
  assert.equal(layout.lines.at(-1)!.text, '');
  assert.ok(layout.lines.some(line => line.text.includes('👨‍👩‍👧‍👦')));
  for (const line of layout.lines) {
    assert.ok(stringWidth(line.text) <= 6);
    assert.equal(line.text, graphemes(text).slice(line.start, line.end).join(''));
  }
  const full = layoutInput(insert(emptyDraft, '中文ab'), 6);
  assert.equal(full.lines.length, 1);
  assert.equal(full.cursorColumn, 6);
  const combined = insert(insert(emptyDraft, 'e'), '\u0301');
  assert.equal(combined.cursor, 1);
  assert.equal(erase(combined, true).text, '');
  assert.equal(insert(emptyDraft, '一\r\n二\r三').text, '一\n二\n三');
});

test('上下按视觉行移动，穿过短行后恢复理想列，Home/End 停在当前视觉行', () => {
  const original = {text: 'abcdef\nx\nuvwxyz', cursor: 3};
  const short = moveVertical(original, 1, 10);
  assert.equal(short.cursor, 8);
  const long = moveVertical(short, 1, 10);
  assert.equal(long.cursor, 12);
  assert.equal(moveVertical(moveVertical(long, -1, 10), -1, 10).cursor, 3);
  const wrapped = {text: '一二三四五六', cursor: 4};
  const layout = layoutInput(wrapped, 6);
  assert.equal(layout.cursorRow, 1);
  assert.equal(layout.cursorColumn, 2);
  assert.equal(moveToLineEdge(wrapped, false, 6).cursor, 3);
  assert.equal(moveToLineEdge(wrapped, true, 6).cursor, 6);
  assert.equal(cursorAt(layout, 0, 2), 1);
});

test('输入视口仅在光标越界时滚动；草稿缩短和终端缩放后仍包含光标', () => {
  const draft = insert(emptyDraft, '一\n二\n三\n四\n五\n六\n七');
  const last = layoutInput(draft, 20);
  const view = inputViewport(last, 5);
  assert.equal(view.start, 2);
  assert.equal(view.lines.length, 5);
  const first = inputViewport(layoutInput(move(draft, -Infinity), 20), 5, view.start);
  assert.equal(first.start, 0);
  const inside = inputViewport(layoutInput({...draft, cursor: 6}, 20), 5, 1);
  assert.equal(inside.start, 1);
  const resized = inputViewport(layoutInput(insert(emptyDraft, '中文🙂重复中文🙂重复中文🙂'), 4), 3, 4);
  assert.equal(resized.lines.length, 3);
  assert.equal(inputViewport(layoutInput(emptyDraft, 10), 5, 20).start, 0);
});

test('窄屏保留完整任务与状态；嵌套正文复制过滤轨道、封边和内边距', () => {
  const task = '检查首页的中文标题、emoji 🙂 与 src/components/ProjectCard.tsx 的完整展示，保留全部任务描述。';
  const state: DemoSceneState = {
    ...initialDemoSceneState,
    folds: {'main-aletheia': true, 'main-aletheia-reads': true},
    events: [{id: 1, type: 'dispatch', actor: 'kalon', text: '@kalon ' + task, direction: '（记录任务）', reply: '收到。'}],
  };
  for (const width of [20, 40, 80, 120]) {
    const rows = buildDemoSceneRows(state, width);
    for (const row of rows) {
      const displayed = row.segments ? row.segments.map(s => s.text).join('') :
        (row.prefixSegments?.map(s => s.text).join('') ?? '') + row.text + (row.suffixSegments?.map(s => s.text).join('') ?? '');
      assert.ok(stringWidth(displayed) + (row.railColor ? 2 : 0) <= width, displayed);
    }
    const titleRows = rows.filter(row => row.messageId === 'dispatch-1-task');
    if (titleRows.length) assert.equal(titleRows.map(row => row.text).join(''), task);
    const descriptionRows = rows.filter(row => row.messageId === 'main-aletheia-reads-body-0');
    assert.ok(descriptionRows.every(row => row.gutterCols >= 4));
    const copied = extractSelection(descriptionRows, {anchor: {x: 0, y: 0}, focus: {x: width, y: descriptionRows.length - 1}});
    assert.equal(copied, 'src/pages/index.tsx:18             首屏标题、标签组与按钮字重同级，焦点分散');
    const status = rows.filter(row => row.messageId.startsWith('dispatch-1')).map(row => row.text).join('');
    assert.ok(status.includes('任务已接收'));
  }
});


test('卡片使用透亮烟熏色与白日梦雾白灰；内联工具无灰底；选中项只改变标识和文字', () => {
  const denyRows = buildDemoSceneRows(initialDemoSceneState, 99);
  const allowRows = buildDemoSceneRows({...initialDemoSceneState, permissionChoice: 'allow'}, 99);
  assert.equal(actorCardPalette.aletheia.closed, '#3d5a4f');
  assert.equal(actorCardPalette.aletheia.highlight, '#a8f0d4');
  assert.equal(actorCardPalette.techne.closed, '#3d5266');
  assert.equal(actorCardPalette.techne.highlight, '#a8d8ff');
  assert.equal(actorCardPalette.kalon.closed, '#544359');
  assert.equal(actorCardPalette.kalon.highlight, '#f4b8e8');
  for (const hex of Object.values(actorCardPalette).flatMap(p => [p.closed, p.open])) {
    const channels = hex.slice(1).match(/../g)!.map(c => Number.parseInt(c, 16));
    assert.ok(channels.every(c => c >= 55 && c <= 130), hex);
  }
  for (const id of ['main-techne-perm-allow', 'main-techne-perm-deny']) {
    const before = denyRows.find(r => r.messageId === id)!;
    const after = allowRows.find(r => r.messageId === id)!;
    assert.equal(before.bg, actorCardPalette.techne.open);
    assert.equal(after.bg, before.bg);
    assert.deepEqual(before.prefixSegments, after.prefixSegments);
    assert.equal(before.gutterCols, 4);
    const selected = id.endsWith('deny') ? before : after;
    const unselected = selected === before ? after : before;
    assert.ok(selected.text.startsWith('❯ '));
    assert.ok(unselected.text.startsWith('  '));
    assert.equal(selected.segments!.find(s => s.text.includes('允许'))!.color, demoRoles.techne.color);
    const description = (id.endsWith('deny') ? denyRows : allowRows).find(r => r.messageId === id + '-description')!;
    assert.equal(description.gutterCols, selected.gutterCols + 2);
    assert.equal(description.color, demoRoles.techne.color);
  }
  const question = buildDemoSceneRows({...initialDemoSceneState, permission: 'deny'}, 99);
  const kalonSelection = question.find(r => r.messageId === 'main-kalon-style-minimal')!;
  assert.ok(kalonSelection.text.startsWith('❯ '));
  assert.equal(kalonSelection.segments!.find(s => s.text.includes('克制'))!.color, demoRoles.kalon.color);
  const nested = buildDemoSceneRows({...initialDemoSceneState, folds: {'main-aletheia': true}}, 99);
  assert.equal(nested.find(r => r.messageId === 'main-aletheia-reads')!.bg, actorCardPalette.aletheia.open, 'Actor 内联工具调用不画灰底，直接透出 Actor 底色');
});

test('悬停统一高亮逻辑：有底色卡切换展开底色与高亮标题，无底色工具/思考卡保持无底色并高亮标题', () => {
  const base = buildDemoSceneRows(initialDemoSceneState, 40);
  for (const id of ['main-aletheia', 'main-kalon']) {
    const hovered = buildDemoSceneRows(initialDemoSceneState, 40, id);
    assert.deepEqual(hovered.map(r => [r.messageId, r.text, r.gutterCols, r.action]), base.map(r => [r.messageId, r.text, r.gutterCols, r.action]));
    const card = hovered.filter(r => r.hover?.foldId === id);
    assert.equal(card.length, 4, '40 列下含上下对称 0.5 行封边（▄ / ▀）与两行完整标题');
    const roleKey = id === 'main-aletheia' ? 'aletheia' : 'kalon';
    const expected = actorCardPalette[roleKey].open;
    assert.equal(card.find(r => r.messageId === id)!.bg, expected);
    const taskSeg = card.find(r => r.messageId === id + '-task')!.segments!.find(s => s.text.includes('首页'))!;
    assert.equal(taskSeg.color, actorCardPalette[roleKey].highlight);
    assert.equal(Boolean(taskSeg.bold), false, '标题高亮仅改变为高亮色，不加粗');
    const wideCard = buildDemoSceneRows(initialDemoSceneState, 99, id).filter(r => r.hover?.foldId === id);
    assert.equal(wideCard.length, 3, '宽屏含上下对称 0.5 行封边（▄ / ▀）与单行标题');
    assert.ok(wideCard[0]!.text.includes('▄'));
    assert.ok(wideCard[2]!.text.includes('▀'));
    for (const row of card) {
      assert.equal(hoveredCardAt(row, 2), id);
      assert.equal(hoveredCardAt(row, 0), null);
      assert.equal(hoveredCardAt(row, 40), null);
    }
    assert.deepEqual(buildDemoSceneRows(initialDemoSceneState, 40, null), base);
    const selection = {anchor: {x: 0, y: 0}, focus: {x: 40, y: base.length - 1}};
    assert.equal(extractSelection(hovered, selection), extractSelection(base, selection));
  }
  for (const id of ['main-thinking', 'main-tool']) {
    const idleRow = base.find(r => r.messageId === id)!;
    assert.equal(hoveredCardAt(idleRow, 2), id, '无底色折叠卡同样支持鼠标悬停命中');
    assert.equal(idleRow.segments!.find(s => s.text === '思考' || s.text === '工具调用')!.color, palette.muted);
    for (const open of [false, true]) {
      const rows = buildDemoSceneRows({...initialDemoSceneState, folds: {[id]: open}}, 40, id).filter(r => r.messageId.startsWith(id));
      assert.ok(rows.length >= 1);
      assert.ok(rows.every(r => !r.bg && !r.segments?.some(s => s.bg) && !r.prefixSegments?.some(s => s.bg) && !r.suffixSegments?.some(s => s.bg)));
      const headerRow = rows.find(r => r.messageId === id)!;
      assert.equal(headerRow.action?.kind, 'toggle_fold');
      const labelSeg = headerRow.segments!.find(s => s.text === '思考' || s.text === '工具调用')!;
      assert.equal(labelSeg.color, palette.accent, '悬停或展开时标题切换为高亮色');
      assert.equal(Boolean(labelSeg.bold), false, '无底色卡高亮同样不加粗');
    }
  }
  const memory = buildDemoSceneRows({...initialDemoSceneState, style: '克制', folds: {'main-memory': true}}, 99);
  assert.equal(memory.find(r => r.messageId === 'main-memory')!.bg, '#dce2e8');
  assert.equal(memory.find(r => r.messageId === 'main-memory-body-0')!.color, palette.dreamText);
  assert.equal(memory.find(r => r.messageId === 'main-memory')!.segments!.find(s => s.text.includes('Anamnesis'))!.color, palette.dreamText);
  assert.equal(palette.dreamCollapsed, '#c4cbd2');
  assert.equal(palette.dreamExpanded, '#dce2e8');
  assert.equal(hoveredCardAt(base.find(r => r.messageId === 'main-techne'), 4), null);
  assert.deepEqual(parseSgrMouse('\x1b[<35;8;12M\x1b[<32;9;13M').map(e => e.action), ['move', 'drag']);
});
