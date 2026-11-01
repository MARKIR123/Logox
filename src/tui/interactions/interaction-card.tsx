import {memo} from 'react';
import {Box, Text} from 'ink';
import type {Interaction} from '../../runtime/contracts.js';
import {QuestionCard} from '../../tools/AskUserQuestionTool/QuestionCard.js';
import {Card} from '../components/card.js';
import {palette} from '../appearance/theme.js';
import {ownerColor, ownerHeader, ownerSurface} from '../appearance/actor-style.js';
import {safeText} from '../terminal/text.js';
import {choiceStyle, type QuestionDraft} from './choice-style.js';

export const InteractionCard = memo(function InteractionCard({request, draft, focused}: {request: Interaction; draft: QuestionDraft; focused: boolean}) {
  const isDream = request.ownerId === 'anamnesis';
  const color = isDream ? palette.dreamText : ownerColor(request.ownerId);
  const textColor = isDream ? palette.dreamText : palette.fg, mutedColor = isDream ? palette.dreamMuted : palette.muted;
  const bg = ownerSurface(request.ownerId, focused) ?? (focused ? palette.cardExpanded : palette.cardCollapsed);
  const title = `${ownerHeader(request.ownerId)} · ${request.title}`;
  if (request.kind === 'permission') return <Card title={title} color={color} bg={bg}>
    <Text color={textColor} backgroundColor={bg}>{safeText(request.reason)}</Text>
    <Text color={mutedColor} backgroundColor={bg}>Tool: {safeText(request.tool)} · {safeText(JSON.stringify(request.arguments))}</Text>
    {[{label: 'Allow once', description: 'Allow this tool run only once.'}, {label: 'Deny (default)', description: 'Keep the suggestion; do not run the tool.'}].map((option, index) => {
      const style = choiceStyle(draft.selected === index, color, textColor, mutedColor);
      return <Box key={option.label} flexDirection="column" backgroundColor={bg} marginTop={1} marginBottom={index === 1 ? 1 : 0}>
        <Text><Text color={style.markerColor}>{style.marker}</Text><Text color={style.color}>{option.label}</Text></Text>
        <Box paddingLeft={style.indent}><Text color={style.descriptionColor}>{option.description}</Text></Box>
      </Box>;
    })}
    <Text color={mutedColor} backgroundColor={bg}>{focused ? '↑↓ Select · Enter Confirm · Esc Answer later · Ctrl+X Cancel' : 'Tab Focus answer · Main input still editable'}</Text>
  </Card>;
  return <QuestionCard request={request} draft={draft} focused={focused}/>;
});
