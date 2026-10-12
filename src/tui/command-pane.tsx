import type {ReactNode} from 'react';
import {Box, Text} from 'ink';
import {palette, safeText} from './cards.js';
import {clipLine} from './viewport.js';

export function panePadding(width: number): number {return width >= 8 ? 2 : 0;}
/** 共享留白与固定视口；内容组件各自拥有键盘行为。 */
export function CommandPane({title, width, height, footer, children}: {
  title: string; width: number; height: number; footer: string; children: ReactNode;
}) {
  const padding = panePadding(width), columns = Math.max(1, width - padding * 2);
  return <Box width={width} height={height} flexShrink={0} overflow="hidden" flexDirection="column" paddingX={padding}>
    <Box height={1} flexShrink={0}><Text color={palette.line}>{'─'.repeat(columns)}</Text></Box>
    <Box height={1} flexShrink={0}><Text bold color={palette.accent} wrap="truncate">{clipLine(safeText(title), columns)}</Text></Box>
    <Box height={Math.max(0, height - 3)} flexShrink={0} overflow="hidden" flexDirection="column">{children}</Box>
    <Box height={1} flexShrink={0}><Text color={palette.muted} wrap="truncate">{clipLine(footer, columns)}</Text></Box>
  </Box>;
}
