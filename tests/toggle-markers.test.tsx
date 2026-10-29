import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToString} from 'ink';
import stringWidth from 'string-width';
import {toggleColor, toggleMarker} from '../src/tui/components/toggle-marker.js';
import chalk from 'chalk';
import {ToggleList} from '../src/tui/panels/toggle-list.js';
import {choiceStyle} from '../src/tui/interactions/choice-style.js';
import {palette} from '../src/tui/appearance/theme.js';
import {QuestionCard} from '../src/tools/AskUserQuestionTool/QuestionCard.js';
import {getToolUI} from '../src/tools/ui-registry.js';
import {createBuilder} from '../src/tui/timeline/scene.js';
import {QuestionPanel} from '../src/tui/interactions/question-panel.js';
import {Picker} from '../src/tui/panels/picker.js';
import type {Interaction} from '../src/runtime/contracts.js';
import {contentPoint, selectionRange} from '../src/tui/timeline/selection.js';
import {extractSelection} from '../src/tui/timeline/viewport.js';
const plain = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');
const request: Interaction = {kind: 'question', requestId: 'q', sessionId: 's', activityId: 'a', ownerId: 'techne', status: 'pending', title: 'Checks',
  questions: [{id: 'checks', header: 'Checks', question: 'Which checks?', multiSelect: true,
    options: [{id: 'alpha', label: 'Alpha', description: 'First'}, {id: 'beta', label: 'Beta', description: 'Second'}]}]};
const draft = {questionIndex: 0, selected: 1, checked: [0], text: '', error: ''};

test('toggle markers have the same three-cell width, with a larger solid square only when checked', () => {
  assert.equal(toggleMarker(false), '[ ]'); assert.equal(toggleMarker(true), '[■]');
  assert.equal(stringWidth(toggleMarker(false)), 3); assert.equal(stringWidth(toggleMarker(true)), 3);
});

test('choice style separates keyboard focus from checked state and keeps description alignment', () => {
  const checked = choiceStyle(false, '#abcdef', palette.fg, palette.muted, true);
  const focused = choiceStyle(true, '#abcdef', palette.fg, palette.muted, false);
  assert.equal(checked.marker, '  [■] '); assert.equal(focused.marker, '❯ [ ] ');
  assert.equal(checked.indent, 6); assert.equal(focused.indent, 6);
  assert.equal(checked.markerColor, '#ffffff'); assert.equal(focused.markerColor, palette.accent);
  assert.equal(toggleColor(false, false), palette.muted);
  assert.equal(toggleColor(true, false), '#ffffff');
  assert.equal(toggleColor(false, true), palette.accent);
  assert.equal(toggleColor(true, true), palette.accent);
  assert.equal(toggleColor(true, true, true), palette.muted);
});

test('settings and inline production questions use the same checked and empty boxes', () => {
  const settings = plain(renderToString(<ToggleList items={[{id: 'on', label: 'On', enabled: true}, {id: 'off', label: 'Off', enabled: false}]}
    selected={1} start={0} count={2} width={60}/>, {columns: 60}));
  assert.match(settings, /\[■\] On/); assert.match(settings, /❯ \[ \] Off/);
  const question = plain(renderToString(<QuestionCard request={request} draft={draft} focused/>, {columns: 80}));
  assert.match(question, /\[■\] Alpha/); assert.match(question, /❯ \[ \] Beta/);
  assert.doesNotMatch(question, /\[x\]|[◉○●]/);
});

test('production scene questions share markers, system marker color, wrapping and hit targets', () => {
  const adapter = getToolUI('AskUserQuestion').interaction; assert.ok(adapter);
  for (const width of [20, 40, 80]) {
    const builder = createBuilder(width, null);
    adapter.render({builder, request, draft, answers: {}, open: true, accent: '#abcdef'});
    const checked = builder.rows.find(row => row.messageId === 'q-option-0')!;
    const focused = builder.rows.find(row => row.messageId === 'q-option-1')!;
    assert.match(checked.text, /\[■\] Alpha/); assert.match(focused.text, /❯ \[ \] Beta/);
    assert.equal(checked.segments?.find(segment => segment.text.includes('[■]'))?.color, '#ffffff');
    assert.equal(checked.action?.kind, 'select_answer');
    assert.equal(focused.action?.kind, 'select_answer');
    const at = builder.rows.indexOf(checked), x = (checked.displayText ?? checked.text).indexOf('Alpha') + builder.baseGutterCols;
    const selectedText = selectionRange(builder.rows, {anchor: contentPoint(builder.rows, at, x), focus: contentPoint(builder.rows, at, x + 4)});
    assert.equal(extractSelection(builder.rows, selectedText), 'Alpha', 'Colored marker must not overlap label copy offsets');
    for (const row of builder.rows) assert.ok(stringWidth(row.displayText ?? row.text) + builder.baseGutterCols <= width, row.displayText ?? row.text);
  }
});

