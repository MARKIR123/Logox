// The reading surface: how the timeline rectangle reaches the terminal plane (or a re-render when there is none), the
// pre-paint transfer of the visible rows, scrolling by anchor, and copying the selection with row decoration applied.
// `presentReading` is called from event handlers that may run between renders, so it recomputes the viewport itself.
import {useInsertionEffect, useState, type MutableRefObject} from 'react';
import type {Message} from '../../runtime/contracts.js';
import type {CommandSurface} from '../../runtime/command-surface.js';
import type {StatusbarSnapshot} from '../../config/statusbar-preferences.js';
import type {PlaneSide, TerminalPlane} from '../terminal/terminal-plane.js';
import {decorateRow} from './row-presentation.js';
import {selectionRange, selectionInViewport, type ContentSelection} from './selection.js';
import {extractSelection, normalizeSelection, viewport, type Anchor, type Row} from './viewport.js';

export interface ReadingInput {
  plane: TerminalPlane | null;
  messageRows: readonly Row[];
  timelineHeight: number;
  anchors: MutableRefObject<Record<string, Anchor | null>>;
  currentView: string;
  composerExpanded: boolean;
  surface: CommandSurface | null;
  welcome: Message | undefined;
  width: number;
  layout: StatusbarSnapshot | null;
  contentSelection: MutableRefObject<ContentSelection | null>;
  hoveredFoldIdRef: MutableRefObject<string | null>;
  view: ReturnType<typeof viewport>;
  selection: ReturnType<typeof selectionInViewport>;
  setAnchor(next: Anchor | null): void;
  /** The plan sidebar docked beside the timeline, painted by the plane in the same frame. */
  side?: PlaneSide | undefined;
  /** The narrow-terminal plan overlay covers the screen like the other takeover pages. */
  planOverlay?: boolean;
}

export function useReading({plane, messageRows, timelineHeight, anchors, currentView, composerExpanded, surface, welcome, width, layout, contentSelection,
  hoveredFoldIdRef, view, selection, setAnchor, side, planOverlay = false}: ReadingInput) {
  const [, refreshReading] = useState(0);
  const covered = () => composerExpanded || planOverlay || surface?.kind === 'page' || surface?.kind === 'settings' || surface?.kind === 'ensemble' || surface?.kind === 'theme' || surface?.kind === 'result' || surface?.kind === 'image' || welcome;
  const presentReading = () => {
    const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
    if (plane && covered()) {plane.hide(); return;}
    if (plane) plane.present({
      ...current,
      width,
      height: timelineHeight,
      selection: selectionInViewport(selectionRange(messageRows, contentSelection.current), current.start),
      motion: layout?.motion ?? true,
      hoveredFoldId: hoveredFoldIdRef.current,
      side,
    });
    else refreshReading(value => value + 1);
  };
  // Transfer the rectangle before Ink's resetAfterCommit paints the surrounding UI.
  useInsertionEffect(() => {
    if (!plane) return;
    if (covered()) plane.hide();
    else plane.present({
      ...view,
      width,
      height: timelineHeight,
      selection,
      motion: layout?.motion ?? true,
      hoveredFoldId: hoveredFoldIdRef.current,
      side,
    });
  });
  const copySelection = () => {
    const range = selectionRange(messageRows, contentSelection.current);
    if (!range) return '';
    const {start, end} = normalizeSelection(range);
    const firstY = Math.max(0, start.y);
    const lastY = Math.min(messageRows.length - 1, end.y);
    if (firstY > lastY) return '';
    const decoratedRows = [...messageRows];
    for (let y = firstY; y <= lastY; y++) {
      decoratedRows[y] = decorateRow(messageRows[y]!, plane?.time ?? Date.now(), layout?.motion ?? true);
    }
    return extractSelection(decoratedRows, range);
  };
  const readingRows = () => {
    if (plane && plane.rows.length) return plane.rows;
    return view.rows;
  };
  const scroll = (amount: number) => {
    const maxStart = Math.max(0, messageRows.length - timelineHeight);
    const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
    const start = Math.max(0, Math.min(maxStart, current.start + amount));
    if (start === current.start && !(amount > 0 && start === maxStart && anchors.current[currentView] !== null)) return;
    let readableIndex = start;
    while (readableIndex < start + timelineHeight && messageRows[readableIndex]?.noSelect) readableIndex++;
    const readable = messageRows[readableIndex];
    setAnchor(start >= maxStart ? null : readable ? {messageId: readable.messageId, line: readable.line,
      screenOffset: readableIndex - start,
      ...(readable.sourceStart !== undefined ? {sourceOffset: readable.sourceStart} : {})} : {messageId: '__top__', line: start});
  };
  return {presentReading, copySelection, readingRows, scroll};
}
