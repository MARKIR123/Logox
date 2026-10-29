import React, {useRef, useState, type ReactElement} from 'react';
import stringWidth from 'string-width';
import {Box, Text, useInput} from 'ink';
import type {CommandTab, CommandToggle} from '../../runtime/command-surface.js';
import {palette} from '../appearance/theme.js';
import {safeText} from '../terminal/text.js';
import {layoutInput} from '../input/editor.js';
import {clipLine} from '../terminal/text.js';
import {PanelFrame as CommandPane, panePadding} from '../components/panel-frame.js';
import {ToggleList, moveToggle, cycleToggleOption} from './toggle-list.js';
import {useMouse} from '../terminal/mouse.js';
import type {StatusbarAppearance} from '../../config/statusbar-preferences.js';
import {StatusbarEditor} from '../status/statusbar-editor.js';

export function TabbedPage({title, tabs, initialTab, width, height, onClose, onSave, onAction, saving = false, error = '', notice = ''}: {
  title: string; tabs: readonly CommandTab[]; initialTab: string; width: number; height: number; onClose(): void;
  onSave?(tabId: string, items: readonly CommandToggle[], appearance?: StatusbarAppearance): void | Promise<void>;
  onAction?(tabId: string, action: string): void;
  saving?: boolean; error?: string; notice?: string;
}): ReactElement {
  const [active, setActive] = useState(initialTab);
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
  const lines = tab?.lines.flatMap(text => layoutInput({text: safeText(text), cursor: 0}, columns).lines.map(line => line.text)) ?? [];
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

    if (tab.id === 'permissions' && (input === ' ' || input === 'm' || input === 'M')) {
      onAction?.('permissions', 'toggle_mode');
      return;
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
                {lines.slice(0, Math.max(0, contentHeight - visibleToggleCount - 2)).map((line, i) => {
                  if (!line || !line.trim()) {
                    return <Box key={i} height={1} flexShrink={0}><Text> </Text></Box>;
                  }
                  if (line.startsWith('──') || line.startsWith('---')) {
                    return (
                      <Box key={i} height={1} flexShrink={0}>
                        <Text color={palette.panelSeparator} wrap="truncate">{clipLine(line, columns)}</Text>
                      </Box>
                    );
                  }
                  const colonIndex = line.indexOf(': ');
                  if (colonIndex > 0 && colonIndex < 35 && !line.startsWith('http') && !line.startsWith('  • ')) {
                    const label = line.slice(0, colonIndex + 1);
                    const value = line.slice(colonIndex + 1).trimStart();
                    return (
                      <Box key={i} height={1} flexShrink={0}>
                        <Text color={palette.panelLabel}>{label} </Text>
                        <Text color={palette.fg} bold wrap="truncate">{clipLine(value, Math.max(1, columns - stringWidth(label) - 1))}</Text>
                      </Box>
                    );
                  }
                  return (
                    <Box key={i} height={1} flexShrink={0}>
                      <Text color={palette.fg} wrap="truncate">{clipLine(line, columns)}</Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </>
        ) : (
          lines.slice(offset, offset + contentHeight).map((line, i) => {
            const isFirst = offset + i === 0;
            if (!line || !line.trim()) {
              return <Box key={i} height={1} flexShrink={0}><Text> </Text></Box>;
            }
            if (line.startsWith('──') || line.startsWith('---')) {
              return (
                <Box key={i} height={1} flexShrink={0}>
                  <Text color={palette.panelSeparator} wrap="truncate">{clipLine(line, columns)}</Text>
                </Box>
              );
            }
            if (isFirst) {
              return (
                <Box key={i} height={1} flexShrink={0}>
                  <Text color={palette.accent} bold wrap="truncate">{clipLine(line, columns)}</Text>
                </Box>
              );
            }
            const colonIndex = line.indexOf(': ');
            if (colonIndex > 0 && colonIndex < 35 && !line.startsWith('http') && !line.startsWith('  • ')) {
              const label = line.slice(0, colonIndex + 1);
              const value = line.slice(colonIndex + 1).trimStart();
              return (
                <Box key={i} height={1} flexShrink={0}>
                  <Text color={palette.panelLabel}>{label} </Text>
                  <Text color={palette.fg} bold wrap="truncate">{clipLine(value, Math.max(1, columns - stringWidth(label) - 1))}</Text>
                </Box>
              );
            }
            return (
              <Box key={i} height={1} flexShrink={0}>
                <Text color={palette.fg} wrap="truncate">{clipLine(line, columns)}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </CommandPane>
  );
}
