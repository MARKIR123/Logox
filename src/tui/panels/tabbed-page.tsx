import React, {useRef, useState, type ReactElement} from 'react';
import stringWidth from 'string-width';
import {Box, Text, useInput} from 'ink';
import type {CommandTab, CommandToggle, TabRow} from '../../runtime/command-surface.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import wrapAnsi from 'wrap-ansi';
import {clipLine} from '../terminal/text.js';
import {PanelFrame as CommandPane, footerParts, hitFooter, panePadding, panelRows, type FooterAction} from '../components/panel-frame.js';
import {ToggleList, moveToggle, cycleToggleOption, toggleZone} from './toggle-list.js';
import {inRegion, useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';
import type {StatusbarAppearance} from '../../config/statusbar-preferences.js';
import {StatusbarEditor} from '../status/statusbar-editor.js';
import {initialPermissionsUi, permissionsView, reduceClick, reducePermissions, selectedRule, type EditorClick, type PermissionsUi} from './permissions-editor.js';

interface Cell {readonly text: string; readonly color: string; readonly bold?: boolean; readonly bg?: string; readonly hit?: EditorClick}
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
/** The click target of the cell under column `x` (relative to the row), if any; the same cells are drawn. */
function hitAt(row: DisplayRow, x: number): EditorClick | undefined {
  let column = 0;
  for (const cell of row) {
    const end = column + stringWidth(cell.text);
    if (x >= column && x < end) return cell.hit;
    column = end;
  }
  return undefined;
}
function DisplayLine({row, hovered, hoverColor}: {row: DisplayRow; hovered?: EditorClick | undefined; hoverColor?: string}) {
  return <Box height={1} flexShrink={0} overflow="hidden">
    {row.length ? <Text wrap="truncate">{row.map((cell, at) => {
      const over = hovered !== undefined && cell.hit === hovered && hoverColor !== undefined;
      return <Text key={at} color={over ? hoverColor : cell.color} bold={cell.bold === true || over} {...(cell.bg ? {backgroundColor: cell.bg} : {})}>{cell.text}</Text>;
    })}</Text> : <Text> </Text>}
  </Box>;
}

export function TabbedPage({title, tabs, initialTab, width, height, y = 0, onClose, onSave, onAction, confirm, saving = false, error = '', notice = ''}: {
  title: string; tabs: readonly CommandTab[]; initialTab: string; width: number; height: number; /** Screen row of the page's top rule. */ y?: number; onClose(): void;
  /** A pending yes/no from the host; while set, y or Enter confirms and any other key (Esc included) cancels it. */
  confirm?: {readonly tabId: string; readonly action: string; readonly prompt: string} | undefined;
  onSave?(tabId: string, items: readonly CommandToggle[], appearance?: StatusbarAppearance): void | Promise<void>;
  onAction?(tabId: string, action: string): void;
  saving?: boolean; error?: string; notice?: string;
}): ReactElement {
  const [active, setActive] = useState(initialTab);
  // Permission mode is edited as a draft; nothing is saved until Enter.
  const [modeDraft, setModeDraft] = useState<string | undefined>(undefined);
  const [permissionsUi, setPermissionsUi] = useState<PermissionsUi>(initialPermissionsUi);
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
  // A click on the mode name steps to the next mode, exactly like Space.
  const modeIds = modeTab?.options.map(option => option.id) ?? [];
  const modeCycle: EditorClick = {kind: 'mode', id: modeIds[(Math.max(0, modeIds.indexOf(shownMode ?? '')) + 1) % Math.max(1, modeIds.length)] ?? ''};
  const permissionsView_ = tab?.permissions ? permissionsView(tab.permissions, permissionsUi, columns) : undefined;
  const lines: DisplayRow[] = permissionsView_ ? [...permissionsView_.rows] : [
    ...(confirm && confirm.tabId === tab?.id ? [[{text: '▲ ' + confirm.prompt, color: palette.warning, bold: true}] as DisplayRow,
      [{text: '  [y] / Enter Confirm', color: palette.muted, hit: {kind: 'confirm', yes: true}}, {text: ' · ', color: palette.muted}, {text: 'any other key Cancel', color: palette.muted, hit: {kind: 'confirm', yes: false}}] as DisplayRow, blankRow] : []),
    ...(modeTab && shownMode ? [[{text: 'Mode:', color: palette.panelLabel, hit: modeCycle}, {text: ' ' + shownMode, color: palette.fg, bold: true, hit: modeCycle},
      ...(draftMode ? [{text: ' · unsaved (Enter applies, Esc discards)', color: palette.warning, bold: true, hit: {kind: 'save-mode'} as const}] : []),
      {text: ' · ' + modeDescription, color: palette.muted}] as DisplayRow, blankRow] : []),
    ...tabDisplay(tab, columns)];
  const max = Math.max(0, lines.length - contentHeight);
  // The permissions page keeps its selected rule (or form field) in view instead of scrolling freely.
  const offset = permissionsView_ ? Math.max(0, Math.min(max, permissionsView_.focusRow - contentHeight + 2, Math.max(0, permissionsView_.focusRow - 3)))
    : Math.min(max, offsets[tab?.id ?? ''] ?? 0);
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
    if (tab?.permissions && (permissionsUi.form || permissionsUi.confirmDelete)) {
      const step = reducePermissions(tab.permissions, permissionsUi, input, key);
      setPermissionsUi(step.ui);
      if (step.action) onAction?.(tab.id, step.action);
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

    if (tab.permissions) {
      const step = reducePermissions(tab.permissions, permissionsUi, input, key);
      setPermissionsUi(step.ui);
      if (step.action) onAction?.(tab.id, step.action);
      if (step.handled) return;
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

  const itemHelp = reorderable ? '←→ Reorder · Space Toggle'
    : items?.[selected]?.options?.length ? '←→ Previous/next · Space Next'
    : '← Off · → On · Space Toggle';
  const footer = saving ? 'Saving...'
    : confirm ? 'y Confirm · any other key Cancel'
    : permissionsView_ ? permissionsView_.footer
    : modeTab ? (draftMode ? 'Enter Apply and save · Space / ←→ Change · Esc Discard' : 'Space / m / ←→ Change mode · ↑↓ Scroll · Esc Back')
    : tab?.id === 'providers' ? '[t] Test   [r] Refresh   [x] Logout   [←→] Provider   [↑↓] Scroll   [Esc] Back'
    : items ? `${hasTabBar ? focusArea === 'tabs' ? '←→ / Tab Switch · ↓ Edit · ' : 'Tab Switch · ' : ''}↑↓ Select · Enter ${hasTabBar ? 'Apply tab' : 'Save'} · Esc ${hasTabBar ? 'Close / discard unsaved' : 'Discard'}`
    : `${hasTabBar ? '←→ / Tab Switch · ' : ''}↑↓ / PgUp PgDn Scroll · Esc Back`;

  // Screen geometry shared by drawing and hit-testing: frame rows, then the tab bar (two rows) and the content.
  const padding = panePadding(width), frame = panelRows(height);
  const tabBarY = y + frame.bodyY, contentTop = tabBarY + (hasTabBar ? 2 : 0);
  const tabsFit = stringWidth(tabs.map(item => '  ' + item.title + '  ').join('')) <= columns;
  let tabX = padding;
  const tabCells = !hasTabBar ? [] : tabsFit ? tabs.map(item => {
    const text = (item.id === tab?.id ? '❯ ' : '  ') + item.title + '  ', x0 = tabX;
    tabX += stringWidth(text);
    return {id: item.id, text, region: {y: tabBarY, x0, x1: tabX}};
  }) : [{id: '', text: clipLine('❯ ' + (tab?.title ?? '') + ' · ' + (index + 1) + '/' + tabs.length, columns), region: {y: tabBarY, x0: padding, x1: padding + columns}}];
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);
  const activate = (click: EditorClick) => {
    if (confirm && click.kind === 'confirm') {onAction?.(confirm.tabId, click.yes ? confirm.action : 'cancel_confirm'); return;}
    if (tab?.permissions) {
      const step = reduceClick(tab.permissions, permissionsUi, click);
      setPermissionsUi(step.ui);
      if (step.action) onAction?.(tab.id, step.action);
    } else if (modeTab && click.kind === 'mode') setModeDraft(click.id);
    else if (modeTab && click.kind === 'save-mode' && draftMode && tab) onAction?.(tab.id, 'set_mode:' + draftMode);
  };
  const moveFocus = (delta: number) => {
    if (!tab || !items) return;
    setFocusArea('content');
    setFocused(previous => ({...previous, [tab.id]: Math.max(0, Math.min(items.length - 1, (previous[tab.id] ?? 0) + delta))}));
  };
  const ui = permissionsUi, permDirty = Boolean(tab?.permissions && ui.draftMode !== undefined && ui.draftMode !== tab.permissions.mode.current);
  const rule = tab?.permissions ? selectedRule(tab.permissions, ui) : undefined, ruleIndex = rule && tab?.permissions ? tab.permissions.rules.indexOf(rule) : -1;
  const saveMode = () => {if (tab && draftMode) onAction?.(tab.id, 'set_mode:' + draftMode);};
  const footerActions: readonly FooterAction[] = confirm ? [
    {label: 'y Confirm', run: () => activate({kind: 'confirm', yes: true})}, {label: 'any other key Cancel', run: () => activate({kind: 'confirm', yes: false})}]
    : permissionsView_ ? (ui.form ? [{label: 'Enter Add', run: () => activate({kind: 'submit'})}, {label: 'Esc Cancel', run: () => activate({kind: 'cancel'})}]
      : ui.confirmDelete ? [{label: 'y Delete', run: () => activate({kind: 'confirm', yes: true})}, {label: 'any other key Cancel', run: () => activate({kind: 'confirm', yes: false})}]
      : permDirty ? [{label: 'Enter Save mode', run: () => activate({kind: 'save-mode'})}, {label: 'Esc Discard', run: onClose}]
      : [{label: 'a Add', run: () => activate({kind: 'add'})}, ...(ruleIndex >= 0 ? [{label: 'd / Del Delete', run: () => activate({kind: 'delete', index: ruleIndex})}] : []), {label: 'Esc Back', run: onClose}])
    : modeTab ? (draftMode ? [{label: 'Enter Apply and save', run: saveMode}, {label: 'Esc Discard', run: onClose}] : [{label: 'Esc Back', run: onClose}])
    : tab?.id === 'providers' ? [{label: '[t] Test', run: () => onAction?.('providers', 'test')}, {label: '[r] Refresh', run: () => onAction?.('providers', 'refresh')},
      {label: '[x] Logout', run: () => onAction?.('providers', 'logout')}, {label: '[←', run: () => onAction?.('providers', 'prev_provider')},
      {label: '→]', run: () => onAction?.('providers', 'next_provider')}, {label: '[Esc] Back', run: onClose}]
    : items ? [{label: 'Enter ' + (hasTabBar ? 'Apply tab' : 'Save'), run: saveCurrent}, {label: 'Esc ' + (hasTabBar ? 'Close / discard unsaved' : 'Discard'), run: onClose}]
    : [{label: 'Esc Back', run: onClose}];
  const footerText = error || notice || footer;
  const footerView = footerParts(footerText, error || notice || saving ? [] : footerActions, width, y, height);
  const hoveredFooter = hitFooter(footerView, pointer);

  useMouse(event => {
    if (saving || pendingSave.current || event.x < 0 || event.x >= width || event.y < y || event.y >= y + height) return;
    const wheel = event.action === 'wheel_up' ? -1 : event.action === 'wheel_down' ? 1 : 0;
    if (wheel) {
      if (tab?.statusbar) {setFocusArea('content'); return;}
      if (items) moveFocus(wheel);
      else if (tab?.permissions && !permissionsUi.form && !permissionsUi.confirmDelete) {
        setPermissionsUi(reducePermissions(tab.permissions, permissionsUi, '', wheel < 0 ? {upArrow: true} : {downArrow: true}).ui);
      } else if (tab) setOffsets(previous => ({...previous, [tab.id]: Math.max(0, Math.min(max, offset + wheel * 3))}));
      return;
    }
    if (event.action !== 'press' || event.button !== 0) return;
    const clickedFooter = hitFooter(footerView, event);
    if (clickedFooter?.run) {clickedFooter.run(); return;}
    const clickedTab = tabCells.find(cell => inRegion(event, cell.region));
    if (clickedTab) {
      const target = clickedTab.id === '' ? tabs[(index + 1) % tabs.length] : tabs.find(item => item.id === clickedTab.id);
      if (target) {setActive(target.id); setFocusArea('tabs');}
      return;
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
      const zone = toggleZone(item, columns, x);
      if (zone !== 'row') adjustItem(at, zone === 'dec' ? -1 : 1);
      else if (item.options?.length) changeValue(at, 1);
      else toggle(at);
      return;
    }
    if (tab && !items && event.y >= contentTop && event.y < contentTop + contentHeight) {
      const line = lines[offset + event.y - contentTop], hit = line ? hitAt(line, event.x - padding) : undefined;
      if (hit) activate(hit);
    }
  });
  const overItem = items && pointer && pointer.y >= contentTop && pointer.y < contentTop + visibleToggleCount && items[start + pointer.y - contentTop]
    && pointer.x >= padding && pointer.x < padding + columns
    ? {index: start + pointer.y - contentTop, zone: toggleZone(items[start + pointer.y - contentTop]!, columns, pointer.x - padding)} : undefined;
  const lineHover = (row: DisplayRow, at: number): EditorClick | undefined =>
    pointer && pointer.y === contentTop + at && pointer.x >= padding && pointer.x < padding + columns ? hitAt(row, pointer.x - padding) : undefined;

  return (
    <CommandPane title={title} width={width} height={height} footer={footerText} parts={footerView} hovered={hoveredFooter} hoverColor={hoverColor}>
      {hasTabBar && (
        <>
          <Box height={1} flexShrink={0} overflow="hidden">
            {tabCells.map(cell => {
              const current = cell.id === '' || cell.id === tab?.id, hovered = !current && inRegion(pointer, cell.region);
              return <Text key={cell.id} bold={current || hovered} color={current ? palette.accent : hovered ? hoverColor : palette.muted} wrap="truncate">{cell.text}</Text>;
            })}
          </Box>
          <Box height={1} flexShrink={0}/>
        </>
      )}
      <Box height={contentHeight} flexShrink={0} overflow="hidden" flexDirection="column">
        {tab?.statusbar && items ? <StatusbarEditor key={tab.id} items={items} appearance={appearances[tab.id] ?? tab.statusbar.appearance}
          status={tab.statusbar.status} width={columns} height={contentHeight} x={padding} y={contentTop}
          active={focusArea === 'content'} disabled={saving} isLocked={() => saving || pendingSave.current} error={error}
          onItems={changeItems} onAppearance={changeAppearance}
          onFocusTabs={() => {if (hasTabBar) setFocusArea('tabs');}}/> : items ? (
          <>
            <ToggleList items={items} selected={selected} start={start} count={visibleToggleCount} width={columns} disabled={saving} hover={overItem} hoverColor={hoverColor}/>
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
          lines.slice(offset, offset + contentHeight).map((line, i) => <DisplayLine key={i} row={line} hovered={lineHover(line, i)} hoverColor={hoverColor}/>)
        )}
      </Box>
    </CommandPane>
  );
}
