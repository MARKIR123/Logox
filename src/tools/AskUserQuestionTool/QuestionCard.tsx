import {Box, Text} from 'ink';
import type {Interaction} from '../../runtime/contracts.js';
import {Card} from '../../tui/components/card.js';
import {choiceStyle, type QuestionDraft} from '../../tui/interactions/choice-style.js';
import {ownerColor, ownerHeader, ownerSurface} from '../../tui/appearance/actor-style.js';
import {palette} from '../../tui/appearance/theme.js';
import {safeText} from '../../tui/terminal/text.js';

export function QuestionCard({request, draft, focused}: {request: Interaction; draft: QuestionDraft; focused: boolean}) {
  if (request.kind !== 'question') return null;
  const question = request.questions[draft.questionIndex];
  if (!question) return null;
  const dream = request.ownerId === 'anamnesis';
  const color = dream ? palette.dreamText : ownerColor(request.ownerId);
  const textColor = dream ? palette.dreamText : palette.fg;
  const muted = dream ? palette.dreamMuted : palette.muted;
  const bg = ownerSurface(request.ownerId, focused) ?? (focused ? palette.cardExpanded : palette.cardCollapsed);
  const options = question.options ?? [];
  const multi = question.multiSelect === true;
  const customRow = !question.hideCustomInput || options.length === 0;
  const answerText = question.secret ? '•'.repeat([...draft.text].length) : safeText(draft.text);
  const custom = choiceStyle(draft.selected === options.length, color, textColor, muted, multi ? draft.selected === options.length : undefined);
  return <Card title={`${ownerHeader(request.ownerId)} · ${request.title}`} color={color} bg={bg}>
    <Text color={muted} backgroundColor={bg}>{question.header} · {draft.questionIndex + 1}/{request.questions.length}</Text>
    <Text color={textColor} backgroundColor={bg}>{safeText(question.question)}</Text>
    {question.detail ? <Text color={muted} backgroundColor={bg}>{safeText(question.detail)}</Text> : null}
    {question.link ? <Text color={muted} backgroundColor={bg}>{safeText(question.link)}</Text> : null}
    {options.map((option, index) => {
      const checked = multi ? draft.checked?.includes(index) === true : draft.selected === index;
      const style = choiceStyle(draft.selected === index, color, textColor, muted, multi ? checked : undefined);
      return <Box key={option.id} flexDirection="column" backgroundColor={bg} marginTop={1}>
        <Text><Text color={style.markerColor}>{style.marker}</Text><Text color={style.color}>{safeText(option.label)}</Text></Text>
        <Box paddingLeft={style.indent}><Text color={style.descriptionColor}>{safeText(option.description)}</Text></Box>
      </Box>;
    })}
    {customRow ? <Text backgroundColor={bg}><Text color={custom.markerColor}>{custom.marker}</Text><Text color={custom.color}>Custom input: {answerText || '…'}</Text></Text> : null}
    {draft.error && <Text color={palette.error} backgroundColor={bg}>{draft.error}</Text>}
    <Text color={muted} backgroundColor={bg}>{focused
      ? (multi ? 'Space/Enter to toggle · Enter on Custom to confirm · Esc to defer · Ctrl+X to cancel'
        : '↑↓ Select · Enter to confirm · Esc to defer · Ctrl+X to cancel')
      : 'Tab to focus · Main input remains editable'}</Text>
  </Card>;
}
