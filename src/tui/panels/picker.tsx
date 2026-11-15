import {useState} from 'react';
import {Box, Text, useCursor, useInput, usePaste} from 'ink';
import stringWidth from 'string-width';
import type {MarkChange, PickerItem} from '../../runtime/command-surface.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import {clipLine} from '../terminal/text.js';
import {emptyDraft, erase, graphemes, insert, type Draft} from '../input/editor.js';
import {PanelFrame as CommandPane, footerParts, hitFooter, panePadding} from '../components/panel-frame.js';
import {toggleMarker} from '../components/toggle-marker.js';
import {inRegion, useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';

export interface EffortStyle {
  readonly color: string;
  readonly label: string;
}

export const effortStyles: Record<string, EffortStyle> = {
  off:    {get color() {return palette.effortOff;}, label: 'off'},
  low:    {get color() {return palette.effortLow;}, label: 'low'},
  medium: {get color() {return palette.effortMedium;}, label: 'medium'},
  high:   {get color() {return palette.effortHigh;}, label: 'high'},
  max:    {get color() {return palette.effortMax;}, label: 'max'},
  auto:   {get color() {return palette.effortAuto;}, label: 'auto'},
};

export interface PickerProps {
  title: string; description?: string; items: readonly PickerItem[]; current?: string;
  status?: 'loading' | 'ready' | 'saving'; error?: string; emptyText?: string; focus?: string;
  width: number; height: number; y?: number;
  notice?: string;
  deleteLabel?: string | undefined; onDelete?(id: string): void;
  effort?: string | undefined; effortLevels?: readonly string[] | undefined;
  /** Edits the marks of a model row; rows that carry marks then show the filter row and answer `1`-`4`, `v`, `0` and clicks on their marks. */
  onMark?(id: string, change: MarkChange): void;
  onSelect(id: string, effort?: string): void; onCancel(): void;
}
type MarkFilter = 'all' | 1 | 2 | 3 | 4 | 'vision';
const MARK_FILTERS: readonly {readonly value: MarkFilter; readonly label: string}[] = [
  {value: 'all', label: 'All'}, {value: 1, label: 'T1'}, {value: 2, label: 'T2'}, {value: 3, label: 'T3'}, {value: 4, label: 'T4'}, {value: 'vision', label: '◉ Vision'}];
const FILTER_HINT = '1–4 tier · v vision · 0 reset · [ ] filter';
/** Cells of the two marks at the end of a model row: `T2`, a gap, then the vision slot. */
const MARK_CELLS = 4, MARK_RESERVE = MARK_CELLS + 1;
/** Grouped entries are paged by provider; ungrouped entries (such as inherit) show on every page. */
export function Picker({title, description = '', items, current = '', status = 'ready', error = '',
  emptyText = 'No matching options', focus = '', width, height, y = 0, notice = '', deleteLabel, onDelete, effort, effortLevels, onMark, onSelect, onCancel}: PickerProps) {
  const [search, setSearch] = useState<Draft>(emptyDraft);
  const [markFilter, setMarkFilter] = useState<MarkFilter>('all');
  const [focused, setFocused] = useState(focus || current);
  const tabs = [...new Set(items.map(item => item.group).filter((group): group is string => Boolean(group)))];
  const tabbed = tabs.length > 1;
  const currentGroup = items.find(item => item.id === current)?.group;
  // Entries are replaced wholesale once the catalog loads, so the tab follows the current item by default and is pinned only when the user presses Tab.
  const [pickedTab, setPickedTab] = useState<string | undefined>(undefined);
  const activeTab = pickedTab && tabs.includes(pickedTab) ? pickedTab
    : currentGroup && tabs.includes(currentGroup) ? currentGroup : (tabs[0] ?? '');
  const filter = search.text.toLocaleLowerCase();
  const marked = items.some(item => item.marks);
  const passesFilter = (item: PickerItem) => !item.marks || markFilter === 'all' || (markFilter === 'vision' ? item.marks.vision : item.marks.tier === markFilter);
  const scoped = (tabbed ? items.filter(item => !item.group || item.group === activeTab) : items).filter(passesFilter);
  const matches = scoped.filter(item => (item.label + ' ' + (item.description ?? '') + ' ' + (item.detail ?? '')).toLocaleLowerCase().includes(filter));
  const enabled = matches.filter(item => !item.disabled);
  const selected = enabled.find(item => item.id === focused) ?? enabled.find(item => item.id === current) ?? enabled[0];
  const index = matches.findIndex(item => item.id === selected?.id);
  const itemEffortLevels = selected?.effortLevels && selected.effortLevels.length > 0 ? selected.effortLevels : (effortLevels && effortLevels.length > 0 ? effortLevels : undefined);
  const [itemEfforts, setItemEfforts] = useState<Record<string, string>>({});
  const currentEffort = (selected ? itemEfforts[selected.id] : undefined) ?? selected?.effort ?? effort ?? itemEffortLevels?.[0];
  const bodyRows = Math.max(0, height - 3);
  // Preserve a selectable row before decorative chrome on short terminals.
  const hasEffortBar = Boolean(itemEffortLevels?.length && bodyRows >= (tabbed ? 5 : 4));
  const effortRows = hasEffortBar ? 2 : 0;
  const showTabs = tabbed && bodyRows - effortRows >= 2;
  const showSectionRules = (tabs.length > 0 || hasEffortBar) && bodyRows - effortRows >= (showTabs ? 5 : 4);
  const contentRows = bodyRows - effortRows - (showSectionRules ? 2 : 0);
  // A list that loaded empty has nothing to search: show the next step instead of a dead search box.
  const nothing = status === 'ready' && items.length === 0;
  const showSearch = !nothing && contentRows - (showTabs ? 1 : 0) >= 2;
  const showSearchGap = showTabs && showSectionRules && contentRows >= 4;
  const showDescription = !tabbed && contentRows >= 3;
  // The filter row sits between the header and the search box; it needs a search row and at least one list row besides.
  const showFilter = marked && !nothing && showSearch && contentRows - (showTabs ? 1 : 0) >= 3;
  const count = Math.max(0, contentRows - (showTabs ? 1 : 0) - (showSearch ? 1 : 0)
    - (showSearchGap ? 1 : 0) - (showDescription ? 1 : 0) - (showFilter ? 1 : 0));
  // An item with a `detail` takes two rows (name and badge, then the muted detail); the list is then paged in pairs.
  const rowHeight = items.some(item => item.detail) ? 2 : 1, visible = Math.max(1, Math.floor(count / rowHeight));
  const start = Math.max(0, Math.min(index - Math.floor(visible / 2), matches.length - visible));
  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding);
  const searchWidth = Math.max(1, columns - 9);
  let tail = search.text;
  while (stringWidth(tail) > searchWidth) tail = graphemes(tail).slice(1).join('');
  // The description column takes whatever the widest visible label leaves, instead of a fixed cap.
  // Rows that carry marks keep the last cells of the row for them.
  const rowColumns = marked ? Math.max(1, columns - MARK_RESERVE) : columns;
  const widestLabel = Math.max(0, ...matches.map(item => stringWidth(safeText(item.label + (item.id === current ? ' · current' : ''))) + (item.effortLevels && item.effortLevels.length > 1 ? 10 : 0)));
  const descriptionRoom = Math.max(0, rowColumns - 2 - 2 - Math.min(widestLabel, Math.floor(rowColumns * 0.65)));
  const rule = <Box height={1} flexShrink={0}><Text color={palette.accent} wrap="truncate">{'─'.repeat(columns)}</Text></Box>;
  const {setCursorPosition} = useCursor();
  // One geometry for drawing and hit-testing: the body starts two rows under the panel top.
  const filterY = y + 2 + (showTabs || showDescription ? 1 : 0) + (showSectionRules ? 1 : 0);
  const searchY = filterY + (showFilter ? 1 : 0);
  const listY = searchY + (showSearch ? 1 : 0) + (showSearchGap ? 1 : 0), effortY = listY + count + 1;
  let tabX = padding;
  const tabCells = showTabs ? tabs.map((name, at) => {
    const lead = at > 0 ? 2 : 0, text = name === activeTab ? '[ ' + name + ' ]' : '  ' + name + '  ';
    const cell = {name, text: ' '.repeat(lead) + text, region: {y: y + 2, x0: tabX + lead, x1: tabX + lead + stringWidth(text)}};
    tabX += lead + stringWidth(text);
    return cell;
  }) : [];
  let filterX = padding;
  const filterCells = showFilter ? MARK_FILTERS.map(({value, label}) => {
    const text = value === markFilter ? '[' + label + ']' : ' ' + label + ' ';
    const cell = {value, text, region: {y: filterY, x0: filterX, x1: filterX + stringWidth(text)}};
    filterX += stringWidth(text);
    return cell;
  }) : [];
  const filterHint = showFilter && columns - (filterX - padding) >= 14 ? clipLine('  ' + FILTER_HINT, columns - (filterX - padding)) : '';
  const cycleFilter = (delta: number) => {
    const at = Math.max(0, MARK_FILTERS.findIndex(item => item.value === markFilter));
    setMarkFilter(MARK_FILTERS[(at + delta + MARK_FILTERS.length) % MARK_FILTERS.length]!.value);
  };
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);
  setCursorPosition(status === 'ready' && showSearch ? {x: Math.min(width - padding - 1, padding + 8 + stringWidth(tail)), y: searchY} : undefined);
  const edit = (next: Draft) => {if (next.text.length <= 512) {setSearch(next); setFocused('');};};
  usePaste(text => {if (status === 'ready' && showSearch) edit(insert(search, text.replace(/[\r\n]/g, ' ')));});
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {if (status !== 'saving') onCancel(); return;}
    if (status !== 'ready') return;
    if (key.ctrl && input === 'x' && selected?.deletable && onDelete) {onDelete(selected.id); return;}
    if (key.return) {if (selected) onSelect(selected.id, currentEffort); return;}
    if (marked && onMark) {
      // Plain keys edit the marks only while the search box is empty (a name may start with a digit or `v`); Alt+key always does.
      const editing = !key.ctrl && (key.meta || search.text === '');
      if (selected?.marks && editing) {
        if (/^[1-4]$/.test(input)) {onMark(selected.id, {tier: Number(input) as 1 | 2 | 3 | 4}); return;}
        if (input.toLowerCase() === 'v') {onMark(selected.id, {vision: !selected.marks.vision}); return;}
        if (input === '0') {onMark(selected.id, {clear: true}); return;}
      }
      if (showFilter && search.text === '' && !key.ctrl && !key.meta && (input === '[' || input === ']')) {cycleFilter(input === ']' ? 1 : -1); return;}
    }
    if (tabbed && key.tab) {
      const at = Math.max(0, tabs.indexOf(activeTab));
      setPickedTab(tabs[(at + (key.shift ? tabs.length - 1 : 1)) % tabs.length]!);
      setFocused('');
      return;
    }
    if (itemEffortLevels && itemEffortLevels.length > 0 && (key.leftArrow || key.rightArrow) && selected) {
      const idx = Math.max(0, itemEffortLevels.indexOf(currentEffort ?? itemEffortLevels[0]!));
      const nextIdx = (idx + (key.leftArrow ? -1 : 1) + itemEffortLevels.length) % itemEffortLevels.length;
      const nextEffort = itemEffortLevels[nextIdx]!;
      setItemEfforts(prev => ({...prev, [selected.id]: nextEffort}));
      return;
    }
    const at = enabled.findIndex(item => item.id === selected?.id);
    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = at + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = at + (key.pageUp ? -visible : visible);
    if (key.home || key.end) next = key.home ? 0 : enabled.length - 1;
    if (next !== undefined) {setFocused(enabled[Math.max(0, Math.min(enabled.length - 1, next))]?.id ?? ''); return;}
    if (!showSearch) return;
    if (key.backspace || key.delete) {edit(erase(search, true)); return;}
    if (key.ctrl && input === 'u') {edit(emptyDraft); return;}
    if (!key.ctrl && !key.meta && !key.tab && input) edit(insert(search, input));
  });
  const markerCells = stringWidth(toggleMarker(false)), effortName = currentEffort ?? '';
  const effortPrefix = columns >= stringWidth('✦ Thinking: ' + effortName + ' ') + markerCells ? '✦ Thinking: '
    : columns >= stringWidth('✦ ' + effortName + ' ') + markerCells ? '✦ ' : '';
  const showEffortMarkers = columns >= stringWidth(effortPrefix + effortName + ' ') + markerCells;
  const effortHint = '  (← → to adjust)';
  const showEffortHint = showEffortMarkers && columns >= stringWidth(effortPrefix + effortName + ' ' + effortHint)
    + markerCells * (itemEffortLevels?.length ?? 0);
  const effortBar = (() => {
    if (!hasEffortBar || !showEffortMarkers) return null;
    const levels = itemEffortLevels ?? [];
    const activeIdx = Math.max(0, levels.indexOf(currentEffort ?? levels[0]!));
    const markerWidth = stringWidth(toggleMarker(false));
    const available = Math.max(markerWidth, columns - stringWidth(effortPrefix + effortName + ' ') - (showEffortHint ? stringWidth(effortHint) : 0));
    const visible = Math.max(1, Math.min(levels.length, Math.floor(available / markerWidth)));
    const first = Math.max(0, Math.min(activeIdx - Math.floor(visible / 2), levels.length - visible));
    const dashLimit = Math.max(2, Math.min(6, Math.floor(12 / Math.max(1, levels.length - 1))));
    const dashCount = Math.max(0, Math.min(dashLimit, Math.floor((available - visible * markerWidth) / Math.max(1, visible - 1))));
    return {levels, activeIdx, markerWidth, first, visible, dashCount,
      cells: levels.slice(first, first + visible).map((tier, offset) => ({tier, idx: first + offset,
        region: {y: effortY, x0: padding + stringWidth(effortPrefix) + offset * (markerWidth + dashCount), x1: padding + stringWidth(effortPrefix) + offset * (markerWidth + dashCount) + markerWidth}}))};
  })();
  const footer = status === 'saving' ? 'Processing...' : nothing ? 'Esc Back' : '↑↓ Select' + (tabbed ? ' · Tab Provider' : '') + (hasEffortBar ? ' · ←→ Thinking' : '') + ' · Enter Confirm · Esc Back' + (selected?.deletable && deleteLabel ? ' · Ctrl+X ' + deleteLabel : '');
  const footerText = notice || footer;
  const nextTab = () => {if (tabbed) {setPickedTab(tabs[(Math.max(0, tabs.indexOf(activeTab)) + 1) % tabs.length]!); setFocused('');}};
  const footerView = footerParts(footerText, notice || status === 'saving' ? [] : [
    ...(tabbed ? [{label: 'Tab Provider', run: nextTab}] : []),
    ...(nothing ? [] : [{label: 'Enter Confirm', run: () => {if (selected) onSelect(selected.id, currentEffort);}}]),
    {label: 'Esc Back', run: onCancel},
    ...(selected?.deletable && deleteLabel && onDelete ? [{label: 'Ctrl+X ' + deleteLabel, run: () => onDelete(selected.id)}] : [])], width, y, height, true);
  const move = (delta: number) => {
    const at = enabled.findIndex(item => item.id === selected?.id);
    setFocused(enabled[Math.max(0, Math.min(enabled.length - 1, at + delta))]?.id ?? '');
  };
  useMouse(event => {
    if (event.x < 0 || event.x >= width || event.y < y || event.y >= y + height) return;
    if (event.action === 'press' && event.button === 0 && status !== 'saving') {
      const part = hitFooter(footerView, event);
      if (part?.run) {part.run(); return;}
    }
    if (status !== 'ready') return;
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {move(event.action === 'wheel_up' ? -1 : 1); return;}
    if (event.action !== 'press' || event.button !== 0) return;
    const tab = tabCells.find(cell => inRegion(event, cell.region));
    if (tab) {setPickedTab(tab.name); setFocused(''); return;}
    const level = effortBar?.cells.find(cell => inRegion(event, cell.region));
    if (level && selected) {setItemEfforts(prev => ({...prev, [selected.id]: level.tier})); return;}
    const filterCell = filterCells.find(cell => inRegion(event, cell.region));
    if (filterCell) {setMarkFilter(filterCell.value); return;}
    const row = event.y - listY;
    if (row < 0 || row >= count) return;
    const item = matches[start + Math.floor(row / rowHeight)];
    if (!item || item.disabled) return;
    if (item.marks && onMark && event.x >= padding + columns - MARK_CELLS && event.x < padding + columns) {
      setFocused(item.id);
      if (event.x < padding + columns - MARK_CELLS + 2) onMark(item.id, {tier: (item.marks.tier % 4 + 1) as 1 | 2 | 3 | 4});
      else onMark(item.id, {vision: !item.marks.vision});
      return;
    }
    if (item.id === selected?.id) onSelect(item.id, currentEffort); else setFocused(item.id);
  });
  return <CommandPane docked title={title} width={width} height={height} footer={footerText} parts={footerView} hovered={hitFooter(footerView, pointer)} hoverColor={hoverColor}>
    {showTabs ? <>
      <Box height={1} flexShrink={0}><Text wrap="truncate">
        {tabCells.map(cell => <Text key={cell.name} color={cell.name === activeTab ? palette.accent : inRegion(pointer, cell.region) ? hoverColor : palette.muted} bold={cell.name === activeTab}>
          {cell.text}
        </Text>)}
      </Text></Box>
    </> : showDescription ? <Box height={1} flexShrink={0}><Text color={error ? palette.error : palette.muted} wrap="truncate">{clipLine(safeText(error || description), columns)}</Text></Box> : null}
    {showSectionRules && rule}
    {showFilter && <Box height={1} flexShrink={0}><Text wrap="truncate">
      {filterCells.map(cell => <Text key={String(cell.value)} color={cell.value === markFilter ? palette.accent : inRegion(pointer, cell.region) ? hoverColor : palette.muted} bold={cell.value === markFilter}>
        {cell.text}
      </Text>)}
      {filterHint ? <Text color={palette.muted}>{filterHint}</Text> : null}
    </Text></Box>}
    {showSearch && <Box height={1} flexShrink={0}><Text color={palette.fg} wrap="truncate">{'Search: ' + tail}</Text></Box>}
    {showSearchGap ? <Box height={1} flexShrink={0} /> : null}
    <Box height={count} flexShrink={0} flexDirection="column" overflow="hidden">
      {status === 'loading' ? <Text color={palette.muted}>Searching...</Text> : matches.length ? matches.slice(start, start + visible).map(item => {
        const active = item.id === selected?.id;
        const itemEffort = active ? currentEffort : (itemEfforts[item.id] ?? item.effort);
        const effortBadge = itemEffort && item.effortLevels && item.effortLevels.length > 1 ? ' · ✦ ' + itemEffort : '';
        const detail = clipLine(safeText(item.description ?? ''), descriptionRoom);
        const labelColumns = Math.max(1, rowColumns - 2 - (detail ? stringWidth(detail) + 2 : 0));
        const label = clipLine(safeText(item.label + (item.id === current ? ' · current' : '') + effortBadge), labelColumns);
        const used = 2 + stringWidth(label) + (detail ? Math.max(2, labelColumns - stringWidth(label) + 2) + stringWidth(detail) : 0);
        const rowRight = padding + columns - MARK_CELLS;
        const overRow = pointer !== null && pointer.y === listY + (matches.indexOf(item) - start) * rowHeight;
        const onTier = overRow && pointer!.x >= rowRight && pointer!.x < rowRight + 2, onVision = overRow && pointer!.x >= rowRight + 2 && pointer!.x < rowRight + MARK_CELLS;
        const highlight = active && !item.disabled;
        const rowTop = listY + (matches.indexOf(item) - start) * rowHeight;
        const hovered = !item.disabled && !active && pointer !== null && pointer.y >= rowTop && pointer.y < rowTop + rowHeight && pointer.x >= 0 && pointer.x < width;
        const valueColor = highlight ? palette.accent : hovered ? hoverColor : item.valueTone === 'warning' ? palette.warning : palette.muted;
        return <Box key={item.id} height={rowHeight} flexShrink={0} flexDirection="column">
          <Text wrap="truncate">
            <Text bold={highlight || hovered} color={highlight ? palette.accent : hovered ? hoverColor : item.disabled ? palette.muted : palette.fg}>
              {(active ? '❯ ' : '  ') + label}
            </Text>
            {detail ? <Text color={valueColor}>
              {' '.repeat(Math.max(2, labelColumns - stringWidth(label) + 2)) + detail}
            </Text> : null}
            {item.marks ? <>
              {' '.repeat(Math.max(1, columns - MARK_CELLS - used))}
              <Text color={onTier ? hoverColor : item.marks.derived.tier ? palette.muted : palette.fg}>{'T' + item.marks.tier}</Text>
              <Text>{' '}</Text>
              <Text color={onVision ? hoverColor : item.marks.derived.vision ? palette.muted : palette.fg}>
                {item.marks.vision ? '◉' : item.marks.derived.vision ? ' ' : '○'}
              </Text>
            </> : null}
          </Text>
          {item.detail ? <Text wrap="truncate" color={highlight ? palette.accent : hovered ? hoverColor : palette.muted}>{'  ' + clipLine(safeText(item.detail), Math.max(1, columns - 2))}</Text> : null}
        </Box>;
      }) : <Text color={palette.muted} wrap="wrap">{error || emptyText}</Text>}
    </Box>
    {hasEffortBar && <>
      <Box height={1} flexShrink={0}/>
      <Box height={1} flexShrink={0}>
        <Text wrap="truncate">
          <Text color={palette.accent}>{effortPrefix}</Text>
          {effortBar && (() => {
            const currentStyle = effortStyles[currentEffort ?? ''] ?? {color: palette.accent};
            return effortBar.cells.map((cell, offset) => {
              const isSelected = cell.idx === effortBar.activeIdx;
              const railColor = cell.idx < effortBar.activeIdx ? currentStyle.color : palette.borderMuted;
              return <Text key={cell.tier}>
                {offset > 0 && <Text color={railColor}>{'─'.repeat(effortBar.dashCount)}</Text>}
                <Text color={isSelected ? palette.accent : inRegion(pointer, cell.region) ? hoverColor : palette.muted} bold={isSelected}>
                  {toggleMarker(isSelected)}
                </Text>
              </Text>;
            });
          })()}
          <Text>{showEffortMarkers ? ' ' : ''}</Text>
          <Text color={(effortStyles[currentEffort ?? ''] ?? {color: palette.accent}).color} bold>{currentEffort}</Text>
          {showEffortHint && <Text color={palette.muted}>{effortHint}</Text>}
        </Text>
      </Box>
    </>}
    {showSectionRules && rule}
  </CommandPane>;
}
