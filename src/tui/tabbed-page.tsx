import {useState} from 'react';
import stringWidth from 'string-width';
import {Box, Text, useInput} from 'ink';
import type {CommandTab, CommandToggle} from '../runtime/command-surface.js';
import {palette, safeText} from './cards.js';
import {layoutInput} from './editor.js';
import {clipLine} from './viewport.js';
import {CommandPane, panePadding} from './command-pane.js';
import {ToggleList, moveToggle} from './toggle-list.js';
import {useMouse} from './mouse.js';

export function TabbedPage({title, tabs, initialTab, width, height, onClose, onSave, saving = false, error = '', notice = ''}: {
  title: string; tabs: readonly CommandTab[]; initialTab: string; width: number; height: number; onClose(): void;
  onSave?(tabId: string, items: readonly CommandToggle[]): void; saving?: boolean; error?: string; notice?: string;
}) {
  const [active, setActive] = useState(initialTab);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [choices, setChoices] = useState<Record<string, readonly CommandToggle[]>>({});
  const [focused, setFocused] = useState<Record<string, number>>({});
  const index = Math.max(0, tabs.findIndex(tab => tab.id === active)), tab = tabs[index];
  const columns = Math.max(1, width - 2 * panePadding(width)), contentHeight = Math.max(1, height - 5);
  const lines = tab?.lines.flatMap(text => layoutInput({text: safeText(text), cursor: 0}, columns).lines.map(line => line.text)) ?? [];
  const max = Math.max(0, lines.length - contentHeight), offset = Math.min(max, offsets[tab?.id ?? ''] ?? 0);
  const items = tab?.toggles ? choices[tab.id] ?? tab.toggles : undefined;
  const selected = Math.min(Math.max(0, (items?.length ?? 1) - 1), focused[tab?.id ?? ''] ?? 0);
  const toggleHeight = Math.max(1, contentHeight - 1);
  const start = Math.max(0, Math.min(selected - Math.floor(toggleHeight / 2), (items?.length ?? 0) - toggleHeight));
  const toggle = (at: number) => {if (tab && items && !saving) setChoices(previous => ({...previous, [tab.id]: items.map((item, index) => index === at ? {...item, enabled: !item.enabled} : item)}));};
  const reorder = (at: number, direction: number) => {
    if (!tab || !items || saving) return;
    const changed = moveToggle(items, at, direction);
    setChoices(previous => ({...previous, [tab.id]: changed.items})); setFocused(previous => ({...previous, [tab.id]: changed.index}));
  };
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {if (!saving) onClose(); return;}
    if (key.ctrl) return;
    if (saving) return;
    if ((key.tab || !items && (key.leftArrow || key.rightArrow)) && tabs.length) {
      setActive(tabs[(index + tabs.length + (key.leftArrow || key.tab && key.shift ? -1 : 1)) % tabs.length]!.id); return;
    }
    if (!tab) return;
    if (items) {
      if (key.upArrow || key.downArrow) setFocused(previous => ({...previous, [tab.id]: Math.max(0, Math.min(items.length - 1, selected + (key.upArrow ? -1 : 1)))}));
      else if (key.leftArrow || key.rightArrow) reorder(selected, key.leftArrow ? -1 : 1);
      else if (input === ' ') toggle(selected);
      else if (key.return) onSave?.(tab.id, items);
      return;
    }
    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = offset + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = offset + (key.pageUp ? -contentHeight : contentHeight);
    if (key.home || key.end) next = key.home ? 0 : max;
    if (next !== undefined) setOffsets(previous => ({...previous, [tab.id]: Math.max(0, Math.min(max, next))}));
  });
  useMouse(event => {
    if (event.action !== 'press' || event.button !== 0 || saving) return;
    const padding = panePadding(width), contentTop = 4;
    if (event.y === 2) {
      let column = padding;
      for (const candidate of tabs) {
        const end = column + stringWidth('  ' + candidate.title + '  ');
        if (event.x >= column && event.x < end) {setActive(candidate.id); return;}
        column = end;
      }
    }
    if (tab && items && event.y >= contentTop && event.y < contentTop + toggleHeight) {
      const at = start + event.y - contentTop;
      if (!items[at]) return;
      setFocused(previous => ({...previous, [tab.id]: at}));
      const x = event.x - padding;
      if (width >= 18 && x >= columns - 4) reorder(at, x < columns - 2 ? -1 : 1);
      else toggle(at);
    }
  });
  const footer = saving ? '正在保存…' : items ? '↑↓ 选择 · Space 开关 · ←→ 排序 · Enter 保存 · Tab 页签 · Esc 放弃' : '←→ / Tab 页签 · ↑↓ / PgUp PgDn 滚动 · Esc 返回';
  return <CommandPane title={title} width={width} height={height} footer={notice || footer}>
    <Box height={1} flexShrink={0} overflow="hidden">
      {stringWidth(tabs.map(item => '  ' + item.title + '  ').join('')) > columns ? <Text color={tab?.color ?? palette.accent} bold wrap="truncate">{clipLine('❯ ' + (tab?.title ?? '') + ' · ' + (index + 1) + '/' + tabs.length, columns)}</Text> : tabs.map(item => <Text key={item.id} bold={item.id === tab?.id} color={item.id === tab?.id ? item.color ?? palette.accent : palette.muted}>
        {(item.id === tab?.id ? '❯ ' : '  ') + item.title + '  '}
      </Text>)}
    </Box>
    <Box height={1} flexShrink={0}/>
    <Box height={contentHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      {items ? <>
        <ToggleList items={items} selected={selected} start={start} count={toggleHeight} width={columns} disabled={saving}/>
        <Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(error || '顺序同时决定窄屏显示优先级', columns)}</Text>
      </> : lines.slice(offset, offset + contentHeight).map((line, i) => <Box key={i} height={1} flexShrink={0}><Text color={offset + i === 0 ? tab?.color ?? palette.fg : palette.fg} wrap="truncate">{clipLine(line, columns) || ' '}</Text></Box>)}
    </Box>
  </CommandPane>;
}
