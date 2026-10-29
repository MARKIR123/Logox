import {useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import stringWidth from 'string-width';
import type {StatusbarAppearance, StatusbarId} from '../../config/statusbar-preferences.js';
import {statusbarIds} from '../../config/statusbar-preferences.js';
import type {CommandToggle} from '../../runtime/command-surface.js';
import type {StageStatus} from '../../runtime/stage-status.js';
import {palette} from '../appearance/theme.js';
import {useMouse} from '../terminal/mouse.js';
import {clipLine} from '../terminal/text.js';
import {moveToggle, ToggleList} from '../panels/toggle-list.js';
import {statusbarParts} from './statusbar.js';

/** A local composition draft. Preview never writes preferences or publishes runtime state. */
export function StatusbarEditor({items, appearance, status, width, height, y, x = 0, active, disabled, isLocked, error,
  onItems, onAppearance, onFocusTabs}: {
  items: readonly CommandToggle[]; appearance: StatusbarAppearance; status: StageStatus;
  width: number; height: number; y: number; x?: number; active: boolean; disabled: boolean; isLocked(): boolean; error: string;
  onItems(update: (items: readonly CommandToggle[]) => readonly CommandToggle[]): void;
  onAppearance(update: (appearance: StatusbarAppearance) => StatusbarAppearance): void;
  onFocusTabs(): void;
}) {
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const select = (at: number) => {selectedRef.current = at; setSelected(at);};
  const expanded = height >= 7;
  const tiny = height < 3;
  const showPreview = height >= 5;
  const moduleTop = expanded ? 5 : showPreview ? 3 : 2;
  const count = Math.max(0, height - moduleTop - (height >= 5 ? 1 : 0));
  const start = Math.max(0, Math.min(selected - 2 - Math.floor(count / 2), items.length - count));
  const styles = ['pipes', 'starship'] as const, schemes = ['theme', 'gruvbox', 'dracula'] as const;
  const adjust = (at: number, direction: number) => {
    if (isLocked()) return;
    if (at === 0) onAppearance(current => ({...current, style: styles[(styles.indexOf(current.style) + styles.length + direction) % styles.length]!}));
    else if (at === 1) onAppearance(current => ({...current, colorScheme: schemes[(schemes.indexOf(current.colorScheme) + schemes.length + direction) % schemes.length]!}));
    else {
      select(Math.max(0, Math.min(items.length - 1, at - 2 + direction)) + 2);
      onItems(current => moveToggle(current, at - 2, direction).items);
    }
  };
  const toggle = (at: number) => {
    if (isLocked()) return;
    if (at < 2) adjust(at, 1);
    else onItems(current => current.map((item, index) => index === at - 2 ? {...item, enabled: !item.enabled} : item));
  };
  useInput((input, key) => {
    if (!active || isLocked() || key.eventType === 'release' || key.ctrl || key.tab || key.escape || key.return) return;
    const at = selectedRef.current;
    if (key.upArrow) {if (at === 0) onFocusTabs(); else select(at - 1);}
    else if (key.downArrow) select(Math.min(items.length + 1, at + 1));
    else if (key.leftArrow || input === '[' || input === '<') adjust(at, -1);
    else if (key.rightArrow || input === ']' || input === '>') adjust(at, 1);
    else if (input === ' ') toggle(at);
  });
  useMouse(event => {
    if (isLocked() || event.action !== 'press' || event.button !== 0 || event.x < x || event.x >= x + width) return;
    const row = event.y - y, col = event.x - x;
    const at = tiny ? row >= 0 && row < (selected < 2 ? 1 : height) ? selected + row : -1
      : row === 0 ? 0 : row === 1 ? 1 : row >= moduleTop && row < moduleTop + count ? start + row - moduleTop + 2 : -1;
    if (at < 0 || at >= items.length + 2) return;
    select(at);
    const hasControls = at < 2 ? width >= 12 : width >= 18;
    if (hasControls && col >= width - 4) adjust(at, col < width - 2 ? -1 : 1);
    else toggle(at);
  });
  const modules = items.filter((item): item is CommandToggle & {id: StatusbarId} => statusbarIds.some(id => id === item.id))
    .map(({id, enabled}) => ({id, enabled}));
  const parts = statusbarParts(status, width, modules, appearance);
  const choice = (label: string, value: string, at: number) => {
    const controls = width >= 12 ? ' ‹ ›' : '';
    const text = clipLine((active && selected === at ? '❯ ' : '  ') + label + ': ' + value, Math.max(1, width - stringWidth(controls)));
    return <Box height={1} flexShrink={0} overflow="hidden"><Text color={active && selected === at && !disabled ? palette.accent : palette.fg} wrap="truncate">
      {text + ' '.repeat(Math.max(0, width - stringWidth(text) - stringWidth(controls))) + controls}
    </Text></Box>;
  };
  if (tiny) return <Box height={height} overflow="hidden" flexDirection="column">{selected < 2
    ? choice(selected === 0 ? 'Style' : 'Palette', selected === 0 ? appearance.style : appearance.colorScheme, selected)
    : <ToggleList items={items} selected={selected - 2} start={selected - 2} count={height} width={width} disabled={disabled}/>}</Box>;
  return <Box height={height} overflow="hidden" flexDirection="column">
    {choice('Style', appearance.style === 'pipes' ? 'Pipes' : 'Starship', 0)}
    {height >= 2 && choice('Palette', appearance.colorScheme, 1)}
    {showPreview && <>
      {expanded && <Text color={palette.muted}>Preview</Text>}
      <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{parts.length
        ? parts.map((part, index) => <Text key={index} {...(part.color ? {color: part.color} : {})} {...(part.backgroundColor ? {backgroundColor: part.backgroundColor} : {})}>{part.text}</Text>)
        : <Text color={palette.muted}>No modules fit · enable or reorder modules</Text>}</Text></Box>
      {expanded && <Text color={palette.muted} wrap="truncate">{clipLine('Modules · ' + items.filter(item => item.enabled).length + ' active · ' + items.filter(item => !item.enabled).length + ' available', width)}</Text>}
    </>}
    {count > 0 && <ToggleList items={items} selected={active && selected >= 2 ? selected - 2 : -1} start={start} count={count} width={width} disabled={disabled}/>}
    {height >= 5 && <Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(error || (selected < 2
      ? '←→ Style / palette · ↓ Modules' : '←→ Reorder · Space Toggle · Order sets narrow-screen priority'), width)}</Text>}
  </Box>;
}
