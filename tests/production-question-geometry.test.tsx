import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToString} from 'ink';
import {buildQuestionRows, type PanelQuestion} from '../src/tui/interactions/question-panel.js';
import {ProductionQuestionPanel} from '../src/tui/interactions/production-question.js';

const plain = (value: string) => value.replace(/\x1b\[[\d;]*m/g, '');
test('production question host renders planned columns exactly once, without a second inset', () => {
  const question: PanelQuestion = {header: 'Geometry', question: '0123456789'.repeat(8),
    options: [{label: 'A long selectable option across the viewport', description: 'Keep the trailing characters visible'}]};
  const draft = {selected: 1, checked: [0], text: 'abcdefghij'.repeat(8), error: ''};
  for (const width of [20, 40, 80]) {
    const height = 24;
    const expected = buildQuestionRows({question: {...question, inputLabel: 'My view'}, position: 1, total: 1,
      width, height, y: 0, focus: draft.selected, checked: draft.checked, text: draft.text, cursor: 80,
      error: '', hint: '↑↓ Select · Enter Submit · Tab Input · Esc Back', foldAction: false});
    const output = plain(renderToString(<ProductionQuestionPanel question={question} position={1} total={1}
      width={width} height={height} y={0} draft={draft} cursor={80} focused={false}
      onSelect={() => {}} onMove={() => {}} onFocusInput={() => {}}/>, {columns: width}));
    assert.deepEqual(output.split('\n').map(line => line.trimEnd()),
      expected.rows.map(row => row.segments.map(segment => segment.text).join('').trimEnd()), 'All planned content reaches the screen at width ' + width);
  }
});
