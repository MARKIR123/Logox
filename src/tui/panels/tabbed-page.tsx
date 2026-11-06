import React, {useRef, useState, type ReactElement} from 'react';
import stringWidth from 'string-width';
import {Box, Text, useInput} from 'ink';
import type {CommandTab, CommandToggle, TabRow} from '../../runtime/command-surface.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import wrapAnsi from 'wrap-ansi';
import {clipLine} from '../terminal/text.js';
import {PanelFrame as CommandPane, panePadding} from '../components/panel-frame.js';
import {ToggleList, moveToggle, cycleToggleOption} from './toggle-list.js';
import {useMouse} from '../terminal/mouse.js';
import type {StatusbarAppearance} from '../../config/statusbar-preferences.js';
import {StatusbarEditor} from '../status/statusbar-editor.js';

interface Cell {readonly text: string; readonly color: string; readonly bold?: boolean}
type DisplayRow = readonly Cell[];
const blankRow: DisplayRow = [];
/** Word wrap by display cells (long words break hard); continuation rows are the caller's to indent. */
function wrapBody(text: string, room: number): string[] {
  return wrapAnsi(safeText(text), Math.max(1, room), {hard: true, trim: false}).split(String.fromCharCode(10));
}
function ruleRow(columns: number, title?: string): DisplayRow {
  if (!title) return [{text: '─'.repeat(columns), color: palette.panelSeparator}];
  const head = '── ' + title + ' ';
  return [{text: head, color: palette.panelSeparator}, {text: '─'.repeat(Math.max(0, columns - stringWidth(head))), color: palette.panelSeparator}];
}
/** Hanging indent: the leading spaces and bullet stay on the first row, every continuation row aligns under the text after them. */
function textRows(text: string, columns: number, color: string, indent = 0, bold = false): DisplayRow[] {
  const lead = ' '.repeat(indent) + /^ *(• )?/u.exec(text)![0], body = text.replace(/^ *(• )?/u, '');
  const hang = Math.min(stringWidth(lead), Math.max(0, columns - 8));
  return wrapBody(body, columns - hang).map((line, index) => [{text: (index === 0 ? lead.slice(0, hang) : ' '.repeat(hang)) + line, color, ...(bold ? {bold} : {})}]);
}
/** Rows come from the producer when it supplied them; plain `lines` render as text, with full-width rules for dash-only lines. */
export function tabDisplay(tab: CommandTab | undefined, columns: number): DisplayRow[] {
  if (!tab) return [];
  const fromRows = (rows: readonly TabRow[]): DisplayRow[] => rows.flatMap((item): DisplayRow[] => {
    if (item.kind === 'blank') return [blankRow];
    if (item.kind === 'rule') return [ruleRow(columns, item.title)];
    if (item.kind === 'heading') return textRows(item.text, columns, palette.accent, 0, true);
    if (item.kind === 'text') return textRows(item.text, columns, item.tone === 'muted' ? palette.muted : palette.fg, item.indent ?? 0);
    const label = item.label + ':', labelWidth = stringWidth(label) + 1;
    // A long label puts the value on its own indented rows; otherwise continuation rows align under the value.
    if (labelWidth > Math.floor(columns / 2)) {
      return [[{text: label, color: palette.panelLabel}], ...wrapBody(item.value, columns - 2).map((line): DisplayRow => [{text: '  ' + line, color: palette.fg, bold: true}])];
    }
    return wrapBody(item.value, columns - labelWidth).map((line, index): DisplayRow => index === 0
      ? [{text: label, color: palette.panelLabel}, {text: ' ' + line, color: palette.fg, bold: true}]
      : [{text: ' '.repeat(labelWidth) + line, color: palette.fg, bold: true}]);
  });
  if (tab.rows) return fromRows(tab.rows);
  return tab.lines.flatMap((line, index): DisplayRow[] => {
    if (!line.trim()) return [blankRow];
    if (/^[─-]{2,}$/u.test(line.trim())) return [ruleRow(columns)];
    const titled = /^── (.+?) ─+$/u.exec(line);
    if (titled) return [ruleRow(columns, titled[1])];
    return textRows(line, columns, index === 0 ? palette.accent : palette.fg, 0, index === 0);
  });
}
function DisplayLine({row}: {row: DisplayRow}) {
  return <Box height={1} flexShrink={0} overflow="hidden">
    {row.length ? <Text wrap="truncate">{row.map((cell, at) => <Text key={at} color={cell.color} bold={cell.bold === true}>{cell.text}</Text>)}</Text> : <Text> </Text>}
  </Box>;
}

