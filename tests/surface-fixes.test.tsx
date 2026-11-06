import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToString} from 'ink';
import {ProductionQuestionPanel} from '../src/tui/interactions/production-question.js';
import {TerminalPlane, type PlaneFrame} from '../src/tui/terminal/terminal-plane.js';
import type {PanelQuestion} from '../src/tui/interactions/question-panel.js';

const plain = (value: string) => value.replace(/\x1b\[[\d;]*m/g, '');
const question: PanelQuestion = {header: 'Scope', question: 'Which scope?', options: [{label: 'Only tui', description: 'small'}, {label: 'Everything', description: 'big'}]};
const render = (draft: {selected: number; checked?: readonly number[]; text: string; error: string}, multi = false) => plain(renderToString(
  <ProductionQuestionPanel question={{...question, ...(multi ? {multiSelect: true} : {})}} position={1} total={1} width={60} height={20} y={0}
    draft={draft} cursor={0} focused={false} onSelect={() => {}} onMove={() => {}} onFocusInput={() => {}}/>, {columns: 60}));

test('single-choice markers follow the selection, so they agree with the "Selected:" hint', () => {
  const second = render({selected: 1, text: '', error: ''});
  assert.match(second, /❯ \[■\] Everything/);
  assert.match(second, /\[ \] Only tui/);
  const first = render({selected: 0, text: '', error: ''});
  assert.match(first, /❯ \[■\] Only tui/);
  // A multi-choice question keeps its own check list.
  const multi = render({selected: 1, checked: [0], text: '', error: ''}, true);
  assert.match(multi, /\[■\] Only tui/);
  assert.match(multi, /❯ \[ \] Everything/);
});

test('the docked question panel ends without its own rule so only the composer hairline shows', () => {
  const lines = render({selected: 0, text: '', error: ''}).split('\n').map(line => line.trimEnd()).filter(Boolean);
  assert.ok(!/^─+$/.test(lines.at(-1)!), 'last row is the hint, not a second hairline');
});

test('the first content after an empty history paints at once instead of waiting for frame pacing', () => {
  const writes: string[] = [];
  const plane = new TerminalPlane(text => {writes.push(text);});
  plane.afterInkWrite('\x1b[?1049h');
  const frame = (rows: PlaneFrame['rows']): PlaneFrame => ({rows, start: 0, width: 20, height: 4, selection: null});
  plane.present(frame([]));
  const before = writes.length;
  const row = {segments: [{text: 'approval'}], gutterCols: 0, bg: undefined} as unknown as PlaneFrame['rows'][number];
  plane.present(frame([row]));
  assert.ok(writes.length > before, 'painted synchronously on first content');
  assert.ok(writes.join('').includes('approval'));
  plane.dispose();
});
