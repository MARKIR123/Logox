import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/stage.js';
import {extractSelection, viewport} from '../src/tui/viewport.js';
import {layoutMarkdown} from '../src/tui/markdown.js';

test('正式舞台渲染 Markdown，软折行复制恢复原文，用户和工具保持原样', () => {
  const store = new RuntimeStore();
  const source = '# 中文标题🙂\n- **第一项** 和 `代码`\n1. 第二项\n> 引用\n[链接](https://example.com)\n```ts\n\tconst value = "中文👩‍💻";\n```';
  const id = store.message('s', 'logox', 'assistant', source);
  const user = store.message('s', 'logox', 'user', '# 用户原文');
  const tool = store.message('s', 'logox', 'assistant', '# 工具原文', {kind: 'tool'});
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 18, {[tool]: true}, null);
  const body = rows.filter(row => row.messageId === id);
  assert.equal(body[0]?.text, '中文标题🙂');
  assert.ok(body.some(row => row.text.startsWith('• ')));
  assert.ok(body.some(row => row.segments?.some(segment => segment.bold && segment.text.includes('第一'))));
  assert.ok(body.every(row => !row.text.includes('```')));
  assert.ok(body.every(row => stringWidth(row.text) <= 16));
  assert.equal(extractSelection(body, {anchor: {x: 0, y: 0}, focus: {x: 100, y: body.length - 1}}), source);
  assert.equal(store.getSnapshot().messages[0]?.text, source);
  assert.ok(rows.some(row => row.messageId === user && row.text === '# 用户原文'));
  assert.ok(rows.some(row => row.text === '# 工具原文'));
  const emphasis = body.findIndex(row => row.text.includes('第一项'));
  assert.equal(extractSelection(body, {anchor: {x: 4, y: emphasis}, focus: {x: 9, y: emphasis}}), '**第一项**');
});

test('未闭合围栏和行内强调在流式追加后收尾，字形与代码缩进保持完整', () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', '说明 **尚未结束\n```ts\n  const emoji = "👩‍💻";');
  const before = buildStageRows(store.getSnapshot(), 's', 'logox', 12, {}, null).filter(row => row.messageId === id);
  assert.ok(before.some(row => row.text.includes('**')));
  assert.ok(before.some(row => row.text.startsWith('  const')));
  assert.equal(before.map(row => row.text).join('').match(/👩‍💻/g)?.length, 1);
  store.appendMessage(id, '\n```\n**完成**');
  const after = buildStageRows(store.getSnapshot(), 's', 'logox', 12, {}, null).filter(row => row.messageId === id);
  assert.equal(after.at(-1)?.text, '完成');
  assert.equal(extractSelection(after, {anchor: {x: 0, y: 0}, focus: {x: 100, y: after.length - 1}}), store.getSnapshot().messages[0]?.text);
});

test('流式新增与悬停复用已有消息布局，宽度和工具折叠变化刷新布局', () => {
  const store = new RuntimeStore();
  const old = store.message('s', 'logox', 'assistant', '# 历史\n' + '中文🙂内容。'.repeat(40));
  const tail = store.message('s', 'logox', 'assistant', '新的回复');
  const tool = store.message('s', 'logox', 'assistant', '工具标题\n工具正文', {kind: 'tool'});
  const before = buildStageRows(store.getSnapshot(), 's', 'logox', 40, {}, null);
  store.appendMessage(tail, '追加');
  const after = buildStageRows(store.getSnapshot(), 's', 'logox', 40, {}, tool);
  assert.equal(before.find(row => row.messageId === old), after.find(row => row.messageId === old));
  assert.notEqual(before.find(row => row.messageId === tail), after.find(row => row.messageId === tail));
  const open = buildStageRows(store.getSnapshot(), 's', 'logox', 40, {[tool]: true}, tool);
  assert.ok(open.some(row => row.text === '工具正文'));
  const narrow = buildStageRows(store.getSnapshot(), 's', 'logox', 20, {}, null);
  assert.notEqual(before.find(row => row.messageId === old), narrow.find(row => row.messageId === old));
});

