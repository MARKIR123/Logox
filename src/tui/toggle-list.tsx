import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import type {CommandToggle} from '../runtime/command-surface.js';
import {statusbarLabels, type StatusbarId} from '../config/statusbar-preferences.js';
import {palette, safeText} from './cards.js';
import {clipLine} from './viewport.js';

export function toggleLabel(item: CommandToggle): string {
  return item.label ?? (Object.hasOwn(statusbarLabels, item.id) ? statusbarLabels[item.id as StatusbarId] : item.id);
}
export function moveToggle(items: readonly CommandToggle[], index: number, direction: number): {items: readonly CommandToggle[]; index: number} {
  const next = Math.max(0, Math.min(items.length - 1, index + direction)), reordered = [...items];
  if (next !== index) [reordered[index], reordered[next]] = [reordered[next]!, reordered[index]!];
  return {items: reordered, index: next};
}
/** Choice focus and selection are independent: ❯ marks focus, the square marks the saved choice. */
export function ToggleList({items, selected, start, count, width, disabled = false}: {
  items: readonly CommandToggle[]; selected: number; start: number; count: number; width: number; disabled?: boolean;
}) {
  const controls = width >= 18 ? ' ‹ ›' : '', controlsWidth = stringWidth(controls);
  return <Box flexDirection="column" height={count} overflow="hidden">
    {items.slice(start, start + count).map((item, offset) => {
      const focused = selected === start + offset;
      const label = clipLine(safeText(toggleLabel(item)), Math.max(1, width - 7 - controlsWidth));
      const content = (focused ? '❯ ' : '  ') + (item.enabled ? '[■] ' : '[ ] ') + label;
      return <Box key={item.id} height={1} flexShrink={0}><Text wrap="truncate">
        <Text color={disabled ? palette.muted : item.enabled || focused ? palette.accent : palette.fg} bold={item.enabled}>{content}</Text>
        <Text>{' '.repeat(Math.max(0, width - stringWidth(content) - controlsWidth))}</Text>
        <Text color={focused && !disabled ? palette.accent : palette.muted}>{controls}</Text>
      </Text></Box>;
    })}
  </Box>;
}
