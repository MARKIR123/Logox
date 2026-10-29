import {useMemo, useRef, useState} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';
import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import {panePadding} from '../components/panel-frame.js';
import {useMouse} from '../terminal/mouse.js';
import {clipLine, safeText} from '../terminal/text.js';
import {cursorAt, erase, graphemes, inputViewport, insert, layoutInput, move, moveToLineEdge, moveVertical, type Draft} from './editor.js';

export const COMPOSER_EXPAND_LABEL = '⛶';
export const COMPOSER_EXPAND_PADDING = 1;

/** Editing geometry is shared by drawing, mouse hit testing and the native caret. */
export function fullscreenEditorLayout(width: number, height: number) {
  width = Math.max(1, width); height = Math.max(1, height);
  const padding = panePadding(width), columns = Math.max(1, width - padding * 2 - 1);
  const top = height >= 5 ? 1 : 0, header = height >= 2 ? 1 : 0;
  const footer = height >= 3 ? 1 : 0, bottom = height >= 6 ? 1 : 0;
  const bodyY = top + header, bodyHeight = height - top - header - footer - bottom;
  const collapse = width >= 18 ? '[Collapse]' : '[↙]';
  const send = width >= 12 ? '[Send]' : '[↵]';
  return {width, height, padding, columns, top, header, footer, bottom, bodyY, bodyHeight,
    collapse, collapseX: Math.max(0, width - stringWidth(collapse)),
    send, sendX: Math.max(0, width - stringWidth(send)), footerY: height - bottom - footer};
}

type ChangeDraft = (update: (draft: Draft) => Draft) => void;