test('窄屏保留嵌套强调、深层列表、CRLF 和未完成标题的复制原文', () => {
  for (const source of ['# ', '**第一项 *斜体* 结尾**', '    - 嵌套项目🙂', '# 标题\r\n```ts\r\n\tvalue\r\n```']) {
    const store = new RuntimeStore();
    const id = store.message('s', 'logox', 'assistant', source);
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 8, {}, null).filter(row => row.messageId === id);
    assert.equal(extractSelection(rows, {anchor: {x: 0, y: 0}, focus: {x: 100, y: rows.length - 1}}), source);
  }
});

test('消息原文位置作为阅读锚点：缩放与新增消息保持位置，底部继续跟随', () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', '# 标题\n' + '第一段中文👩‍💻'.repeat(80));
  const wide = buildStageRows(store.getSnapshot(), 's', 'logox', 60, {}, null);
  const row = wide.find(item => item.messageId === id && item.line === 8)!;
  const anchor = {messageId: id, line: row.line, sourceOffset: row.sourceStart!};
  store.message('s', 'logox', 'assistant', '后续\n'.repeat(20));
  const narrow = buildStageRows(store.getSnapshot(), 's', 'logox', 24, {}, null);
  const reading = viewport(narrow, 8, anchor);
  assert.equal(reading.rows[0]?.messageId, id);
  assert.ok(reading.rows[0]!.sourceStart! <= anchor.sourceOffset && reading.rows[0]!.sourceEnd! > anchor.sourceOffset);
  assert.equal(reading.following, false);
  const bottom = viewport(narrow, 8, null);
  assert.equal(bottom.start, narrow.length - 8);
  assert.equal(bottom.following, true);
});

test('表格按中文字形分配列宽、对齐和换行，整表复制保留 CRLF、竖线及原始语法', () => {
  const source = '表格前\r\n| 项目 | 数量 | 说明 |\r\n| :--- | ---: | :---: |\r\n| **中文🙂** | 42 | `a|b` 和转义\\|文本以及更多内容👩‍💻 |\r\n| 后续 | 7 | 完成 |\r\n表格后';
  for (const width of [80, 36, 16, 8]) {
    const store = new RuntimeStore();
    const id = store.message('s', 'logox', 'assistant', source);
    const body = buildStageRows(store.getSnapshot(), 's', 'logox', width, {}, null).filter(row => row.messageId === id);
    assert.ok(body.every(row => stringWidth(row.text) <= width - 2), '每行都在窗口内');
    assert.equal(extractSelection(body, {anchor: {x: 0, y: 0}, focus: {x: 1000, y: body.length - 1}}), source);
    assert.ok(body.some(row => row.text.includes('│') || row.text.includes('：')));
    assert.ok(!body.some(row => row.text.includes('\\|')));
    assert.equal(body.map(row => row.text).join('').match(/👩‍💻/g)?.length, 1);
  }
  const lines = layoutMarkdown('| L | R | C |\n| :--- | ---: | :---: |\n| xx | 1 | a |\n| x | 100 | abc |', 19);
  assert.equal(lines[3]?.text, '│ xx  │   1 │  a  │');
  const rows = buildStageRows((() => {const store = new RuntimeStore(); store.message('s', 'logox', 'assistant', '| 项目 | 值 |\n| --- | --- |\n| **中文** | 42 |'); return store.getSnapshot();})(), 's', 'logox', 40, {}, null);
  const y = rows.findIndex(row => row.text.includes('中文'));
  assert.equal(extractSelection(rows, {anchor: {x: 4, y}, focus: {x: 7, y}}), '**中文**', '单元格选择不含边框或填充');
});

