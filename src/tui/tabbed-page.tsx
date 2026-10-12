import {useState} from 'react';
import stringWidth from 'string-width';
import {Box, Text, useInput} from 'ink';
import type {CommandTab} from '../runtime/command-surface.js';
import {palette, safeText} from './cards.js';
import {layoutInput} from './editor.js';
import {clipLine} from './viewport.js';
import {CommandPane, panePadding} from './command-pane.js';

export function TabbedPage({title, tabs, initialTab, width, height, onClose}: {
  title: string; tabs: readonly CommandTab[]; initialTab: string; width: number; height: number; onClose(): void;
}) {
  const [active, setActive] = useState(initialTab);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const index = Math.max(0, tabs.findIndex(tab => tab.id === active)), tab = tabs[index];
  const columns = Math.max(1, width - 2 * panePadding(width)), contentHeight = Math.max(1, height - 5);
  const lines = tab?.lines.flatMap(text => layoutInput({text: safeText(text), cursor: 0}, columns).lines.map(line => line.text)) ?? [];
  const max = Math.max(0, lines.length - contentHeight), offset = Math.min(max, offsets[tab?.id ?? ''] ?? 0);
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || key.ctrl && input === 'c') {onClose(); return;}
    if ((key.leftArrow || key.rightArrow || key.tab) && tabs.length) {
      setActive(tabs[(index + tabs.length + (key.leftArrow || key.tab && key.shift ? -1 : 1)) % tabs.length]!.id); return;
    }
    if (!tab) return;
    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = offset + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = offset + (key.pageUp ? -contentHeight : contentHeight);
    if (key.home || key.end) next = key.home ? 0 : max;
    if (next !== undefined) setOffsets(previous => ({...previous, [tab.id]: Math.max(0, Math.min(max, next))}));
  });
  return <CommandPane title={title} width={width} height={height} footer="←→ / Tab 页签 · ↑↓ / PgUp PgDn 滚动 · Esc 返回">
    <Box height={1} flexShrink={0} overflow="hidden">
      {stringWidth(tabs.map(item => '  ' + item.title + '  ').join('')) > columns ? <Text color={palette.accent} bold wrap="truncate">{clipLine('❯ ' + (tab?.title ?? '') + ' · ' + (index + 1) + '/' + tabs.length, columns)}</Text> : tabs.map(item => <Text key={item.id} bold={item.id === tab?.id} color={item.id === tab?.id ? palette.accent : palette.muted}>
        {(item.id === tab?.id ? '❯ ' : '  ') + item.title + '  '}
      </Text>)}
    </Box>
    <Box height={1} flexShrink={0}/>
    <Box height={contentHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      {lines.slice(offset, offset + contentHeight).map((line, i) => <Box key={i} height={1} flexShrink={0}><Text color={palette.fg} wrap="truncate">{clipLine(line, columns) || ' '}</Text></Box>)}
    </Box>
  </CommandPane>;
}