/** A view over the caller's draft, never a second editable copy or a task dispatcher. */
export function FullscreenEditor({draft, width, height, title = 'Compose', notice = '', disabled = false, onEdit, onCollapse, onSubmit, onSteer, onCopy, onInterrupt, onClose, onCursor, scrollOffset, onScroll: setScrollOffset}: {
  draft: Draft; width: number; height: number; title?: string; notice?: string; disabled?: boolean;
  onEdit: ChangeDraft; onCollapse(): void; onSubmit(): void; onSteer(): void;
  onCopy(text: string): void; onInterrupt(): void; onClose(): void;
  onCursor(position: {x: number; y: number} | undefined): void;
  /** null follows the caret; host-owned scrolling commits with the sole native cursor owner. */
  scrollOffset: number | null; onScroll(offset: number | null): void;
}) {
  const geometry = fullscreenEditorLayout(width, height);
  const layout = useMemo(() => layoutInput(draft, geometry.columns), [draft, geometry.columns]);
  const [anchor, setAnchorState] = useState<number | null>(null);
  const anchorRef = useRef<number | null>(null);
  const setAnchor = (value: number | null) => {anchorRef.current = value; setAnchorState(value);};
  const previousStart = useRef(0);
  const follow = inputViewport(layout, geometry.bodyHeight, previousStart.current);
  const maxStart = Math.max(0, layout.lines.length - geometry.bodyHeight);
  const start = scrollOffset === null ? follow.start : Math.max(0, Math.min(maxStart, scrollOffset));
  previousStart.current = start;
  const caretVisible = layout.cursorRow >= start && layout.cursorRow < start + geometry.bodyHeight;
  onCursor(caretVisible && !disabled ? {
    x: Math.min(geometry.width - 1, geometry.padding + layout.cursorColumn),
    y: geometry.bodyY + layout.cursorRow - start,
  } : undefined);
  const selected = anchor !== null && anchor !== draft.cursor ? {start: Math.min(anchor, draft.cursor), end: Math.max(anchor, draft.cursor)} : null;
  const removeSelection = (current: Draft, at: number | null): Draft => {
    if (at === null || at === current.cursor) return current;
    const parts = graphemes(current.text), low = Math.min(at, current.cursor), high = Math.max(at, current.cursor);
    return {text: parts.slice(0, low).concat(parts.slice(high)).join(''), cursor: low};
  };
  const replace = (text: string) => {
    const at = anchorRef.current; setAnchor(null); setScrollOffset(null);
    onEdit(current => insert(removeSelection(current, at), text));
  };
  const navigate = (update: (current: Draft) => Draft, selecting: boolean) => {
    if (selecting) {if (anchorRef.current === null) setAnchor(draft.cursor);} else setAnchor(null);
    setScrollOffset(null); onEdit(update);
  };
  const copy = (): boolean => {
    if (!selected) return false;
    onCopy(graphemes(draft.text).slice(selected.start, selected.end).join('')); return true;
  };
  const wordEdge = (current: Draft, direction: -1 | 1): Draft => {
    const parts = graphemes(current.text); let cursor = current.cursor;
    if (direction < 0) {
      while (cursor > 0 && /\s/u.test(parts[cursor - 1]!)) cursor--;
      while (cursor > 0 && !/\s/u.test(parts[cursor - 1]!)) cursor--;
    } else {
      while (cursor < parts.length && !/\s/u.test(parts[cursor]!)) cursor++;
      while (cursor < parts.length && /\s/u.test(parts[cursor]!)) cursor++;
    }
    return {text: current.text, cursor};
  };
  usePaste(text => {if (!disabled) replace(text);});
  useInput((input, key) => {
    if (disabled || key.eventType === 'release') return;
    if (key.ctrl && input === 'd') {onClose(); return;}
    if (key.escape) {if (selected) setAnchor(null); else onCollapse(); return;}
    if (key.ctrl && input === 'c') {if (!copy()) onInterrupt(); return;}
    if (key.ctrl && input === 'x') {if (copy()) replace(''); return;}
    if (key.ctrl && input === 'a') {setAnchor(0); setScrollOffset(null); onEdit(current => move(current, Infinity)); return;}
    if (key.ctrl && input === 't') {onSteer(); return;}
    if (key.return) {if (key.ctrl) {if (draft.text.trim()) onSubmit();} else replace('\n'); return;}
    if (key.ctrl && input === 'j') {replace('\n'); return;}
    if (key.tab) {replace('    '); return;}
    if (key.upArrow || key.downArrow) {navigate(current => moveVertical(current, key.upArrow ? -1 : 1, geometry.columns), Boolean(key.shift)); return;}
    if (key.leftArrow || key.rightArrow) {
      const direction = key.leftArrow ? -1 : 1;
      navigate(current => key.ctrl || key.meta ? wordEdge(current, direction)
        : !key.shift && selected ? move(current, (direction < 0 ? selected.start : selected.end) - current.cursor) : move(current, direction), Boolean(key.shift)); return;
    }
    if (key.home || key.end) {navigate(current => key.ctrl ? move(current, key.home ? -Infinity : Infinity) : moveToLineEdge(current, Boolean(key.end), geometry.columns), Boolean(key.shift)); return;}
    if (key.pageUp || key.pageDown) {
      const direction = key.pageUp ? -1 : 1;
      navigate(current => {
        const planned = layoutInput(current, geometry.columns);
        return {...current, cursor: cursorAt(planned, Math.max(0, Math.min(planned.lines.length - 1,
          planned.cursorRow + direction * geometry.bodyHeight)), planned.cursorColumn)};
      }, Boolean(key.shift)); return;
    }
    if (key.backspace || key.delete) {
      const at = anchorRef.current; setAnchor(null); setScrollOffset(null);
      onEdit(current => at !== null && at !== current.cursor ? removeSelection(current, at) : erase(current, Boolean(key.backspace))); return;
    }
    if (key.ctrl && ['u', 'k', 'w'].includes(input)) {
      const at = anchorRef.current; setAnchor(null); setScrollOffset(null);
      onEdit(current => {
        if (at !== null && at !== current.cursor) return removeSelection(current, at);
        const edge = input === 'w' ? wordEdge(current, -1).cursor : moveToLineEdge(current, input === 'k', geometry.columns).cursor;
        return removeSelection(current, edge);
      }); return;
    }
    if (!key.ctrl && !key.meta && input) replace(input);
  });
  const drag = useRef(false);
  const [hover, setHover] = useState<'collapse' | 'send' | null>(null);
  useMouse(event => {
    if (disabled) return;
    if (event.action === 'release') {drag.current = false; return;}
    if (event.x < 0 || event.x >= geometry.width || event.y < 0 || event.y >= geometry.height) {
      if (event.action === 'move') setHover(null);
      return;
    }
    const inBody = event.y >= geometry.bodyY && event.y < geometry.bodyY + geometry.bodyHeight;
    const hit = geometry.header && event.y === geometry.top && event.x >= geometry.collapseX ? 'collapse'
      : geometry.footer && event.y === geometry.footerY && event.x >= geometry.sendX ? 'send' : null;
    if (event.action === 'move') {setHover(hit); return;}
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {
      setScrollOffset(Math.max(0, Math.min(maxStart, start + (event.action === 'wheel_up' ? -3 : 3)))); return;
    }
    if (event.button !== 0) return;
    if (event.action === 'press' && hit) {if (hit === 'collapse') onCollapse(); else if (draft.text.trim()) onSubmit(); return;}
    if ((event.action === 'press' || event.action === 'drag' && drag.current) && inBody) {
      const cursor = cursorAt(layout, Math.min(layout.lines.length - 1, start + event.y - geometry.bodyY), Math.max(0, event.x - geometry.padding));
      if (event.action === 'press') {setAnchor(cursor); drag.current = true;}
      onEdit(current => ({text: current.text, cursor}));
    }
  });
  const footer = notice ? safeText(notice).replace(/\n/g, ' ') : geometry.width >= 65
    ? 'Enter / Shift+Enter Newline · Ctrl+Enter Send · Esc Back' : 'Enter Newline · ^Enter Send · Esc Back';
  const rule = <Box height={1} flexShrink={0}><Text color={palette.line}>{'─'.repeat(geometry.width)}</Text></Box>;
  return <Box width={geometry.width} height={geometry.height} overflow="hidden" flexDirection="column">
    {Boolean(geometry.top) && rule}
    {Boolean(geometry.header) && <Box height={1} flexShrink={0}>
      <Box width={geometry.collapseX} overflow="hidden"><Text bold color={palette.accent} wrap="truncate">{clipLine(safeText(title), Math.max(0, geometry.collapseX - 1))}</Text></Box>
      <Text color={hover === 'collapse' ? palette.strong : palette.muted}>{clipLine(geometry.collapse, geometry.width)}</Text>
    </Box>}
    <Box height={geometry.bodyHeight} flexShrink={0} flexDirection="column" overflow="hidden" paddingX={geometry.padding}>
      {layout.lines.slice(start, start + geometry.bodyHeight).map((line, index) => <Box key={start + index} height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate" color={palette.fg}>{(() => {
          if (!selected || selected.end <= line.start || selected.start >= line.end) return line.text || ' ';
          const parts = graphemes(line.text), low = Math.max(0, selected.start - line.start), high = Math.min(parts.length, selected.end - line.start);
          return <>{parts.slice(0, low).join('')}<Text color={palette.selectionFg} backgroundColor={palette.selectionBg}>{parts.slice(low, high).join('')}</Text>{parts.slice(high).join('')}</>;
        })()}</Text>
      </Box>)}
    </Box>
    {Boolean(geometry.footer) && <Box height={1} flexShrink={0}>
      <Box width={geometry.sendX} overflow="hidden"><Text color={notice ? palette.accent : palette.muted} wrap="truncate">{clipLine(footer, Math.max(0, geometry.sendX - 1))}</Text></Box>
      <Text color={draft.text.trim() ? hover === 'send' ? palette.strong : palette.fg : palette.muted}>{clipLine(geometry.send, geometry.width)}</Text>
    </Box>}
    {Boolean(geometry.bottom) && rule}
  </Box>;
}
