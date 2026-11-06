import {useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import stringWidth from 'string-width';
import type {StatusbarAppearance, StatusbarId} from '../../config/statusbar-preferences.js';
import {defaultGaugeCells, gaugeCellChoices, statusbarIds} from '../../config/statusbar-preferences.js';
import type {CommandToggle} from '../../runtime/command-surface.js';
import type {StageStatus} from '../../runtime/stage-status.js';
import {palette} from '../appearance/theme.js';
import {useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';
import {clipLine} from '../terminal/text.js';
import {moveToggle, ToggleList, toggleZone, type ToggleZone} from '../panels/toggle-list.js';
import {statusbarParts} from './statusbar.js';
import {footerHints, notificationSegments, widgetDetail} from './notification-line.js';

/** Rows before the module list: Style, Palette and Gauge width. */
const HEAD = 3;

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
  const expanded = height >= 10;
  const tiny = height < 4;
  const showPreview = height >= 7;
  const moduleTop = expanded ? 7 : showPreview ? 5 : 3;
  const count = Math.max(0, height - moduleTop - (height >= 5 ? 1 : 0));
  const start = Math.max(0, Math.min(selected - HEAD - Math.floor(count / 2), items.length - count));
  const styles = ['pipes', 'starship'] as const, schemes = ['theme', 'gruvbox', 'dracula'] as const;
  const adjust = (at: number, direction: number) => {
    if (isLocked()) return;
    if (at === 0) onAppearance(current => ({...current, style: styles[(styles.indexOf(current.style) + styles.length + direction) % styles.length]!}));
    else if (at === 1) onAppearance(current => ({...current, colorScheme: schemes[(schemes.indexOf(current.colorScheme) + schemes.length + direction) % schemes.length]!}));
    else if (at === 2) onAppearance(current => {
      const known = Math.max(0, gaugeCellChoices.indexOf((current.gaugeCells ?? defaultGaugeCells) as typeof gaugeCellChoices[number]));
      return {...current, gaugeCells: gaugeCellChoices[(known + gaugeCellChoices.length + direction) % gaugeCellChoices.length]!};
    });
    else {
      select(Math.max(0, Math.min(items.length - 1, at - HEAD + direction)) + HEAD);
      onItems(current => moveToggle(current, at - HEAD, direction).items);
    }
  };
  const toggle = (at: number) => {
    if (isLocked()) return;
    if (at < HEAD) adjust(at, 1);
    else onItems(current => current.map((item, index) => index === at - HEAD ? {...item, enabled: !item.enabled} : item));
  };
  useInput((input, key) => {
    if (!active || isLocked() || key.eventType === 'release' || key.ctrl || key.tab || key.escape || key.return) return;
    const at = selectedRef.current;
    if (key.upArrow) {if (at === 0) onFocusTabs(); else select(at - 1);}
    else if (key.downArrow) select(Math.min(items.length + HEAD - 1, at + 1));
    else if (key.leftArrow || input === '[' || input === '<') adjust(at, -1);
    else if (key.rightArrow || input === ']' || input === '>') adjust(at, 1);
    else if (input === ' ') toggle(at);
  });
  // The same row mapping serves clicks, hover and the wheel.
  const locate = (point: {readonly x: number; readonly y: number}): {at: number; col: number} | undefined => {
    if (point.x < x || point.x >= x + width) return undefined;
    const row = point.y - y, col = point.x - x;
    const at = tiny ? row >= 0 && row < (selected < HEAD ? 1 : height) ? selected + row : -1
      : row >= 0 && row < HEAD ? row : row >= moduleTop && row < moduleTop + count ? start + row - moduleTop + HEAD : -1;
    return at < 0 || at >= items.length + HEAD ? undefined : {at, col};
  };
  const zoneOf = (at: number, col: number): ToggleZone => {
    const hasControls = at < HEAD ? width >= 12 : width >= 18;
    return hasControls && col >= width - 4 ? (col < width - 2 ? 'dec' : 'inc') : 'row';
  };
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);
  useMouse(event => {
    if (isLocked() || event.x < x || event.x >= x + width) return;
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {
      if (event.y >= y && event.y < y + height) select(Math.max(0, Math.min(items.length + HEAD - 1, selectedRef.current + (event.action === 'wheel_up' ? -1 : 1))));
      return;
    }
    if (event.action !== 'press' || event.button !== 0) return;
    const hit = locate(event);
    if (!hit) return;
    select(hit.at);
    const zone = zoneOf(hit.at, hit.col);
    if (zone !== 'row') adjust(hit.at, zone === 'dec' ? -1 : 1);
    else toggle(hit.at);
  });
  const over = pointer && !disabled ? locate(pointer) : undefined;
  const hoverRow = over ? {at: over.at, zone: zoneOf(over.at, over.col)} : undefined;
  const modules = items.filter((item): item is CommandToggle & {id: StatusbarId} => statusbarIds.some(id => id === item.id))
    .map(({id, enabled}) => ({id, enabled}));
  const parts = statusbarParts(status, width, modules, appearance);
  // Row 2 of the preview: the key hints, or the detail of the context gauge when it is the selected row.
  const note = notificationSegments({detail: selected === HEAD + Math.max(0, items.findIndex(item => item.id === 'context')) && items.some(item => item.id === 'context') && active
    ? widgetDetail('context', status, undefined, width) : undefined, hints: footerHints({own: false, queued: 1, menu: false, closing: false, width})}, width);
  const choice = (label: string, value: string, at: number) => {
    const controls = width >= 12 ? ' ‹ ›' : '';
    const text = clipLine((active && selected === at ? '❯ ' : '  ') + label + ': ' + value, Math.max(1, width - stringWidth(controls)));
    const hovered = hoverRow?.at === at && selected !== at;
    return <Box height={1} flexShrink={0} overflow="hidden"><Text color={active && selected === at && !disabled ? palette.accent : hovered ? hoverColor : palette.fg} bold={hovered} wrap="truncate">
      {text + ' '.repeat(Math.max(0, width - stringWidth(text) - stringWidth(controls)))}{controls ? <>
        <Text> </Text><Text {...(hoverRow?.at === at && hoverRow.zone === 'dec' ? {color: hoverColor, bold: true} : {})}>‹</Text><Text> </Text>
        <Text {...(hoverRow?.at === at && hoverRow.zone === 'inc' ? {color: hoverColor, bold: true} : {})}>›</Text></> : null}
    </Text></Box>;
  };
  const gaugeValue = String(appearance.gaugeCells ?? defaultGaugeCells) + ' cells';
  if (tiny) return <Box height={height} overflow="hidden" flexDirection="column">{selected < HEAD
    ? choice(selected === 0 ? 'Style' : selected === 1 ? 'Palette' : 'Gauge', selected === 0 ? appearance.style : selected === 1 ? appearance.colorScheme : gaugeValue, selected)
    : <ToggleList items={items} selected={selected - HEAD} start={selected - HEAD} count={height} width={width} disabled={disabled}
      hover={hoverRow && hoverRow.at >= HEAD ? {index: hoverRow.at - HEAD, zone: hoverRow.zone} : undefined} hoverColor={hoverColor}/>}</Box>;
  return <Box height={height} overflow="hidden" flexDirection="column">
    {choice('Style', appearance.style === 'pipes' ? 'Pipes' : 'Starship', 0)}
    {choice('Palette', appearance.colorScheme, 1)}
    {choice('Gauge', gaugeValue, 2)}
    {showPreview && <>
      {expanded && <Text color={palette.muted}>Preview</Text>}
      <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{parts.length
        ? parts.map((part, index) => <Text key={index} {...(part.color ? {color: part.color} : {})} {...(part.backgroundColor ? {backgroundColor: part.backgroundColor} : {})}>{part.text}</Text>)
        : <Text color={palette.muted}>No modules fit · enable or reorder modules</Text>}</Text></Box>
      <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{note.map((segment, index) =>
        <Text key={index} {...(segment.color ? {color: segment.color} : {})} {...(segment.bold ? {bold: true} : {})} {...(segment.italic ? {italic: true} : {})}>{segment.text}</Text>)}</Text></Box>
      {expanded && <Text color={palette.muted} wrap="truncate">{clipLine('Modules · ' + items.filter(item => item.enabled).length + ' active · ' + items.filter(item => !item.enabled).length + ' available', width)}</Text>}
    </>}
    {count > 0 && <ToggleList items={items} selected={active && selected >= HEAD ? selected - HEAD : -1} start={start} count={count} width={width} disabled={disabled}
      hover={hoverRow && hoverRow.at >= HEAD ? {index: hoverRow.at - HEAD, zone: hoverRow.zone} : undefined} hoverColor={hoverColor}/>}
    {height >= 5 && <Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(error || (selected < HEAD
      ? '←→ Style / palette / gauge width · ↓ Modules' : '←→ Reorder · Space Toggle · Order sets display order'), width)}</Text>}
  </Box>;
}
