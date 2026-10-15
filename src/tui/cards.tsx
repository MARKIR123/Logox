import {memo, type ReactNode} from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import type {Activity, Interaction} from '../runtime/contracts.js';
import {cast} from '../actors/ensemble.js';
import {deriveActorCardColors} from '../actors/definitions.js';
export interface ActorStyle {
  readonly symbol: string;
  readonly name: string;
  readonly title: string;
  readonly color: string;
  readonly cardClosed?: string | undefined;
  readonly cardOpen?: string | undefined;
}
export type ActorStyles = Readonly<Record<string, ActorStyle>>;

export const palette = {
  toolExpanded: '#22252a',
  bg: '#1b1c1d',
  cardBase: '#483c27',
  cardCollapsed: '#483c27',
  cardExpanded: '#5c4d32',
  dreamCollapsed: '#c4cbd2',
  dreamExpanded: '#dce2e8',
  fg: '#ebeef2',
  accent: '#d97757',
  user: '#5282b5',
  anamnesis: '#dce2e8',
  dreamText: '#1e262e',
  dreamMuted: '#4b5660',
  muted: '#b8c4ce',
  borderMuted: '#3e4450',
  line: '#3b3e3c',
  error: '#e08b90',
  question: '#e8a8dc',
  selectionBg: '#2b3b4e',
};

export function applyTheme(themeOverrides?: Partial<{user: string; accent: string; dream_collapsed: string; dream_expanded: string}>): typeof palette {
  if (themeOverrides) {
    if (themeOverrides.user) (palette as any).user = themeOverrides.user;
    if (themeOverrides.accent) (palette as any).accent = themeOverrides.accent;
    if (themeOverrides.dream_collapsed) (palette as any).dreamCollapsed = themeOverrides.dream_collapsed;
    if (themeOverrides.dream_expanded) (palette as any).dreamExpanded = themeOverrides.dream_expanded;
  }
  return palette;
}

export const actorCardPalette = {
  logox: {closed: '#4d3227', open: '#613e31', highlight: '#d97757'},
  aletheia: {closed: '#2c473d', open: '#395c4f', highlight: '#7ee7c4'},
  techne: {closed: '#483c27', open: '#5c4d32', highlight: '#e5b567'},
  kalon: {closed: '#544359', open: '#66526c', highlight: '#e8a8dc'},
} as const;

