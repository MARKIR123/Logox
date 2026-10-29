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
    <Text color={mutedColor} backgroundColor={bg}>工具：{safeText(request.tool)} · {safeText(JSON.stringify(request.arguments))}</Text>
    {[{label: '仅本次允许', description: '只允许这一次工具执行。'}, {label: '拒绝（默认）', description: '保留建议，不执行该工具。'}].map((option, index) => {
      const style = choiceStyle(draft.selected === index, color, textColor, mutedColor);
      return <Box key={option.label} flexDirection="column" backgroundColor={bg} marginTop={1} marginBottom={index === 1 ? 1 : 0}>
        <Text><Text color={style.markerColor}>{style.marker}</Text><Text color={style.color}>{option.label}</Text></Text>
        <Box paddingLeft={style.indent}><Text color={style.descriptionColor}>{option.description}</Text></Box>
      </Box>;
    })}
    <Text color={mutedColor} backgroundColor={bg}>{focused ? '↑↓ 选择 · Enter 确认许可 · Esc 稍后回答 · Ctrl+X 取消' : 'Tab 聚焦回答 · 主输入仍可编辑'}</Text>
  </Card>;
  return <QuestionCard request={request} draft={draft} focused={focused}/>;
});
