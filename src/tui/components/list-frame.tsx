import type {ReactNode} from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import {safeText, clipLine} from '../terminal/text.js';
import {useMouse} from '../terminal/mouse.js';

/** Space available between the two-column insets of a floating list. */
export function listContentWidth(columns: number): number {
  const width = Math.max(0, Math.floor(columns));
  return width < 8 ? width : width - 4;
}
export interface ListFrameProps {
  readonly title: string;
  readonly columns: number;
  readonly rows: readonly ReactNode[];
  readonly footer?: string | null;
  readonly y?: number;
  readonly onRowPick?: ((index: number) => void) | undefined;
  readonly onWheelStep?: ((direction: 1 | -1) => void) | undefined;
}

/** A top rule and inset rows. Coordinates describe this surface, never its business items. */
export function ListFrame({title, columns, rows, footer, y = 0, onRowPick, onWheelStep}: ListFrameProps) {
  const width = Math.max(1, Math.floor(columns));
  const label = ` ${safeText(title)} `;
  const hasTitle = stringWidth(label) + 3 <= width;
  const inset = width < 8 ? 0 : 2;
  useMouse(event => {
    if (event.x < 0 || event.x >= width || event.y < y || event.y >= y + rows.length + 1 + (footer ? 1 : 0)) return;
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {
      onWheelStep?.(event.action === 'wheel_up' ? -1 : 1);
    } else if (event.action === 'press' && event.button === 0) {
      const row = event.y - y - 1;
      if (row >= 0 && row < rows.length) onRowPick?.(row);
    }
  });
  return <Box flexDirection="column" width={width}>
    <Text wrap="truncate"><Text color={palette.line}>{hasTitle ? '─' : '─'.repeat(width)}</Text>{hasTitle && <><Text color={palette.accent}>{label}</Text><Text color={palette.line}>{'─'.repeat(width - stringWidth(label) - 1)}</Text></>}</Text>
    {rows.map((row, index) => <Box key={index} paddingLeft={inset} paddingRight={inset} width={width}><Text wrap="truncate">{row}</Text></Box>)}
    {footer && <Text color={palette.muted} wrap="truncate">{' '.repeat(inset)}{clipLine(safeText(footer), Math.max(0, width - inset * 2))}</Text>}
  </Box>;
}
