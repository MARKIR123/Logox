// What a click on a clickable part of a persistent notice does (`src/runtime/notices.ts:NoticeAction`). The actions are plain data; this is the
// one place that turns them into terminal behaviour, so the footer, the Notices page and Enter all run the same code.
import {DIRECTOR_ID, isDirector} from '../../runtime/director-id.js';
import type {NoticeAction} from '../../runtime/notices.js';
import type {SceneRow} from '../timeline/scene.js';
import type {ShellContext} from './shell-context.js';

/**
 * Runs one action. A jump needs the Director window (it shows every actor's cards and every open request): from another window the action
 * waits (`ctx.jumpLater`) for the switch and then runs again.
 */
export function runNoticeAction(ctx: ShellContext, action: NoticeAction): void {
  const {surfaces, onSubmit, flash, currentView, switchView, jumpLater} = ctx;
  switch (action.kind) {
    case 'command': {
      const line = '/' + action.name + (action.args ? ' ' + action.args : '');
      void onSubmit(line, currentView, {mode: 'queue'}).catch(error => flash(error instanceof Error ? error.message : String(error), 3500, 'error'));
      return;
    }
    case 'open-page':
      try {surfaces?.openResult(action.title, action.text, undefined, undefined, action.markdown === true);}
      catch (error) {flash(error instanceof Error ? error.message : 'Close the open page first.', 3500, 'error');}
      return;
    case 'jump-request': {
      // The request is answered where it waits: its owner's window, or the Director window, which lists every open request.
      if (!isDirector(currentView) && currentView !== action.ownerId) {jumpLater(action); switchView(DIRECTOR_ID); return;}
      const target = ctx.pending.find(item => item.requestId === action.requestId);
      if (!target) {flash('That request is no longer open.', 2500, 'info'); return;}
      ctx.setFocus('question');
      ctx.setSelectedRequestId(action.requestId);
      ctx.setScene(previous => ({...previous, folds: {...previous.folds, [target.activityId]: true, [action.requestId]: true}}));
      const index = ctx.messageRows.findIndex(row => row.messageId === action.requestId);
      if (index >= 0) ctx.setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
      return;
    }
    case 'jump-activity': {
      if (!isDirector(currentView)) {jumpLater(action); switchView(DIRECTOR_ID); return;}
      const index = ctx.messageRows.findIndex(row => (row as SceneRow).action?.foldId === action.activityId || row.messageId === action.activityId);
      if (index < 0) {flash('That card is no longer in the timeline.', 2500, 'info'); return;}
      ctx.setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
      ctx.setHoveredFoldId(action.activityId); ctx.hoveredFoldIdRef.current = action.activityId; ctx.presentReading();
      return;
    }
  }
}

/** A click on a region of row 2's notice: a part runs its action, `×` dismisses the notice, `+N` opens the Notices page. */
export function clickNoticeRegion(ctx: ShellContext, id: string): void {
  const top = ctx.notices[0], effect = ctx.noticeRow?.effect(id);
  if (!top || !effect) return;
  if (effect.kind === 'dismiss') ctx.noticeBoard?.dismiss(top.id);
  else if (effect.kind === 'notices') {try {ctx.surfaces?.openNotices();} catch {/* another page is open */}}
  else runNoticeAction(ctx, effect.action);
}
