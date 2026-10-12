import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/stage.js';
import {extractSelection, viewport} from '../src/tui/viewport.js';

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