test('preview single and multi questions share square markers without overflowing narrow rows', () => {
  for (const multiSelect of [false, true]) for (const width of [20, 40, 80]) {
    const output = plain(renderToString(<QuestionPanel question={{question: 'Pick one', multiSelect, defaultSelected: ['Alpha'],
      options: [{label: 'Alpha', description: 'A long explanatory description'}, {label: 'Beta', description: 'Other'}]}}
      position={1} total={1} answered={0} width={width} height={14} onAnswer={() => {}} onCancel={() => {}} onToggleFold={() => {}}/>, {columns: width}));
    assert.match(output, /\[■\] Alpha/); assert.match(output, /\[ \] Beta/);
    assert.doesNotMatch(output, /[◉○●]/);
    assert.ok(output.split('\n').every(row => stringWidth(row) <= width));
  }
});

function colorAt(output: string, needle: string): string | undefined {
  let current: string | undefined, text = '';
  const colors: (string | undefined)[] = [];
  for (const token of output.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(';').map(Number);
      for (let at = 0; at < codes.length; at++) {
        if (codes[at] === 0 || codes[at] === 39) current = undefined;
        if (codes[at] === 38 && codes[at + 1] === 2) {
          current = '#' + codes.slice(at + 2, at + 5).map(value => value.toString(16).padStart(2, '0')).join(''); at += 4;
        }
      }
    } else {text += token[2]; for (let at = 0; at < token[2]!.length; at++) colors.push(current);}
  }
  const at = text.indexOf(needle); assert.ok(at >= 0, 'Missing text: ' + needle); return colors[at];
}

test('real multi-select renderers distinguish white checks, system focus and gray idle rows', () => {
  const level = chalk.level;
  try {
    chalk.level = 3;
    const options = ['Alpha', 'Beta', 'Gamma'].map(label => ({id: label, label, description: label + ' detail'}));
    const inline: Interaction = {...request, questions: [{id: 'checks', header: 'Checks', question: 'Choose checks', multiSelect: true, options}]};
    const card = renderToString(<QuestionCard request={inline} draft={draft} focused/>, {columns: 80});
    assert.equal(colorAt(card, 'Alpha'), '#ffffff'); assert.equal(colorAt(card, 'Alpha detail'), '#ffffff');
    assert.equal(colorAt(card, 'Beta'), palette.accent.toLowerCase()); assert.equal(colorAt(card, 'Beta detail'), palette.accent.toLowerCase());
    assert.equal(colorAt(card, 'Gamma'), palette.muted.toLowerCase());
    const preview = renderToString(<QuestionPanel question={{question: 'Choose checks', multiSelect: true, options, defaultSelected: ['Alpha', 'Beta']}}
      position={1} total={1} answered={0} width={80} height={18} onAnswer={() => {}} onCancel={() => {}} onToggleFold={() => {}}/>, {columns: 80});
    assert.equal(colorAt(preview, 'Alpha'), palette.accent.toLowerCase(), 'Focused checked item uses the system accent');
    assert.equal(colorAt(preview, 'Beta'), '#ffffff'); assert.equal(colorAt(preview, 'Beta detail'), '#ffffff');
    assert.equal(colorAt(preview, 'Gamma'), palette.muted.toLowerCase());
    const settings = renderToString(<ToggleList items={options.map((option, at) => ({id: option.id, label: option.label, enabled: at === 0}))}
      selected={1} start={0} count={3} width={60}/>, {columns: 60});
    assert.equal(colorAt(settings, 'Alpha'), '#ffffff'); assert.equal(colorAt(settings, 'Beta'), palette.accent.toLowerCase());
    assert.equal(colorAt(settings, 'Gamma'), palette.muted.toLowerCase());
  } finally {chalk.level = level;}
});

test('thinking strength uses the same boxes and retains the active tier on narrow screens', () => {
  for (const width of [20, 24, 28, 40, 52, 80]) {
    const output = plain(renderToString(<Picker title="Model" width={width} height={12} items={[
      {id: 'model', label: 'Model', effort: 'medium', effortLevels: ['off', 'low', 'medium', 'high', 'max', 'auto']},
    ]} onSelect={() => {}} onCancel={() => {}}/>, {columns: width}));
    const row = output.split('\n').find(line => line.includes('Thinking:') || (line.includes('✦ ') && line.includes('[■]')))!;
    assert.match(row, /\[■\]/); assert.match(row, /medium/); assert.doesNotMatch(row, /[○●]/);
    assert.ok(output.split('\n').every(line => stringWidth(line) <= width));
  }
});
