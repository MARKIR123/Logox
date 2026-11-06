import type {ReactNode} from 'react';
import {Box, Text} from 'ink';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import {clipLine} from '../terminal/text.js';
import stringWidth from 'string-width';
import {inRegion, type Pointer, type Region} from '../terminal/mouse.js';

export function panePadding(width: number): number {return width >= 8 ? 2 : 0;}
/** Rows of the frame: the body starts under the rule and title, and the footer follows the body. */
export function panelRows(height: number, docked = false): {readonly bodyY: number; readonly bodyHeight: number; readonly footerY: number} {
  const bodyHeight = Math.max(0, height - (!docked && height >= 4 ? 4 : 3));
  return {bodyY: 2, bodyHeight, footerY: 2 + bodyHeight};
}
/** A clickable label inside the footer hint text. */
export interface FooterAction {readonly label: string; readonly run: () => void}
export interface FooterPart {readonly text: string; readonly region?: Region; readonly run?: () => void}
/** Splits the (clipped) footer into plain and clickable parts; regions are in screen cells for a frame whose top is `top`. */
export function footerParts(text: string, actions: readonly FooterAction[], width: number, top: number, height: number, docked = false): readonly FooterPart[] {
  const padding = panePadding(width), columns = Math.max(1, width - padding * 2), y = top + panelRows(height, docked).footerY;
  const clipped = clipLine(text, columns), parts: FooterPart[] = [];
  let at = 0;
  for (const action of actions) {
    const index = clipped.indexOf(action.label, at);
    if (index < 0) continue;
    if (index > at) parts.push({text: clipped.slice(at, index)});
    const x0 = padding + stringWidth(clipped.slice(0, index));
    parts.push({text: action.label, region: {y, x0, x1: x0 + stringWidth(action.label)}, run: action.run});
    at = index + action.label.length;
  }
  if (at < clipped.length) parts.push({text: clipped.slice(at)});
  return parts;
}
export function hitFooter(parts: readonly FooterPart[], pointer: Pointer | null): FooterPart | undefined {
  return parts.find(part => part.region !== undefined && inRegion(pointer, part.region));
}
/** Shared whitespace and fixed viewport; content components own their keyboard behavior. */
export function PanelFrame({title, width, height, footer, children, docked = false, parts, hovered, hoverColor}: {
  title: string; width: number; height: number; footer: string; children: ReactNode; docked?: boolean;
  /** Footer split into clickable parts (already clipped); `hovered` takes `hoverColor`. */
  parts?: readonly FooterPart[]; hovered?: FooterPart | undefined; hoverColor?: string;
}) {
  const padding = panePadding(width), columns = Math.max(1, width - padding * 2);
  const bottomRule = !docked && height >= 4;
  const rule = <Box height={1} flexShrink={0}><Text color={palette.accent} wrap="truncate">{'─'.repeat(width)}</Text></Box>;
  return <Box width={width} height={height} flexShrink={0} overflow="hidden" flexDirection="column">
    {rule}
    <Box height={1} flexShrink={0} paddingX={padding}><Text bold color={palette.accent} wrap="truncate">{clipLine(safeText(title), columns)}</Text></Box>
    <Box height={Math.max(0, height - (bottomRule ? 4 : 3))} flexShrink={0} overflow="hidden" flexDirection="column" paddingX={padding}>{children}</Box>
    <Box height={1} flexShrink={0} paddingX={padding}><Text color={palette.muted} wrap="truncate">{parts
      ? parts.map((part, index) => <Text key={index} {...(part === hovered && hoverColor ? {color: hoverColor, bold: true} : {})}>{part.text}</Text>)
      : clipLine(footer, columns)}</Text></Box>
    {bottomRule && rule}
  </Box>;
}
