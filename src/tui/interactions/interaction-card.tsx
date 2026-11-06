import {memo, type ReactNode} from 'react';
import {Box, Text} from 'ink';
import type {Interaction} from '../../runtime/contracts.js';
import {QuestionCard} from '../../tools/AskUserQuestionTool/QuestionCard.js';
import {palette} from '../appearance/theme.js';
import {ownerColor, ownerHeader, ownerSurface} from '../appearance/actor-style.js';
import {safeText} from '../terminal/text.js';
import type {QuestionDraft} from './choice-style.js';
import {approvalHint, approvalModel, noteSegments, optionLabelWidth, optionSegments, riskSegments, targetSegments, type ApprovalSegment} from './approval-view.js';

const draw = (segments: readonly ApprovalSegment[], bg?: string) => <Text wrap="truncate-end" {...(bg ? {backgroundColor: bg} : {})}>{segments.map((segment, at) =>
  <Text key={at} color={segment.color} bold={segment.bold === true} italic={segment.italic === true}>{segment.text}</Text>)}</Text>;

/** Rows of the approval card below the pinned part (options, note, hint), with the index of the row holding the selection. */
export function approvalBody(request: Extract<Interaction, {kind: 'permission'}>, draft: QuestionDraft, accent: string, actorName: string, focused: boolean) {
  const model = approvalModel(request, actorName), width = optionLabelWidth(model), rows: {key: string; segments: ApprovalSegment[]; selected?: boolean}[] = [];
  model.options.forEach((option, index) => {
    rows.push({key: option.id, segments: optionSegments(option, index === draft.selected, width, accent), selected: index === draft.selected});
    if (option.id === 'deny' && draft.noting) rows.push({key: 'note', segments: [{text: '    ', color: palette.muted}, ...noteSegments(actorName, draft.text)]});
  });
  return {model, rows, hint: focused ? approvalHint(draft.noting === true) : 'Tab Focus answer · Main input still editable'};
}

export const InteractionCard = memo(function InteractionCard({request, draft, focused, height}: {request: Interaction; draft: QuestionDraft; focused: boolean; height?: number}) {
  const isDream = request.ownerId === 'anamnesis';
  const color = isDream ? palette.dreamText : ownerColor(request.ownerId);
  const mutedColor = isDream ? palette.dreamMuted : palette.muted;
  const bg = ownerSurface(request.ownerId, focused) ?? (focused ? palette.cardExpanded : palette.cardCollapsed);
  if (request.kind === 'permission') {
    const header = ownerHeader(request.ownerId), actorName = header.replace(/^\S+\s+/, '');
    const body = approvalBody(request, draft, color, actorName, focused);
    const pinned: ReactNode[] = [
      <Box key="title" justifyContent="space-between" backgroundColor={bg}>
        <Text wrap="truncate-end"><Text bold color={color}>{safeText(header)}</Text><Text color={mutedColor}> wants to run · </Text><Text bold color={palette.fg}>{body.model.tool}</Text></Text>
        <Text color={palette.warning}> Awaiting approval</Text>
      </Box>,
      <Box key="target" paddingLeft={2} backgroundColor={bg}>{draw(targetSegments(body.model), bg)}</Box>,
      <Box key="risk" paddingLeft={2} backgroundColor={bg}>{draw(riskSegments(body.model), bg)}</Box>,
    ];
    // A short viewport keeps the title and reason; only the options scroll, always showing the selection.
    const list = body.rows, room = height === undefined ? Infinity : Math.max(1, height - pinned.length - 3);
    const selectedAt = Math.max(0, list.findIndex(row => row.selected));
    const start = list.length <= room ? 0 : Math.max(0, Math.min(list.length - room, selectedAt - Math.floor(room / 2)));
    const visible = list.slice(start, start + (Number.isFinite(room) ? room : list.length));
    return <Box flexDirection="column" flexShrink={0} paddingX={2} backgroundColor={bg}>
      {pinned}
      <Box height={1} backgroundColor={bg}><Text> </Text></Box>
      {visible.map(row => <Box key={row.key} backgroundColor={bg}>{draw(row.segments, bg)}</Box>)}
      {draft.error ? <Text color={palette.error} backgroundColor={bg}>{draft.error}</Text> : null}
      <Box height={1} backgroundColor={bg}><Text> </Text></Box>
      <Text color={mutedColor} italic backgroundColor={bg}>{body.hint}</Text>
    </Box>;
  }
  return <QuestionCard request={request} draft={draft} focused={focused}/>;
});
