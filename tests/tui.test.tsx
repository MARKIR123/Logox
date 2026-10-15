import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToString} from 'ink';
import stringWidth from 'string-width';
import {ActivityCard, InteractionCard} from '../src/tui/cards.js';
import {emptyDraft, erase, insert, move} from '../src/tui/editor.js';
import {extractSelection, osc52Clipboard, parseSgrMouse, timelineRows, viewport} from '../src/tui/viewport.js';
import type {Interaction, Message} from '../src/runtime/contracts.js';

test('Actor 与入梦复用无边框纯色状态卡，无折叠箭头，中文窄屏布局不越界', () => {
  for (const width of [20, 40, 80]) for (const kind of ['actor', 'anamnesis'] as const) {
    const output = renderToString(<ActivityCard activity={{
      sessionId: 's', activityId: 'a', ownerId: kind === 'actor' ? 'kalon' : 'anamnesis', kind,
      title: kind === 'actor' ? 'Kalon · 雅正' : 'Anamnesis · 入梦', status: 'waiting_input',
      stage: '等待用户回答', detail: '中文与 emoji 👨‍👩‍👧‍👦 都需要按显示宽度折行。', version: 1,
    }} expanded/>, {columns: width});
    assert.match(output, /等待回答/);
    assert.doesNotMatch(output, /[▸▾╭╮╰╯]/);
    for (const line of output.split('\n')) assert.ok(stringWidth(line) <= width, line);
  }
});
test('权限卡显示真实参数、原因和默认拒绝；问题卡支持自由输入', () => {
  const permission: Interaction = {kind: 'permission', requestId: 'p', sessionId: 's', activityId: 'a', ownerId: 'techne',
    title: '权限', tool: 'write', arguments: {path: 'src/a.ts'}, reason: '写入源码', status: 'pending'};
  const output = renderToString(<InteractionCard request={permission}
    draft={{questionIndex: 0, selected: 1, text: '', error: ''}} focused/>, {columns: 60});
  assert.match(output, /src\/a\.ts/);
  assert.match(output, /❯ 拒绝（默认）/);
  assert.match(output, /仅本次允许/);
  const question: Interaction = {kind: 'question', requestId: 'q', sessionId: 's', activityId: 'a', ownerId: 'kalon',
    title: '问题', questions: [{id: 'q', header: '方向', question: '你想做什么？'}], status: 'pending'};
  assert.match(renderToString(<InteractionCard request={question}
    draft={{questionIndex: 0, selected: 0, text: '多一些留白', error: ''}} focused/>, {columns: 40}), /多一些留白/);
});
test('输入按字形移动和删除，不拆开中文组合字或 emoji；粘贴保留换行', () => {
  const draft = insert(emptyDraft, '中👨‍👩‍👧‍👦é');
  assert.equal(draft.cursor, 3);
  const changed = erase(move(draft, -1), true);
  assert.equal(changed.text, '中é');
  assert.equal(insert(changed, '\n后续').text, '中\n后续é');
});
test('阅读锚点在新消息到来时保持，底部跟随更新', () => {
  const message = (id: string, text: string): Message => ({id, text, sessionId: 's', ownerId: 'kalon', role: 'assistant'});
  const first = message('first', '一\n二\n三\n四');
  const original = timelineRows([first], 20);
  const row = original[1]!;
  const anchor = {messageId: row.messageId, line: row.line};
  const expanded = timelineRows([first, message('second', '新台词')], 20);
  assert.equal(viewport(expanded, 3, anchor).rows[0]!.text, original[1]!.text);
  assert.ok(viewport(expanded, 3, null).rows.some(item => item.messageId === 'second'));
});
test('左侧轨道与正文分离：框选只过滤左轨并包含标题，自动拼接软折行并保留真实硬换行', () => {
  const msg: Message = {
    id: 'm1',
    sessionId: 's',
    ownerId: 'kalon',
    role: 'assistant',
    text: '第一段长文在窄屏下被自动折行到下一行。\n第二段独立成行。',
  };
  const rows = timelineRows([msg], 18);
  assert.equal(rows[0]!.noSelect, true, '名牌不是正文阅读锚点，仍可选择复制');
  assert.ok(rows.some(r => r.softWrap), '存在自动软折行');
  for (const r of rows) {
    assert.ok(!r.text.includes('▎'), 'row.text 绝不包含左侧轨道字符');
  }
  const copied = extractSelection(rows, {anchor: {x: 0, y: 0}, focus: {x: 40, y: rows.length - 1}});
  assert.equal(copied, '✧ Kalon · 台词\n第一段长文在窄屏下被自动折行到下一行。\n第二段独立成行。\n');
  const events = parseSgrMouse('\x1b[<0;1;1M\x1b[<32;18;4M\x1b[<0;18;4m');
  assert.deepEqual(events.map(e => e.action), ['press', 'drag', 'release']);
  const osc = osc52Clipboard(copied);
  assert.equal(Buffer.from(osc.slice('\x1b]52;c;'.length, -1), 'base64').toString('utf8'), copied);
});
