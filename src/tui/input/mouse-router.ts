// The mouse router: wheel scrolling, hover tracking, footer/pill/widget clicks, composer caret and drag, pending-row controls,
// timeline text selection with edge auto-scroll, and the press/release gesture that becomes a timeline click. One handler is
// built per render from the `ShellContext` and installed in `App`'s `mouseHandlerRef`.
import {DIRECTOR_ID, isDirector} from '../../runtime/director-id.js';
import type {ActorId} from '../../actors/ensemble.js';
import {findLatestActorRowIndex} from '../timeline/actor-location.js';
import {actionAt, hoveredCardAt, type SceneRow} from '../timeline/scene.js';
import {clickTimeline} from '../timeline/timeline-click.js';
import {contentPoint} from '../timeline/selection.js';
import {viewport} from '../timeline/viewport.js';
import {extractStatusBarSlice} from '../status/statusbar.js';
import {widgetCommand} from '../status/notification-line.js';
import {osc52Clipboard} from '../terminal/clipboard.js';
import type {SgrMouseEvent} from '../terminal/mouse.js';
import {cursorAt} from './editor.js';
import type {ShellContext} from './shell-context.js';

export function createMouseHandler(ctx: ShellContext): (event: SgrMouseEvent) => void {
  const {sessionId, close, focus, scroll, expanded, activePills, activity, activityHeight, anchors, atExpandButton, clearSelection, composerExpanded, contentSelection, copySelection,
      currentView, demoScene, edgePointer, edgeTimer, edit, editableComposer, exitDeadline, flash, footerHeight, footerLayout,
      footerStatusText, footerStatusY, gesture, hoveredFoldIdRef, hoveredPillRef, hoveredStopRef, hoveredWidgetRef, inputColumns,
      inputDrag, inputHeight, inputKey, inputLayout, inputView, inputY, lastClickRef, lastHoverRef, loginFolded, loginState, menuHeight,
      messageRows, mouseListeners, noticeInline, onSubmit, pendingAt, presentReading, promptWidth, questionHeight, readingRows, roles,
      screenRows, sendPending, setAnchor, setComposerMode, setEditingCustom, setExpandHovered, setExpanded, setFocus, setHoveredFoldId,
      setHoveredPill, setHoveredStop, setHoveredWidget, setNotice, setPendingHover, stage, statusSelectionRef, stdout, stopEdgeScroll,
      surface, switchView, takePendingBack, timelineHeight, width} = ctx;
  const updateDrag = (x: number, y: number) => {
    const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
    const selected = contentSelection.current;
    if (!selected || !gesture.current) return;
    const rowIndex = current.start + Math.max(0, Math.min(timelineHeight - 1, y));
    contentSelection.current = {...selected, focus: contentPoint(messageRows, rowIndex, x)};
    presentReading();
  };
  const dragAt = (x: number, y: number) => {
    if (!gesture.current) return;
    if (x !== gesture.current.x || y !== gesture.current.y) gesture.current.dragged = true;
    if (gesture.current.lastDragX === x && gesture.current.lastDragY === y) return;
    gesture.current.lastDragX = x;
    gesture.current.lastDragY = y;
    updateDrag(x, y);
    edgePointer.current = {x, y};
    if (gesture.current.dragged && (y <= 0 || y >= timelineHeight - 1) && !edgeTimer.current) {
      edgeTimer.current = setInterval(() => {
        const point = edgePointer.current;
        if (!point || !gesture.current?.dragged) {stopEdgeScroll(); return;}
        scroll(point.y <= 0 ? -1 : 1);
        updateDrag(point.x, point.y);
      }, 40);
    } else if (y > 0 && y < timelineHeight - 1) stopEdgeScroll();
  };
  return (event: SgrMouseEvent) => {
    for (const listener of mouseListeners.current) listener(event);
    if (composerExpanded || loginState && !loginFolded || surface) {inputDrag.current = null; return;}
    if (inputDrag.current && (event.action === 'drag' || event.action === 'release')) {
      const drag = inputDrag.current;
      if (drag.key === inputKey && editableComposer) {
        const row = Math.max(0, Math.min(inputLayout.lines.length - 1, inputView.start + event.y - inputY));
        const cursor = cursorAt(inputLayout, row, Math.max(0, Math.min(inputColumns, event.x - promptWidth)));
        edit(current => ({text: current.text, cursor, anchor: drag.anchor}));
      }
      if (event.action === 'release') inputDrag.current = null;
      return;
    }
    if (event.action === 'wheel_up') { if (event.y < timelineHeight) scroll(-3); return; }
    if (event.action === 'wheel_down') { if (event.y < timelineHeight) scroll(3); return; }
    if (event.action === 'move') {
      const nextExpandHover = atExpandButton(event);
      setExpandHovered(previous => previous === nextExpandHover ? previous : nextExpandHover);
      const overPending = pendingAt(event);
      const nextPending = overPending?.control ? {id: overPending.item.id, control: overPending.control} : null;
      setPendingHover(previous => previous?.id === nextPending?.id && previous?.control === nextPending?.control ? previous : nextPending);
      const overStatus = footerHeight > 0 && event.y === footerStatusY;
      const hoveredPillItem = overStatus ? activePills.find(pill => event.x >= pill.startX && event.x < pill.endX) : undefined;
      const nextHoveredPill = hoveredPillItem ? hoveredPillItem.ownerId : null;
      const hoveredRegion = overStatus && !hoveredPillItem && !noticeInline ? footerLayout.regions.find(region => event.x >= region.startX && event.x < region.endX) : undefined;
      const nextHoveredWidget = hoveredRegion ? hoveredRegion.id : null;
      if (hoveredPillRef.current !== nextHoveredPill) {
        hoveredPillRef.current = nextHoveredPill;
        setHoveredPill(nextHoveredPill);
      }
      if (hoveredWidgetRef.current !== nextHoveredWidget) {
        hoveredWidgetRef.current = nextHoveredWidget;
        setHoveredWidget(nextHoveredWidget);
      }
      if (lastHoverRef.current.x === event.x && lastHoverRef.current.y === event.y) return;
      lastHoverRef.current = {x: event.x, y: event.y};
      const rows = readingRows();
      const row = event.y < timelineHeight ? (rows[event.y] as SceneRow | undefined) : undefined;
      const control = row?.controls?.find(item => event.x >= item.startCol && event.x < item.endCol && !item.disabled);
      const nextStop = control?.action.foldId ?? '';
      if (hoveredStopRef.current !== nextStop) {
        hoveredStopRef.current = nextStop;
        setHoveredStop(nextStop);
      }
      const target = (demoScene || stage) && event.y < timelineHeight
        ? hoveredCardAt(row, event.x)
        : !demoScene && activity && !expanded && event.y >= timelineHeight && event.y < timelineHeight + activityHeight && event.x < width
          ? activity.activityId : null;
      if (hoveredFoldIdRef.current !== target) {
        hoveredFoldIdRef.current = target;
        presentReading();
        setHoveredFoldId(target);
      }
      return;
    }
    if (event.button !== 0) return;

    if (event.action === 'press') {
      const menuY = timelineHeight + activityHeight + questionHeight;
      // The shared menu handles its own item coordinates through MouseContext.
      // Keep presses on its title/footer away from the timeline/composer handlers.
      if (menuHeight && event.y >= menuY && event.y < menuY + menuHeight) return;
      // Footer click: row 2 (notifications) is passive.
      if (footerHeight > 1 && event.y > footerStatusY) return;
      if (event.y >= screenRows - footerHeight) {
        const clickedPill = activePills.find(pill => event.x >= pill.startX && event.x < pill.endX);
        const clickedRegion = clickedPill || noticeInline ? undefined : footerLayout.regions.find(region => event.x >= region.startX && event.x < region.endX);
        const command = clickedRegion ? widgetCommand(clickedRegion.id) : undefined;
        if (command) {
          clearSelection();
          void onSubmit(command, currentView, {mode: 'queue'}).catch(error => flash(error instanceof Error ? error.message : String(error), 3500, 'error'));
          return;
        }
        if (clickedPill) {
          const now = Date.now();
          if (now - lastClickRef.current.time < 350 && lastClickRef.current.key === 'pill:' + clickedPill.ownerId) {
            switchView(clickedPill.ownerId);
            lastClickRef.current = {time: 0, key: ''};
          } else {
            if (!isDirector(currentView)) {
              switchView(DIRECTOR_ID);
            }
            const targetIndex = findLatestActorRowIndex(messageRows, clickedPill.ownerId);
            if (targetIndex >= 0) {
              const targetRow = messageRows[targetIndex]!;
              setAnchor({
                messageId: targetRow.messageId,
                line: targetRow.line,
                screenOffset: 0,
                ...(targetRow.sourceStart !== undefined ? {sourceOffset: targetRow.sourceStart} : {}),
              });
              const highlightId = (targetRow as SceneRow).action?.foldId ?? targetRow.messageId;
              setHoveredFoldId(highlightId);
              hoveredFoldIdRef.current = highlightId;
              presentReading();
            }
            lastClickRef.current = {time: now, key: 'pill:' + clickedPill.ownerId};
          }
          return;
        }
        if (!isDirector(currentView)) {
          switchView(DIRECTOR_ID);
          return;
        }
        clearSelection();
        statusSelectionRef.current = {startX: event.x, currentX: event.x, active: true, text: footerStatusText};
        return;
      }
      const pressedPending = pendingAt(event);
      if (pressedPending) {
        if (pressedPending.control === 'send') sendPending(pressedPending.item.id);
        else if (pressedPending.control === 'discard') takePendingBack(pressedPending.item.id);
        return;
      }
      if (atExpandButton(event)) {
        clearSelection(); setNotice(''); exitDeadline.current = 0;
        setComposerMode({sessionId, ownerId: currentView, scrollOffset: null}); return;
      }
      // Composer input click focuses input
      if (event.y >= inputY && event.y < inputY + inputHeight) {
        if (editableComposer) {
          const cursor = cursorAt(inputLayout, inputView.start + event.y - inputY, Math.max(0, event.x - promptWidth));
          inputDrag.current = {key: inputKey, anchor: cursor};
          edit(current => ({text: current.text, cursor, anchor: cursor}));
        } else { setEditingCustom(false); setFocus('input'); }
        clearSelection();
        return;
      }
      if (event.y < timelineHeight) {
        stopEdgeScroll();
        const clickedRow = readingRows()[event.y] as SceneRow | undefined;
        const act = actionAt(clickedRow, event.x);
        const current = viewport(messageRows, timelineHeight, anchors.current[currentView] ?? null);
        const point = contentPoint(messageRows, current.start + event.y, event.x);
        contentSelection.current = {anchor: point, focus: point};
        gesture.current = {x: event.x, y: event.y, dragged: false, ...(act ? {action: act} : {}), ...(clickedRow ? {row: clickedRow} : {})};
        presentReading();
        return;
      }
      clearSelection();
      if (!demoScene && activity && event.y >= timelineHeight && event.y < timelineHeight + activityHeight) {
        const now = Date.now();
        if (now - lastClickRef.current.time < 350 && Object.hasOwn(roles, activity.ownerId) && !isDirector(activity.ownerId)) {
          switchView(activity.ownerId as ActorId);
          lastClickRef.current = {time: 0, key: ''};
        } else {
          setExpanded(value => !value);
          lastClickRef.current = {time: now, key: activity.activityId};
        }
      }
      return;
    }
    if (event.action === 'drag') {
      if (statusSelectionRef.current?.active) {
        statusSelectionRef.current.currentX = event.x;
        return;
      }
      dragAt(event.x, event.y);
      return;
    }
    if (event.action === 'release') {
      if (statusSelectionRef.current?.active) {
        const {startX, currentX, text} = statusSelectionRef.current;
        statusSelectionRef.current = null;
        if (Math.abs(startX - currentX) > 0) {
          const rawText = text;
          const copied = extractStatusBarSlice(rawText, startX, currentX);
          if (copied) {
            stdout?.write(osc52Clipboard(copied));
            exitDeadline.current = 0;
            flash('Copied statusbar content', 3500, 'success');
          }
        }
        return;
      }
      const pressed = gesture.current;
      if (!pressed) return;
      dragAt(event.x, event.y); stopEdgeScroll();
      gesture.current = null;
      if (!pressed.dragged) {
        contentSelection.current = null; presentReading();
        if (pressed.action && pressed.row) clickTimeline(ctx, pressed.action, pressed.row, event);
        return;
      }
      const copied = copySelection();
      if (copied) {stdout?.write(osc52Clipboard(copied)); exitDeadline.current = 0; flash('Copied selection (excluding rail)', 3500, 'success');}
    }
  };
}
