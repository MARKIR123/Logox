import {Box, Text} from 'ink';
import type {Interaction} from '../../runtime/contracts.js';
import {Card, choiceStyle, ownerColor, ownerHeader, ownerSurface, palette, safeText, type QuestionDraft} from '../../tui/cards.js';

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
  const custom = choiceStyle(draft.selected === options.length, color, textColor, muted);
  return <Card title={`${ownerHeader(request.ownerId)} · ${request.title}`} color={color} bg={bg}>
    <Text color={muted} backgroundColor={bg}>{question.header} · {draft.questionIndex + 1}/{request.questions.length}</Text>
    <Text color={textColor} backgroundColor={bg}>{safeText(question.question)}</Text>
    {options.map((option, index) => {
      const style = choiceStyle(draft.selected === index, color, textColor, muted);
      const marker = multi ? (draft.checked?.includes(index) ? '[x] ' : '[ ] ') : style.marker;
      return <Box key={option.id} flexDirection="column" backgroundColor={bg} marginTop={1}>
        <Text color={style.color}>{marker}{safeText(option.label)}</Text>
        <Box paddingLeft={style.indent}><Text color={style.descriptionColor}>{safeText(option.description)}</Text></Box>
      </Box>;
    })}
    <Text color={custom.color} backgroundColor={bg}>{custom.marker}Custom input: {safeText(draft.text) || '…'}</Text>
    {draft.error && <Text color={palette.error} backgroundColor={bg}>{draft.error}</Text>}
    <Text color={muted} backgroundColor={bg}>{focused ? (multi ? 'Space/Enter to toggle · Enter on Custom to confirm · Esc to defer · Ctrl+X to cancel' : '↑↓ Select · Enter to confirm · Esc to defer · Ctrl+X to cancel') : 'Tab to focus · Main input remains editable'}</Text>
  </Card>;
}