test('流式表格从未完成分隔行转成布局，代码围栏内的表格保持代码', () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', '| A | B |\n| --- | --');
  let rows = buildStageRows(store.getSnapshot(), 's', 'logox', 40, {}, null).filter(row => row.messageId === id);
  assert.ok(rows.some(row => row.text.includes('| ---')));
  store.appendMessage(id, '- |\n| 中文 |');
  rows = buildStageRows(store.getSnapshot(), 's', 'logox', 40, {}, null).filter(row => row.messageId === id);
  assert.ok(rows.some(row => row.text.includes('├')));
  assert.equal(extractSelection(rows, {anchor: {x: 0, y: 0}, focus: {x: 1000, y: rows.length - 1}}), store.getSnapshot().messages[0]!.text);
  assert.ok(layoutMarkdown('```\n| A | B |\n| --- | --- |\n```', 40).some(row => row.text === '| --- | --- |'));
  assert.ok(!layoutMarkdown('| A | B |\n| --- | --- |\n| \x1b[2J | ok |', 40).some(row => row.text.includes('\x1b')));
});

test('短表格的完整上下框线铺满正文宽度，缩放与纵向布局仍保留原文复制', () => {
  const source = '| A | B |\r\n| :--- | ---: |\r\n| x | 42 |';
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', source);
  for (const width of [8, 16, 40, 180]) {
    const rows = buildStageRows(store.getSnapshot(), 's', 'logox', width, {}, null).filter(row => row.messageId === id);
    const contentWidth = width - 2;
    assert.equal(stringWidth(rows[0]!.text), contentWidth, '顶部框线铺满正文');
    assert.equal(stringWidth(rows.at(-1)!.text), contentWidth, '底部框线铺满正文');
    if (width >= 16) {
      assert.match(rows[0]!.text, /^┌─+┬─+┐$/);
      assert.match(rows.at(-1)!.text, /^└─+┴─+┘$/);
      assert.ok(rows.every(row => stringWidth(row.text) === contentWidth), '列边界与上下框线等宽');
      assert.equal(extractSelection(rows, {anchor: {x: 2, y: 0}, focus: {x: width - 1, y: 0}}), '', '新增装饰框线不进入复制');
    }
    assert.equal(extractSelection(rows, {anchor: {x: 0, y: 0}, focus: {x: 1000, y: rows.length - 1}}), source);
  }
});

test('代码块上下横线铺满正文宽度，语言标签不换行，整块复制恢复围栏', () => {
  for (const label of ['powershell', '中文👩‍💻'.repeat(20), '']) {
    const source = '```' + label + '\r\nnpm start\r\n```';
    const store = new RuntimeStore();
    const id = store.message('s', 'logox', 'assistant', source);
    for (const width of [6, 18, 80, 180]) {
      const rows = buildStageRows(store.getSnapshot(), 's', 'logox', width, {}, null).filter(row => row.messageId === id);
      assert.equal(stringWidth(rows[0]!.text), width - 2, '顶部横线铺满正文');
      assert.equal(rows.at(-1)!.text, '─'.repeat(width - 2), '底部横线铺满正文');
      assert.equal(rows.slice(1, -1).map(row => row.text).join(''), 'npm start', '语言标签不溢出到代码正文');
      assert.equal(extractSelection(rows, {anchor: {x: 0, y: 0}, focus: {x: 1000, y: rows.length - 1}}), source);
    }
  }
});

test('长表格的单元格折行逐行可滚动，缩放锚点定位到同一原文字形', () => {
  const store = new RuntimeStore();
  const id = store.message('s', 'logox', 'assistant', '| A | B |\n| --- | --- |\n| ' + '甲乙'.repeat(30) + ' | ' + '中文🙂'.repeat(40) + ' |\n\n后续\n'.repeat(10));
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 24, {}, null);
  const chosen = rows.find(row => row.messageId === id && row.line === 5)!;
  const anchor = {messageId: id, line: chosen.line, sourceOffset: chosen.sourceStart!};
  assert.equal(viewport(rows, 3, anchor).rows[0], chosen);
  const wider = buildStageRows(store.getSnapshot(), 's', 'logox', 40, {}, null);
  const restored = viewport(wider, 3, anchor).rows[0]!;
  assert.ok(restored.sourceCells?.some(cell => cell.start <= anchor.sourceOffset && cell.end > anchor.sourceOffset));
});
