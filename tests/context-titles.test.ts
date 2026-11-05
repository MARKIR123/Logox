import test from 'node:test';
import assert from 'node:assert/strict';
import {clampText, stripLeadingActionLines, summarizeRound} from '../src/context/contracts.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const round = (reply: string): ModelMessage[] => [{role: 'user', text: 'go'}, {role: 'assistant', text: reply}];

test('a leading bracketed micro-action line never becomes the round title', () => {
  for (const action of ['（核对色板与标尺）', '(checks the palette)', '【核对色板】']) {
    const summary = summarizeRound(round(action + '\nPalette verified against the ruler.'), 'completed');
    assert.equal(summary.title, 'Palette verified against the ruler.');
  }
});

test('only micro-action lines are skipped; ordinary parenthesised text is a title', () => {
  assert.equal(summarizeRound(round('(see notes) and more words'), 'completed').title, '(see notes) and more words');
  assert.equal(summarizeRound(round('（核对）'), 'completed').title, 'Completed');
});

test('stripLeadingActionLines starts a summary at substance', () => {
  assert.equal(stripLeadingActionLines('（核对色板）\n\n(also this)\nResult is ready.\n（not leading）'), 'Result is ready.\n（not leading）');
  assert.equal(stripLeadingActionLines('Plain reply'), 'Plain reply');
});

test('clampText cuts on a word boundary and appends an ellipsis', () => {
  const text = 'The curve is finished without singularities anywhere along the entire path of motion for the arm';
  const clamped = clampText(text, 40);
  assert.ok(clamped.length <= 40);
  assert.equal(clamped, 'The curve is finished without…');
  assert.equal(clampText('short', 40), 'short');
});

test('clampText never splits a grapheme', () => {
  const family = '👨‍👩‍👧‍👦';
  const clamped = clampText('测试'.repeat(30) + family.repeat(5), 61);
  assert.ok(clamped.endsWith('…'));
  assert.ok(clamped.length <= 61);
  assert.ok(!/[\ud800-\udbff]…$/.test(clamped) && !clamped.endsWith('‍…'));
});
