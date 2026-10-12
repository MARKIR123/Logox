import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {palette} from './cards.js';
import {clipLine} from './viewport.js';
import type {CommandSuggestion} from './completion.js';

export function CommandMenu({items, selected, width}: {
  items: readonly CommandSuggestion[]; selected: number; width: number;
}) {
  return <Box height={items.length} flexShrink={0} flexDirection="column" overflow="hidden">
    {items.map((item, index) => {
      const labelColumns = Math.max(1, item.kind === 'argument' ? width - 2
        : Math.min(width - 2, 22, Math.max(16, Math.floor((width - 2) * 0.45))));
      const label = clipLine(item.label, labelColumns);
      const description = item.kind === 'argument' ? '' : clipLine(item.description, Math.max(0, width - labelColumns - 3));
      const content = description ? label + ' '.repeat(Math.max(1, labelColumns - stringWidth(label) + 1)) + description : label;
      return <Box key={item.label} height={1} flexShrink={0}>
        <Text color={index === selected ? palette.accent : palette.muted} wrap="truncate">
          {(index === selected ? '❯ ' : '  ') + content}
        </Text>
      </Box>;
    })}
  </Box>;
}
