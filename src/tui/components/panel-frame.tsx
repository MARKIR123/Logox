import type {ReactNode} from 'react';
import {Box, Text} from 'ink';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import {clipLine} from '../terminal/text.js';

export function panePadding(width: number): number {return width >= 8 ? 2 : 0;}
/** 共享留白与固定视口；内容组件各自拥有键盘行为。 */
export function PanelFrame({title, width, height, footer, children, docked = false}: {
  title: string; width: number; height: number; footer: string; children: ReactNode; docked?: boolean;
}) {
  const padding = panePadding(width), columns = Math.max(1, width - padding * 2);
  const bottomRule = !docked && height >= 4;
  const rule = <Box height={1} flexShrink={0}><Text color={palette.accent} wrap="truncate">{'─'.repeat(width)}</Text></Box>;
  return <Box width={width} height={height} flexShrink={0} overflow="hidden" flexDirection="column">
    {rule}
    <Box height={1} flexShrink={0} paddingX={padding}><Text bold color={palette.accent} wrap="truncate">{clipLine(safeText(title), columns)}</Text></Box>
    <Box height={Math.max(0, height - (bottomRule ? 4 : 3))} flexShrink={0} overflow="hidden" flexDirection="column" paddingX={padding}>{children}</Box>
    <Box height={1} flexShrink={0} paddingX={padding}><Text color={palette.muted} wrap="truncate">{clipLine(footer, columns)}</Text></Box>
    {bottomRule && rule}
  </Box>;
}
