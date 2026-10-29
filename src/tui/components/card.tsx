import type {ReactNode} from 'react';
import {Box, Text} from 'ink';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';

/** A neutral surface: no Actor identity, runtime state or task policy. */
export function Card({title, color = palette.accent, bg, paddingY = 0, children}: {
  title: string; color?: string; bg?: string; paddingY?: number; children: ReactNode;
}) {
  return <Box flexDirection="column" flexShrink={0} paddingX={2} paddingY={paddingY} {...(bg ? {backgroundColor: bg} : {})}>
    <Text bold color={color} {...(bg ? {backgroundColor: bg} : {})}>{safeText(title)}</Text>
    {children}
  </Box>;
}