export function TabbedPage({title, tabs, initialTab, width, height, onClose, onSave, onAction, confirm, saving = false, error = '', notice = ''}: {
  title: string; tabs: readonly CommandTab[]; initialTab: string; width: number; height: number; onClose(): void;
  /** A pending yes/no from the host; while set, y or Enter confirms and any other key (Esc included) cancels it. */
  confirm?: {readonly tabId: string; readonly action: string; readonly prompt: string} | undefined;
  onSave?(tabId: string, items: readonly CommandToggle[], appearance?: StatusbarAppearance): void | Promise<void>;
  onAction?(tabId: string, action: string): void;
  saving?: boolean; error?: string; notice?: string;
}): ReactElement {
  const [active, setActive] = useState(initialTab);
  // Permission mode is edited as a draft; nothing is saved until Enter.
  const [modeDraft, setModeDraft] = useState<string | undefined>(undefined);
  const hasTabBar = tabs.length > 1;
  const [focusArea, setFocusArea] = useState<'tabs' | 'content'>(hasTabBar && !tabs.find(tab => tab.id === initialTab)?.toggles ? 'tabs' : 'content');
  const [appearances, setAppearances] = useState<Record<string, StatusbarAppearance>>({});
  const appearanceDrafts = useRef<Record<string, StatusbarAppearance>>({});
  const itemDrafts = useRef<Record<string, readonly CommandToggle[]>>({});
  const pendingSave = useRef(false);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [choices, setChoices] = useState<Record<string, readonly CommandToggle[]>>({});
  const [focused, setFocused] = useState<Record<string, number>>({});
  const index = Math.max(0, tabs.findIndex(tab => tab.id === active)), tab = tabs[index];
  const columns = Math.max(1, width - 2 * panePadding(width));
  const frameRows = height >= 4 ? 1 : 0;
  const contentHeight = Math.max(1, height - frameRows - (hasTabBar ? 5 : 3));
  const modeTab = tab?.mode, draftMode = modeTab && modeDraft && modeDraft !== modeTab.current ? modeDraft : undefined;
  const shownMode = draftMode ?? modeTab?.current;
  const modeDescription = modeTab?.options.find(option => option.id === shownMode)?.description ?? '';
  const lines: DisplayRow[] = [
    ...(confirm && confirm.tabId === tab?.id ? [[{text: '▲ ' + confirm.prompt, color: palette.warning, bold: true}] as DisplayRow,
      [{text: '  [y] / Enter Confirm · any other key Cancel', color: palette.muted}] as DisplayRow, blankRow] : []),
    ...(modeTab && shownMode ? [[{text: 'Mode:', color: palette.panelLabel}, {text: ' ' + shownMode, color: palette.fg, bold: true},
      ...(draftMode ? [{text: ' · unsaved (Enter applies, Esc discards)', color: palette.warning, bold: true}] : []),
      {text: ' · ' + modeDescription, color: palette.muted}] as DisplayRow, blankRow] : []),
    ...tabDisplay(tab, columns)];
  const max = Math.max(0, lines.length - contentHeight), offset = Math.min(max, offsets[tab?.id ?? ''] ?? 0);
  const items = tab?.toggles ? choices[tab.id] ?? tab.toggles : undefined;
  const selected = Math.min(Math.max(0, (items?.length ?? 1) - 1), focused[tab?.id ?? ''] ?? 0);
  const toggleHeight = Math.max(1, contentHeight - 1);
  const hasLinesWithItems = Boolean(items && lines.length > 0);
  const visibleToggleCount = hasLinesWithItems
    ? Math.min(items!.length, Math.max(1, contentHeight - 4))
    : toggleHeight;
  const start = Math.max(0, Math.min(selected - Math.floor(visibleToggleCount / 2), (items?.length ?? 0) - visibleToggleCount));

  const changeItems = (update: (items: readonly CommandToggle[]) => readonly CommandToggle[]) => {
    if (!tab || !items || saving || pendingSave.current) return;
    const next = update(itemDrafts.current[tab.id] ?? items);
    itemDrafts.current = {...itemDrafts.current, [tab.id]: next};
    setChoices(itemDrafts.current);
  };
  const changeAppearance = (update: (value: StatusbarAppearance) => StatusbarAppearance) => {
    if (!tab?.statusbar || saving || pendingSave.current) return;
    const next = update(appearanceDrafts.current[tab.id] ?? tab.statusbar.appearance);
    appearanceDrafts.current = {...appearanceDrafts.current, [tab.id]: next};
    setAppearances(appearanceDrafts.current);
  };
  const saveCurrent = () => {
    if (!tab || !items || !onSave || saving || pendingSave.current) return;
    pendingSave.current = true;
    const appearance = appearanceDrafts.current[tab.id] ?? tab.statusbar?.appearance;
    try {
      const result = onSave(tab.id, itemDrafts.current[tab.id] ?? items, appearance);
      void Promise.resolve(result).then(() => {pendingSave.current = false;}, () => {pendingSave.current = false;});
    } catch (error) {pendingSave.current = false; throw error;}
  };

  // Settings edit values in a fixed order. Only status-bar modules have ordering semantics.
  const reorderable = tab?.id === 'statusbar';
  const toggle = (at: number) => {
    if (!tab || !items || saving) return;
    changeItems(current => current.map((item, i) => i === at ? {...item, enabled: !item.enabled} : item));
  };
  const changeValue = (at: number, direction: number) => {
    if (!tab || !items || saving) return;
    changeItems(current => current.map((item, i) => i !== at ? item
      : item.options?.length ? cycleToggleOption(item, direction) : {...item, enabled: direction > 0}));
  };
  const reorder = (at: number, direction: number) => {
    if (!tab || !items || saving || !reorderable) return;
    const changed = moveToggle(items, at, direction);
    changeItems(current => moveToggle(current, at, direction).items);
    setFocused(previous => ({...previous, [tab.id]: changed.index}));
  };
  const adjustItem = reorderable ? reorder : changeValue;

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (confirm) {
      onAction?.(confirm.tabId, input === 'y' || input === 'Y' || key.return ? confirm.action : 'cancel_confirm');
      return;
    }
    if (key.escape) {
      if (!saving && !pendingSave.current) onClose();
      return;
    }
    if (key.ctrl) return;
    if (saving || pendingSave.current) return;

    if (key.tab && hasTabBar) {
      const step = key.shift ? -1 : 1;
      setActive(tabs[(index + tabs.length + step) % tabs.length]!.id);
      setFocusArea('tabs');
      return;
    }
    if (focusArea === 'tabs' && (key.leftArrow || key.rightArrow) && hasTabBar) {
      const step = key.leftArrow ? -1 : 1;
      setActive(tabs[(index + tabs.length + step) % tabs.length]!.id);
      return;
    }

    if (!tab) return;
    if (tab.statusbar && items) {
      if (key.return) saveCurrent();
      else if (focusArea === 'tabs' && (key.downArrow || input === ' ')) setFocusArea('content');
      return;
    }
    if (tab.id === 'providers') {
      if (focusArea === 'tabs' && hasTabBar) {
        if (key.downArrow) {setFocusArea('content'); return;}
      } else {
        if (key.upArrow && (offsets[tab.id] ?? 0) === 0 && hasTabBar) {setFocusArea('tabs'); return;}
        if (key.leftArrow || key.rightArrow || input === '[' || input === ']') {
          onAction?.('providers', (key.leftArrow || input === '[') ? 'prev_provider' : 'next_provider');
          return;
        }
      }
      if (input === 't' || input === 'T') {onAction?.('providers', 'test'); return;}
      if (input === 'r' || input === 'R') {onAction?.('providers', 'refresh'); return;}
      if (input === 'x' || input === 'X') {onAction?.('providers', 'logout'); return;}
    }

    if (items) {
      if (focusArea === 'tabs' && hasTabBar) {
        if (key.downArrow) {setFocusArea('content'); return;}
        if (input === ' ') {
          setFocusArea('content');
          if (items[selected]?.options?.length) adjustItem(selected, 1);
          else toggle(selected);
          return;
        }
        if (input === '[' || input === ']' || input === '<' || input === '>') {
          setFocusArea('content');
          adjustItem(selected, (input === '[' || input === '<') ? -1 : 1);
          return;
        }
        if (key.return) {saveCurrent(); return;}
      } else {
        if (key.upArrow) {
          if (selected === 0 && hasTabBar) setFocusArea('tabs');
          else setFocused(previous => ({...previous, [tab.id]: Math.max(0, (previous[tab.id] ?? 0) - 1)}));
          return;
        }
        if (key.downArrow) {
          setFocused(previous => ({...previous, [tab.id]: Math.min(items.length - 1, (previous[tab.id] ?? 0) + 1)}));
          return;
        }
        if (key.leftArrow || key.rightArrow || input === '[' || input === ']' || input === '<' || input === '>') {
          adjustItem(selected, (key.leftArrow || input === '[' || input === '<') ? -1 : 1);
          return;
        }
        if (input === ' ') {
          if (items[selected]?.options?.length) adjustItem(selected, 1);
          else toggle(selected);
          return;
        }
        if (key.return) {saveCurrent(); return;}
      }
      return;
    }

    if (modeTab) {
      const ids = modeTab.options.map(option => option.id), at = Math.max(0, ids.indexOf(shownMode ?? modeTab.current));
      const step = key.leftArrow ? -1 : (input === ' ' || input === 'm' || input === 'M' || key.rightArrow) ? 1 : 0;
      if (step && ids.length) {setModeDraft(ids[(at + step + ids.length) % ids.length]); return;}
      if (key.return) {
        if (draftMode) onAction?.(tab.id, 'set_mode:' + draftMode);
        return;
      }
    }

    let next: number | undefined;
    if (key.upArrow || key.downArrow) next = offset + (key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) next = offset + (key.pageUp ? -contentHeight : contentHeight);
    if (key.home || key.end) next = key.home ? 0 : max;
    if (next !== undefined) setOffsets(previous => ({...previous, [tab.id]: Math.max(0, Math.min(max, next))}));
  });

  useMouse(event => {
    if (event.action !== 'press' || event.button !== 0 || saving || pendingSave.current) return;
    const padding = panePadding(width), contentTop = hasTabBar ? 4 : 2;
    if (hasTabBar && event.y === 2) {
      let column = padding;
      for (const candidate of tabs) {
        const end = column + stringWidth('  ' + candidate.title + '  ');
        if (event.x >= column && event.x < end) {setActive(candidate.id); setFocusArea('tabs'); return;}
        column = end;
      }
    }
    if (tab?.statusbar) {
      if (event.y >= contentTop && event.y < contentTop + contentHeight) setFocusArea('content');
      return;
    }
    if (tab && items && event.y >= contentTop && event.y < contentTop + visibleToggleCount) {
      const at = start + event.y - contentTop, x = event.x - padding;
      const item = items[at];
      if (!item || x < 0 || x >= columns) return;
      setFocusArea('content');
      setFocused(previous => ({...previous, [tab.id]: at}));
      const hasControls = Boolean(item.options?.length) || columns >= 18;
      if (hasControls && x >= columns - 4) {
        adjustItem(at, x < columns - 2 ? -1 : 1);
      } else if (item.options?.length) {
        changeValue(at, 1);
      } else {
        toggle(at);
      }
    }
  });

  const itemHelp = reorderable ? '←→ Reorder · Space Toggle'
    : items?.[selected]?.options?.length ? '←→ Previous/next · Space Next'
    : '← Off · → On · Space Toggle';
  const footer = saving ? 'Saving...'
    : confirm ? 'y Confirm · any other key Cancel'
    : modeTab ? (draftMode ? 'Enter Apply and save · Space / ←→ Change · Esc Discard' : 'Space / m / ←→ Change mode · ↑↓ Scroll · Esc Back')
    : tab?.id === 'providers' ? '[t] Test   [r] Refresh   [x] Logout   [←→] Provider   [↑↓] Scroll   [Esc] Back'
    : items ? `${hasTabBar ? focusArea === 'tabs' ? '←→ / Tab Switch · ↓ Edit · ' : 'Tab Switch · ' : ''}↑↓ Select · Enter ${hasTabBar ? 'Apply tab' : 'Save'} · Esc ${hasTabBar ? 'Close / discard unsaved' : 'Discard'}`
    : `${hasTabBar ? '←→ / Tab Switch · ' : ''}↑↓ / PgUp PgDn Scroll · Esc Back`;

  return (
    <CommandPane title={title} width={width} height={height} footer={error || notice || footer}>
      {hasTabBar && (
        <>
          <Box height={1} flexShrink={0} overflow="hidden">
            {stringWidth(tabs.map(item => '  ' + item.title + '  ').join('')) > columns ? (
              <Text color={palette.accent} bold wrap="truncate">
                {clipLine('❯ ' + (tab?.title ?? '') + ' · ' + (index + 1) + '/' + tabs.length, columns)}
              </Text>
            ) : (
              tabs.map(item => (
                <Text key={item.id} bold={item.id === tab?.id} color={item.id === tab?.id ? palette.accent : palette.muted}>
                  {(item.id === tab?.id ? '❯ ' : '  ') + item.title + '  '}
                </Text>
              ))
            )}
          </Box>
          <Box height={1} flexShrink={0}/>
        </>
      )}
      <Box height={contentHeight} flexShrink={0} overflow="hidden" flexDirection="column">
        {tab?.statusbar && items ? <StatusbarEditor key={tab.id} items={items} appearance={appearances[tab.id] ?? tab.statusbar.appearance}
          status={tab.statusbar.status} width={columns} height={contentHeight} x={panePadding(width)} y={hasTabBar ? 4 : 2}
          active={focusArea === 'content'} disabled={saving} isLocked={() => saving || pendingSave.current} error={error}
          onItems={changeItems} onAppearance={changeAppearance}
          onFocusTabs={() => {if (hasTabBar) setFocusArea('tabs');}}/> : items ? (
          <>
            <ToggleList items={items} selected={selected} start={start} count={visibleToggleCount} width={columns} disabled={saving}/>
            <Text color={error ? palette.error : palette.muted} wrap="truncate">
              {clipLine(error || (reorderable ? itemHelp + ' · Order sets narrow-screen priority' : itemHelp), columns)}
            </Text>
            {hasLinesWithItems && (
              <Box flexDirection="column" marginTop={1} overflow="hidden">
                {lines.slice(0, Math.max(0, contentHeight - visibleToggleCount - 2)).map((line, i) => <DisplayLine key={i} row={line}/>)}
              </Box>
            )}
          </>
        ) : (
          lines.slice(offset, offset + contentHeight).map((line, i) => <DisplayLine key={i} row={line}/>)
        )}
      </Box>
    </CommandPane>
  );
}
