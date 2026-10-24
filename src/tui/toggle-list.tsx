import React, {type ReactElement} from 'react';
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

export function cycleToggleOption(item: CommandToggle, direction: number): CommandToggle {
  if (!item.options || item.options.length === 0) return item;
  const currentIndex = item.value ? item.options.indexOf(item.value) : -1;
  const nextIndex = (currentIndex + direction + item.options.length) % item.options.length;
  const nextVal = item.options[nextIndex];
  return {...item, ...(nextVal !== undefined ? {value: nextVal} : {})};
}

/** Choice focus and selection are independent: ❯ marks focus, the square marks the saved choice. */
export function ToggleList({items, selected, start, count, width, disabled = false}: {
  items: readonly CommandToggle[]; selected: number; start: number; count: number; width: number; disabled?: boolean;
}): ReactElement {
  return (
    <Box flexDirection="column" height={count} overflow="hidden">
      {items.slice(start, start + count).map((item, offset) => {
        const focused = selected === start + offset;
        const hasOptions = Boolean(item.options && item.options.length > 0);
        const controls = (hasOptions || width >= 18) ? ' ‹ ›' : '';
        const controlsWidth = stringWidth(controls);
        const label = safeText(toggleLabel(item));

        if (item.value !== undefined) {
          // Value option line (e.g. Theme, Cursor)
          const displayText = clipLine(`${label}: ${item.value}`, Math.max(1, width - 4 - controlsWidth));
          const totalContentWidth = stringWidth((focused ? '❯ ' : '  ') + displayText);
          const spacer = ' '.repeat(Math.max(0, width - totalContentWidth - controlsWidth));

          return (
            <Box key={item.id} height={1} flexShrink={0}>
              <Text wrap="truncate">
                {focused ? <Text color={palette.accent}>❯ </Text> : <Text>  </Text>}
                <Text color={disabled ? palette.muted : focused ? '#ffffff' : palette.muted} bold={focused}>
                  {displayText}
                </Text>
                <Text>{spacer}</Text>
                <Text color={focused && !disabled ? palette.accent : palette.muted}>{controls}</Text>
              </Text>
            </Box>
          );
        }

        // Boolean toggle line
        const displayLabel = clipLine(label, Math.max(1, width - 8 - controlsWidth));
        const checkMark = item.enabled ? '[■] ' : '[ ] ';
        const totalContentWidth = stringWidth((focused ? '❯ ' : '  ') + checkMark + displayLabel);
        const spacer = ' '.repeat(Math.max(0, width - totalContentWidth - controlsWidth));

        return (
          <Box key={item.id} height={1} flexShrink={0}>
            <Text wrap="truncate">
              {focused ? <Text color={palette.accent}>❯ </Text> : <Text>  </Text>}
              <Text color={disabled ? palette.muted : item.enabled ? palette.accent : palette.muted}>
                {checkMark}
              </Text>
              <Text color={disabled ? palette.muted : focused ? '#ffffff' : palette.muted} bold={focused}>
                {displayLabel}
              </Text>
              <Text>{spacer}</Text>
              <Text color={focused && !disabled ? palette.accent : palette.muted}>{controls}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
