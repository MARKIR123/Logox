import {useState} from 'react';
import {Box, Text, useCursor, useInput, usePaste} from 'ink';
import stringWidth from 'string-width';
import type {PickerItem} from '../runtime/command-surface.js';
import {palette, safeText} from './cards.js';
import {clipLine} from './viewport.js';
import {emptyDraft, erase, graphemes, insert, type Draft} from './editor.js';
import {CommandPane, panePadding} from './command-pane.js';

export interface PickerProps {
  title: string; description?: string; items: readonly PickerItem[]; current?: string;
  status?: 'loading' | 'ready' | 'saving'; error?: string; emptyText?: string;
  width: number; height: number; y?: number;
  onSelect(id: string): void; onCancel(): void;
}
export function Picker({title, description = '', items, current = '', status = 'ready', error = '',
  emptyText = '没有匹配的选项', width, height, y = 0, onSelect, onCancel}: PickerProps) {
  const [search, setSearch] = useState<Draft>(emptyDraft);
  const [focused, setFocused] = useState(current);
  const filter = search.text.toLocaleLowerCase();
  const matches = items.filter(item => (item.label + ' ' + (item.description ?? '')).toLocaleLowerCase().includes(filter));
  const enabled = matches.filter(item => !item.disabled);
  const selected = enabled.find(item => item.id === focused) ?? enabled.find(item => item.id === current) ?? enabled[0];
  const index = matches.findIndex(item => item.id === selected?.id);
  const count = Math.max(1, height - 5);
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), matches.length - count));
  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding);
  const searchWidth = Math.max(1, columns - 6);
  let tail = search.text;
  while (stringWidth(tail) > searchWidth) tail = graphemes(tail).slice(1).join('');
  const {setCursorPosition} = useCursor();
  setCursorPosition(status === 'ready' && height >= 6 ? {x: Math.min(width - 1, padding + 6 + stringWidth(tail)), y: y + 3} : undefined);
  const edit = (next: Draft) => {if (next.text.length <= 512) {setSearch(next); setFocused('');}};
  usePaste(text => {if (status === 'ready') edit(insert(search, text.replace(/[\r\n]/g, ' ')));});
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || key.ctrl && input === 'c') {if (status !== 'saving') onCancel(); return;}
    if (status !== 'ready') return;
    if (key.return) {if (selected) onSelect(selected.id); return;}
    const at = enabled.findIndex(item => item.id === selected?.id);
    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = at + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = at + (key.pageUp ? -count : count);
    if (key.home || key.end) next = key.home ? 0 : enabled.length - 1;
    if (next !== undefined) {setFocused(enabled[Math.max(0, Math.min(enabled.length - 1, next))]?.id ?? ''); return;}
    if (key.backspace || key.delete) {edit(erase(search, true)); return;}
    if (key.ctrl && input === 'u') {edit(emptyDraft); return;}
    if (!key.ctrl && !key.meta && !key.tab && input) edit(insert(search, input));
  });
  const footer = status === 'saving' ? '正在应用选择…' : '↑↓ 选择 · Enter 确认 · Esc 返回';
  return <CommandPane title={title} width={width} height={height} footer={footer}>
    <Box height={1} flexShrink={0}><Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(safeText(error || description), columns)}</Text></Box>
    <Box height={1} flexShrink={0}><Text color={palette.fg} wrap="truncate">{'搜索：' + tail}</Text></Box>
    <Box height={count} flexShrink={0} flexDirection="column" overflow="hidden">
      {status === 'loading' ? <Text color={palette.muted}>正在查询…</Text> : matches.length ? matches.slice(start, start + count).map(item => {
        const active = item.id === selected?.id;
        const detail = clipLine(safeText(item.description ?? ''), Math.max(0, Math.min(24, Math.floor(columns / 3))));
        const labelColumns = Math.max(1, columns - 2 - (detail ? stringWidth(detail) + 2 : 0));
        const label = clipLine(safeText(item.label + (item.id === current ? ' · 当前' : '')), labelColumns);
        const content = label + (detail ? ' '.repeat(Math.max(2, labelColumns - stringWidth(label) + 2)) + detail : '');
        return <Box key={item.id} height={1} flexShrink={0}><Text color={item.disabled ? palette.muted : active ? palette.accent : palette.fg} wrap="truncate">
          {(active ? '❯ ' : '  ') + content}
        </Text></Box>;
      }) : <Text color={palette.muted} wrap="truncate">{emptyText}</Text>}
    </Box>
  </CommandPane>;
}