export function ownerSurface(ownerId: string, expanded: boolean, roles: ActorStyles = cast): string | undefined {
  if (ownerId === 'anamnesis') return expanded ? palette.dreamExpanded : palette.dreamCollapsed;
  if (ownerId !== 'logox' && roles[ownerId]) {
    const role = roles[ownerId]!;
    if (role.cardClosed && role.cardOpen) {
      return expanded ? role.cardOpen : role.cardClosed;
    }
    if (Object.hasOwn(actorCardPalette, ownerId)) {
      const colors = actorCardPalette[ownerId as keyof typeof actorCardPalette];
      return expanded ? colors.open : colors.closed;
    }
    const derived = deriveActorCardColors(role.color, role.cardClosed, role.cardOpen);
    return expanded ? derived.open : derived.closed;
  }
  if (Object.hasOwn(actorCardPalette, ownerId)) {
    const colors = actorCardPalette[ownerId as keyof typeof actorCardPalette];
    return expanded ? colors.open : colors.closed;
  }
  return undefined;
}
const labels = {
  queued: '排队',
  running: '运行中',
  waiting_input: '等待回答',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
export function safeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const num = Number.parseInt(clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
export function mixHex(fgHex: string, bgHex = palette.cardBase, ratio = 0.22): string {
  const [fr, fg, fb] = parseHex(fgHex);
  const [br, bg, bb] = parseHex(bgHex);
  const channel = (f: number, b: number) => Math.max(0, Math.min(255, Math.round(b + (f - b) * ratio))).toString(16).padStart(2, '0');
  return `#${channel(fr, br)}${channel(fg, bg)}${channel(fb, bb)}`;
}
export function ownerColor(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return palette.user;
  if (ownerId === 'anamnesis') return palette.anamnesis;
  return roles[ownerId]?.color ?? palette.accent;
}
export function ownerHeader(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return '你';
  if (ownerId === 'anamnesis') return 'Anamnesis · 入梦';
  if (roles[ownerId]) {
    const actor = roles[ownerId];
    return `${actor.symbol} ${actor.name}`;
  }
  return ownerId;
}
export function Card({title, color = palette.accent, bg, paddingY = 0, children}: {
  title: string;
  color?: string;
  bg?: string;
  paddingY?: number;
  children: ReactNode;
}) {
  return <Box flexDirection="column" flexShrink={0} paddingX={2} paddingY={paddingY} {...(bg ? {backgroundColor: bg} : {})}>
    <Text bold color={color} {...(bg ? {backgroundColor: bg} : {})}>{safeText(title)}</Text>
    {children}
  </Box>;
}
export const ActivityCard = memo(function ActivityCard({activity, expanded = false, hovered = false}: {activity: Activity; expanded?: boolean; hovered?: boolean}) {
  const isDream = activity.kind === 'anamnesis' || activity.ownerId === 'anamnesis';
  const bright = expanded || hovered;
  const color = isDream ? palette.dreamText : ownerColor(activity.ownerId);
  const textColor = isDream ? palette.dreamText : bright ? color : palette.fg;
  const mutedColor = isDream ? palette.dreamMuted : palette.muted;
  const bg = isDream
    ? ownerSurface('anamnesis', bright)
    : activity.kind === 'actor'
      ? ownerSurface(activity.ownerId, bright)
      : undefined;
  const prefix = Object.hasOwn(cast, activity.ownerId)
    ? `${cast[activity.ownerId as keyof typeof cast].symbol} `
    : '';
  const heading = activity.title.startsWith(prefix.trim()) ? activity.title : prefix + activity.title;
  return <Card title={`${heading} · ${labels[activity.status]}`} paddingY={0} color={color} {...(bg ? {bg} : {})}>
    <Text color={activity.status === 'failed' ? palette.error : textColor} {...(bg ? {backgroundColor: bg} : {})}>{safeText(activity.stage)}</Text>
    {expanded && activity.detail && <Text color={mutedColor} {...(bg ? {backgroundColor: bg} : {})}>{safeText(activity.detail)}</Text>}
  </Card>;
});
// All choice controls share a marker and text highlight; their surface stays unchanged.
export function choiceStyle(selected: boolean, accent = palette.accent, textColor = palette.fg, mutedColor = palette.muted) {
  const marker = '❯ ';
  const indent = stringWidth(marker);
  return {marker: selected ? marker : ' '.repeat(indent), indent,
    color: selected ? accent : textColor, descriptionColor: selected ? accent : mutedColor};
}
export interface QuestionDraft {questionIndex: number; selected: number; text: string; error: string}
export const InteractionCard = memo(function InteractionCard({request, draft, focused}: {
  request: Interaction; draft: QuestionDraft; focused: boolean;
}) {
  const isDream = request.ownerId === 'anamnesis';
  const color = isDream ? palette.dreamText : ownerColor(request.ownerId);
  const textColor = isDream ? palette.dreamText : palette.fg;
  const mutedColor = isDream ? palette.dreamMuted : palette.muted;
  const bg = ownerSurface(request.ownerId, focused) ?? (focused ? palette.cardExpanded : palette.cardCollapsed);
  const title = `${ownerHeader(request.ownerId)} · ${request.title}`;
  if (request.kind === 'permission') return <Card title={title} color={color} bg={bg}>
    <Text color={textColor} backgroundColor={bg}>{safeText(request.reason)}</Text>
    <Text color={mutedColor} backgroundColor={bg}>工具：{safeText(request.tool)} · {safeText(JSON.stringify(request.arguments))}</Text>
    {[{label: '仅本次允许', description: '只允许这一次工具执行。'}, {label: '拒绝（默认）', description: '保留建议，不执行该工具。'}].map((option, index) => {
      const style = choiceStyle(draft.selected === index, color, textColor, mutedColor);
      return <Box key={option.label} flexDirection="column" backgroundColor={bg} marginTop={1} marginBottom={index === 1 ? 1 : 0}>
        <Text color={style.color}>{style.marker}{option.label}</Text>
        <Box paddingLeft={style.indent}><Text color={style.descriptionColor}>{option.description}</Text></Box>
      </Box>;
    })}
    <Text color={mutedColor} backgroundColor={bg}>{focused ? '↑↓ 选择 · Enter 确认许可 · Esc 稍后回答 · Ctrl+X 取消' : 'Tab 聚焦回答 · 主输入仍可编辑'}</Text>
  </Card>;
  const question = request.questions[draft.questionIndex];
  if (!question) return null;
  const options = question.options ?? [];
  return <Card title={title} color={color} bg={bg}>
    <Text color={mutedColor} backgroundColor={bg}>{question.header} · {draft.questionIndex + 1}/{request.questions.length}</Text>
    <Text color={textColor} backgroundColor={bg}>{safeText(question.question)}</Text>
    {options.map((option, index) => {
      const style = choiceStyle(draft.selected === index, color, textColor, mutedColor);
      return <Box key={option.id} flexDirection="column" backgroundColor={bg} marginTop={1}>
        <Text color={style.color}>{style.marker}{safeText(option.label)}</Text>
        <Box paddingLeft={style.indent}><Text color={style.descriptionColor}>{safeText(option.description)}</Text></Box>
      </Box>;
    })}
    <Text color={choiceStyle(draft.selected === options.length, color, textColor, mutedColor).color} backgroundColor={bg}>{choiceStyle(draft.selected === options.length, color, textColor, mutedColor).marker}自由输入：{safeText(draft.text) || '…'}</Text>
    {draft.error && <Text color={palette.error} backgroundColor={bg}>{draft.error}</Text>}
    <Text color={mutedColor} backgroundColor={bg}>{focused ? '↑↓ 选择 · Enter 确认回答 · Esc 稍后回答 · Ctrl+X 取消' : 'Tab 聚焦回答 · 主输入仍可编辑'}</Text>
  </Card>;
});
