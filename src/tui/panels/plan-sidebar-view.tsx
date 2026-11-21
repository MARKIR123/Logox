// Ink drawing of the plan sidebar's lines, for the two places the terminal plane does not paint them: the overlay a narrow terminal opens, and a timeline
// without a plane (a plain Ink render). The lines come from `plan-sidebar.ts:paintSidebar`; this file only turns segments into `Text`.
import {Box, Text} from 'ink';
import {palette} from '../appearance/theme.js';
import {formatClock} from '../terminal/text.js';
import type {SideSegment} from '../terminal/terminal-plane.js';

export function SideLine({line, now = Date.now()}: {line: readonly SideSegment[] | undefined; now?: number}) {
  return <Text wrap="truncate">{(line ?? []).map((segment, at) => <Text key={at} {...(segment.color ? {color: segment.color} : {})} {...(segment.bg ? {backgroundColor: segment.bg} : {})} bold={Boolean(segment.bold)} italic={Boolean(segment.italic)}>
    {segment.clock === undefined ? segment.text : formatClock(now - segment.clock).padEnd(segment.text.length)}</Text>)}</Text>;
}

export function SideLines({lines}: {lines: readonly (readonly SideSegment[])[]}) {
  const now = Date.now();
  return <Box flexDirection="column" flexShrink={0}>{lines.map((line, index) => <Box key={index} height={1} flexShrink={0} overflow="hidden"><SideLine line={line} now={now}/></Box>)}</Box>;
}

/** The sidebar as a panel on the right edge of the screen; the rest of the screen is a muted hint and a click target that closes it. */
export function PlanOverlay({lines, x, width, height}: {lines: readonly (readonly SideSegment[])[]; x: number; width: number; height: number}) {
  return <Box flexDirection="row" width={x + width} height={height} overflow="hidden">
    <Box width={x} height={height} flexShrink={0} flexDirection="column">{x > 0 ? <Text color={palette.muted} wrap="truncate">{' Tasks · Esc or Ctrl+B closes'}</Text> : null}</Box>
    <SideLines lines={lines}/>
  </Box>;
}
