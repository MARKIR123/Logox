import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {buildQuestionRows, type PanelQuestion, type QuestionRow} from '../src/tui/interactions/question-panel.js';
import {palette} from '../src/tui/appearance/theme.js';

const badge = [{text: 'built-in', tone: 'dim'}, {text: ' · ', tone: 'dim'}, {text: '✓ signed in', tone: 'success'}] as const;
const question: PanelQuestion = {question: 'Choose a provider', hideCustomInput: true, options: [
  {label: 'deepseek', description: 'DeepSeek official API', badge},
  {label: 'Custom endpoint', description: 'Any OpenAI- or Anthropic-compatible URL with an API key'},
  {label: 'orphan', description: 'Saved credential without an endpoint', badge: [{text: 'credential only', tone: 'warning'}]},
]};
const build = (width: number, extra: Partial<PanelQuestion> = {}, focus = 0) => buildQuestionRows({question: {...question, ...extra}, position: 1, total: 1,
  width, height: 24, y: 0, focus, checked: [], text: '', cursor: 0});
const text = (row: QuestionRow) => row.segments.map(part => part.text).join('');
const firstRowOf = (rows: readonly QuestionRow[], index: number) => rows.find(row => row.action === index)!;

test('an option with a badge draws two lines: name and right-aligned badge, then the description', () => {
  const {rows} = build(60);
  const lines = rows.filter(row => row.action === 0);
  assert.equal(lines.length, 2, 'name line plus description line');
  assert.equal(stringWidth(text(lines[0]!)), 60, 'the badge sits flush against the right edge');
  assert.match(text(lines[0]!), /^❯ \[ \] deepseek\s+built-in · ✓ signed in$/u);
  assert.match(text(lines[1]!), /DeepSeek official API/);
  assert.equal(text(rows.find(row => row.action === 1)!).includes('built-in'), false, 'no badge, no gap');
});

test('only the check-marked part of the badge is coloured by tone; the rest is dim and a warning is flagged', () => {
  const {rows} = build(60);
  const parts = firstRowOf(rows, 0).segments;
  assert.equal(parts.find(part => part.text === '✓ signed in')!.color, palette.success);
  assert.equal(parts.find(part => part.text === 'built-in')!.color, palette.muted);
  assert.equal(firstRowOf(rows, 2).segments.at(-1)!.color, palette.warning);
});

test('a narrow row clips the name before the badge, then drops the origin, so the state stays visible', () => {
  const longName = 'a-very-long-provider-name-that-cannot-fit';
  const clipped = build(34, {options: [{label: longName, badge}]}).rows.find(row => row.action === 0)!;
  assert.equal(stringWidth(text(clipped)), 34);
  assert.ok(text(clipped).endsWith('built-in · ✓ signed in'), 'full badge is kept while the name gives way');
  assert.ok(!text(clipped).includes(longName));
  const tiny = build(20, {options: [{label: longName, badge}]}).rows.find(row => row.action === 0)!;
  assert.ok(stringWidth(text(tiny)) <= 20);
  assert.ok(text(tiny).endsWith('✓ signed in'), 'the origin goes first on a very narrow row');
  const minimal = build(12, {options: [{label: longName, badge}]}).rows.find(row => row.action === 0)!;
  assert.ok(stringWidth(text(minimal)) <= 12);
  assert.ok(text(minimal).includes('✓'), 'the badge is clipped, never removed');
});

test('wide characters keep the badge aligned', () => {
  const rows = build(40, {options: [{label: '本地网关服务', badge: [{text: 'custom', tone: 'dim'}, {text: ' · ', tone: 'dim'}, {text: '✓ local', tone: 'success'}]}]}).rows;
  const line = rows.find(row => row.action === 0)!;
  assert.equal(stringWidth(text(line)), 40);
  assert.ok(text(line).endsWith('custom · ✓ local'));
  assert.ok(text(line).includes('本地网关服务'));
});

test('both lines of a two-line option hit-test to the same option, for click and hover', () => {
  const {rows} = build(60);
  const actions = rows.map(row => row.action);
  const first = actions.indexOf(0);
  assert.deepEqual(actions.slice(first, first + 2), [0, 0], 'name line and description line share the option index');
  assert.deepEqual([...new Set(actions.filter((action): action is number => typeof action === 'number'))], [0, 1, 2]);
  const focused = build(60, {}, 1).rows;
  assert.ok(text(focused.find(row => row.action === 1)!).startsWith('❯'), 'focus moves with the selection');
});
