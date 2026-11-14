// A completed click (press and release without a drag) on a timeline row: folds, card selection, answer options, demo-scene
// choices and the double-click that opens an actor window. Pure routing over the per-render `ShellContext`.
import {defaultSceneFoldOpen, isFoldOpen} from '../../demo/scene.js';
import {approvalModel} from '../interactions/approval-view.js';
import {initialResponse, reduceResponse} from '../interactions/response-draft.js';
import type {ShellContext} from '../input/shell-context.js';
import type {SgrMouseEvent} from '../terminal/mouse.js';
import type {SceneAction, SceneRow} from './scene.js';
import {stageFoldOpen} from './stage.js';

export function clickTimeline(ctx: ShellContext, act: SceneAction, clickedRow: SceneRow, event: SgrMouseEvent): void {
  const {actorNameOf, choosePermission, commitAnswer, confirmScenePermission, confirmSceneStyle, demoScene, foldActivityId, foldIds,
      foldTimerRef, lastClickRef, pending, request, scene, setCardCursor, setEditingCustom, setFocus, setResponses, setScene,
      setSelectedActivityId, setSelectedRequestId, snapshot, stage, stopActor, switchView} = ctx;
  if (stage && act.foldId && act.kind !== 'stop_actor') {
    const index = foldIds.indexOf(act.foldId);
    if (index >= 0) setCardCursor(index);
    setSelectedActivityId(foldActivityId(act.foldId));
  }
  if (act.kind === 'stop_actor' && act.foldId) {stopActor(act.foldId); return;}
  const now = Date.now();
  if (stage && act.kind === 'select_answer' && act.requestId) {
    const clicked = pending.find(item => item.requestId === act.requestId);
    if (clicked) {setSelectedRequestId(clicked.requestId); setResponses(prev => {
      const current = prev[clicked.requestId] ?? initialResponse(clicked);
      return {...prev, [clicked.requestId]: clicked.kind === 'permission'
        ? {...current, selected: Number(act.value), error: ''}
        : reduceResponse(clicked, current, {kind: 'select', index: Number(act.value)})};
    }); setFocus('question');
    // A click on an approval option is deliberate: it answers (Deny opens the note first).
    const option = clicked.kind === 'permission' ? approvalModel(clicked, actorNameOf(clicked)).options[Number(act.value)] : undefined;
    if (option) choosePermission(clicked, option.id);}
    return;
  }
  if (stage && act.kind === 'confirm_answer' && act.requestId) {
    if (request?.requestId === act.requestId) commitAnswer(); else {setSelectedRequestId(act.requestId); setFocus('question');}
    return;
  }
  if (act.kind === 'toggle_fold' && act.foldId) {
    const id = act.foldId;
    setScene(prev => ({...prev, folds: {...prev.folds, [id]: !(stage ? stageFoldOpen(snapshot, id, prev.folds) : isFoldOpen(prev, id, false))}}));
    return;
  }
  if ((act.kind === 'actor_summary' || act.kind === 'actor_body') && act.foldId && act.owner) {
    const id = act.foldId;
    const owner = act.owner;
    if (now - lastClickRef.current.time < 320 && lastClickRef.current.key === `actor:${owner}`) {
      if (foldTimerRef.current) { clearTimeout(foldTimerRef.current); foldTimerRef.current = null; }
      lastClickRef.current = {time: 0, key: ''};
      switchView(owner);
    } else {
      lastClickRef.current = {time: now, key: `actor:${owner}`};
      if (foldTimerRef.current) clearTimeout(foldTimerRef.current);
      foldTimerRef.current = setTimeout(() => {
        setScene(prev => {
          const defaultOpen = demoScene ? defaultSceneFoldOpen(scene, id) : stageFoldOpen(snapshot, id, {});
          return {...prev, folds: {...prev.folds, [id]: !isFoldOpen(prev, id, defaultOpen)}};
        });
      }, 180);
    }
    return;
  }
  if (act.kind === 'actor_body' && act.owner) {
    const owner = act.owner;
    if (now - lastClickRef.current.time < 320 && lastClickRef.current.key === `actor:${owner}`) {
      lastClickRef.current = {time: 0, key: ''};
      switchView(owner);
      return;
    }
    lastClickRef.current = {time: now, key: `actor:${owner}`};
  }
  if (act.kind === 'select_permission' && (act.value === 'allow' || act.value === 'deny')) {
    const val = act.value;
    setScene(prev => ({...prev, permissionChoice: val}));
    setFocus('question');
    return;
  }
  if (act.kind === 'later' && act.foldId) {
    const id = act.foldId;
    setScene(prev => ({...prev, folds: {...prev.folds, [id]: false}}));
    setEditingCustom(false); setFocus('input');
    return;
  }
  if (act.kind === 'confirm_permission') {
    if (event.x >= clickedRow.gutterCols + 12 && act.foldId) {
      const id = act.foldId;
      setScene(prev => ({...prev, folds: {...prev.folds, [id]: false}}));
      setFocus('input');
    } else {
      confirmScenePermission();
    }
    return;
  }
  if (act.kind === 'select_style' && (act.value === 'minimal' || act.value === 'editorial' || act.value === 'custom')) {
    const val = act.value;
    setScene(prev => ({...prev, choice: val, customError: false}));
    setEditingCustom(val === 'custom');
    setFocus('question');
    return;
  }
  if (act.kind === 'focus_custom') {
    setScene(prev => ({...prev, choice: 'custom', customError: false}));
    setEditingCustom(true);
    setFocus('question');
    return;
  }
  if (act.kind === 'confirm_style') {
    if (event.x >= clickedRow.gutterCols + 12 && act.foldId) {
      const id = act.foldId;
      setScene(prev => ({...prev, folds: {...prev.folds, [id]: false}}));
      setEditingCustom(false);
      setFocus('input');
    } else {
      confirmSceneStyle();
    }
    return;
  }
}
