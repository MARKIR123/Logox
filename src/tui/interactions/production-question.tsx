import {Box, Text} from 'ink';
import {buildQuestionRows, AnswerCaret, type PanelQuestion} from './question-panel.js';
import {useMouse} from '../terminal/mouse.js';
import {safeText} from '../terminal/text.js';

export interface ProductionQuestionDraft {
  readonly selected: number;
  readonly checked?: readonly number[] | undefined;
  readonly text: string;
  readonly error: string;
}

/** Production view over the existing runtime draft; App remains the keyboard owner. */
export function ProductionQuestionPanel({question, position, total, width, height, y, draft, cursor, focused,
  onSelect, onMove, onFocusInput}: {
  readonly question: PanelQuestion;
  readonly position: number;
  readonly total: number;
  readonly width: number;
  readonly height: number;
  readonly y: number;
  readonly draft: ProductionQuestionDraft;
  readonly cursor: number;
  readonly focused: boolean;
  readonly onSelect: (index: number) => void;
  readonly onMove: (delta: number) => void;
  readonly onFocusInput: () => void;
}) {
  const multi = question.multiSelect === true;
  const options = question.options ?? [];
  const hint = multi ? '↑↓ Move · Space Toggle · Enter Submit · Tab Input · Esc Back'
    : options.length ? '↑↓ Select · Enter Submit · Tab Input · Esc Back' : 'Enter Submit · Esc Back';
  const view = buildQuestionRows({question: {...question, inputLabel: question.secret ? 'Input' : 'My view'},
    position, total, width, height, y, focus: draft.selected, checked: draft.checked ?? [],
    text: safeText(draft.text), cursor, error: draft.error, hint, foldAction: false});
  useMouse(event => {
    if (event.x < 0 || event.x >= width || event.y < y || event.y >= y + Math.min(height, view.rows.length)) return;
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {onMove(event.action === 'wheel_down' ? 1 : -1); return;}
    if (event.action !== 'press' || event.button !== 0) return;
    const action = view.rows[event.y - y]?.action;
    if (action === 'input') onFocusInput();
    else if (typeof action === 'number') onSelect(action);
  });
  return <Box width={width} height={Math.min(height, view.rows.length)} flexDirection="column" flexShrink={0} overflow="hidden">
    {focused && view.caret && <AnswerCaret position={view.caret}/>}
    {view.rows.slice(0, height).map((row, index) => <Box key={index} width={width} height={1} flexShrink={0}>
      <Text wrap="truncate">{row.segments.map((segment, at) =>
        <Text key={at} color={segment.color} bold={Boolean(segment.bold)}>{segment.text}</Text>)}</Text>
    </Box>)}
  </Box>;
}
