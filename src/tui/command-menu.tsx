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
      const isSelected = index === selected;
      const labelWidth = stringWidth(item.label);
      const labelColumnTarget = 18;
      const paddingLength = Math.max(2, labelColumnTarget - labelWidth);
      const prefixWidth = 2; // "❯ " or "  "
      const maxDescWidth = Math.max(0, width - prefixWidth - labelWidth - paddingLength - 1);
      const description = item.description ? clipLine(item.description, maxDescWidth) : '';

      return <Box key={item.label} height={1} flexShrink={0} flexDirection="row">
        <Text {...(isSelected ? {color: palette.accent} : {})}>
          {isSelected ? '❯ ' : '  '}
        </Text>
        <Text color={isSelected ? '#ffffff' : palette.fg}>
          {item.label}
        </Text>
        {description ? (
          <>
            <Text>{' '.repeat(paddingLength)}</Text>
            <Text color="#8a95a0" dimColor={!isSelected}>
              {description}
            </Text>
          </>
        ) : null}
      </Box>;
    })}
  </Box>;
}
