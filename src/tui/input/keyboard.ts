// The keyboard router: one `useInput` subscription that maps every key to the composer, command menu, question and approval
// drafts, card focus, window switching, scrolling, steering and the two-level Esc stop. It reads `App` state through the
// per-render `ShellContext` and calls back into `App`'s setters; the branch order below is the original priority order.
import {useInput} from 'ink';
import {DIRECTOR_ID, isDirector} from '../../runtime/director-id.js';
import {inputKind} from '../../runtime/provenance.js';
import {ESC_STOP_WINDOW_MS, actorsStoppedNotice, actorsWorkingNotice, logoxStoppedNotice, roundScope, workingNames} from '../../runtime/round-scope.js';
import {defaultSceneFoldOpen, isFoldOpen} from '../../demo/scene.js';
import type {ActorId} from '../../actors/ensemble.js';
import {uiSettings} from '../../config/ui-settings.js';
import {approvalModel, optionIndex} from '../interactions/approval-view.js';
import {reduceResponse} from '../interactions/response-draft.js';
import {completionQuery} from '../commands/completion.js';
import {osc52Clipboard} from '../terminal/clipboard.js';
import type {SceneRow} from '../timeline/scene.js';
import {stageFoldOpen} from '../timeline/stage.js';
import {draftSelection, emptyDraft, erase, graphemes, insert, move, moveToLineEdge, moveVertical, moveWord, navigateDraft, removeDraftSelection, selectedText} from './editor.js';
import type {ShellContext} from './shell-context.js';


const foldableDemoIds = ['main-thinking', 'main-tool', 'main-aletheia', 'main-aletheia-reads', 'main-techne', 'main-kalon', 'main-memory'] as const;

export function useKeyboard(ctx: ShellContext): void {
  useInput((input, key) => {
    const {query, focus, close, scroll, activeDraft, activities, activity, actorNameOf, cancelledInputs, cardCursor, changeResponse, choosePermission, clearSelection,
      closing, commitAnswer, complete, composerExpanded, confirmScenePermission, confirmSceneStyle, currentView, demoScene, detailMax,
      draft, edit, editableComposer, editingCustom, escArmedUntil, exitDeadline, flash, focusedStop, foldActivityId, foldIds, freeAnswer,
      historyFor, inlineRequest, inputColumns, inputLayout, interrupt, loginFolded, loginState, menuHeight, messageRows, moveSuggestion,
      notice, onCancel, pending, plane, questionPanel, request, response, roles, scene, selection, sendSceneInput, sessionId, setAnchor,
      setCardCursor, setCompletion, setDetailOffset, setDraft, setEditingCustom, setExpanded, setFocus, setFocusedStop, setNotice,
      setScene, setSelectedActivityId, setSelectedRequestId, snapshot, stage, stdout, steerInput, stopActor, store, suggestionIndex,
      suggestions, surface, switchView, timelineHeight} = ctx;
    plane?.noteInput();
    if (closing || key.eventType === 'release') return;
    if (!key.escape) escArmedUntil.current = 0; // Any other key ends the second-Esc window.
    if (composerExpanded) {
      if (!(key.ctrl && input === 'c')) exitDeadline.current = 0;
      return;
    }
    if (surface?.kind === 'result') {
      if (key.ctrl && input === 'd') close();
      return;
    }
    if (key.ctrl && input === 'c') {interrupt(); return;}
    exitDeadline.current = 0; if (notice) setNotice('');
    if (key.ctrl && input === 'd') { close(); return; }
    if (loginState && (!loginFolded || key.ctrl && input === 'k' || key.escape)) return;
    if (surface) return;
    if (key.ctrl && input === 't') {steerInput(); return;}
    if (editableComposer && key.ctrl && input === 'a') {edit(current => ({text: current.text, cursor: graphemes(current.text).length, anchor: 0})); return;}
    if (editableComposer && key.ctrl && input === 'x') {
      const text = selectedText(activeDraft);
      if (text) {stdout?.write(osc52Clipboard(text)); edit(removeDraftSelection);}
      return;
    }
    if (editableComposer && key.ctrl && ['u', 'k', 'w'].includes(input)) {
      edit(current => {
        if (draftSelection(current)) return removeDraftSelection(current);
        const edge = input === 'w' ? moveWord(current, -1).cursor : moveToLineEdge(current, input === 'k', inputColumns).cursor;
        return removeDraftSelection({...current, anchor: edge});
      }); return;
    }
    if (key.escape && editableComposer && draftSelection(activeDraft)) {edit(current => ({text: current.text, cursor: current.cursor})); return;}
    if (menuHeight && !key.ctrl && !key.meta && !key.shift) {
      if (key.upArrow || key.downArrow) {
        moveSuggestion(key.upArrow ? -1 : 1);
        return;
      }
      if (key.escape) {setCompletion({query, selected: suggestionIndex, dismissed: true}); return;}
      if (key.tab || key.return) {
        const selected = suggestions[suggestionIndex];
        if (selected) complete(selected, key.return);
        return;
      }
    }
    if (key.tab) {
      if (stage) {
        const stops = [...new Set(messageRows.flatMap(row => (row as SceneRow).controls?.filter(item => !item.disabled).flatMap(item => item.action.foldId ? [item.action.foldId] : []) ?? []))];
        const targets = ['input', ...pending.map(item => 'question:' + item.requestId), ...stops.map(id => 'stop:' + id)];
        const current = focus === 'stop' ? 'stop:' + focusedStop : focus === 'question' ? 'question:' + request?.requestId : 'input';
        const selected = targets[(Math.max(0, targets.indexOf(current)) + targets.length + (key.shift ? -1 : 1)) % targets.length]!;
        if (selected === 'input') {setFocus('input'); return;}
        const kind = selected.startsWith('stop:') ? 'stop' : 'question', id = selected.slice(kind.length + 1);
        setFocus(kind);
        if (kind === 'stop') {
          setFocusedStop(id);
          const index = messageRows.findIndex(row => (row as SceneRow).controls?.some(item => item.action.foldId === id));
          if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        } else {
          const target = pending.find(item => item.requestId === id);
          setSelectedRequestId(id);
          if (target) setScene(prev => ({...prev, folds: {...prev.folds, [target.activityId]: true, [id]: true}}));
          const index = messageRows.findIndex(row => row.messageId === id);
          if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        }
        return;
      }
      if (stage && request) {
        if (focus === 'question') {setFocus('input'); return;}
        setFocus('question');
        setScene(prev => ({...prev, folds: {...prev.folds, [request.activityId]: true, [request.requestId]: true}}));
        const index = messageRows.findIndex(row => row.messageId === request.requestId);
        if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        return;
      }
      if (demoScene && request) {
        setEditingCustom(false);
        if (focus === 'question') {setFocus('input'); return;}
        setFocus('question');
        if (inlineRequest) {
          const id = isDirector(currentView) ? 'main-' + request.ownerId : 'history-' + request.ownerId + '-question';
          setScene(prev => ({...prev, folds: {...prev.folds, [id]: true}}));
          const index = messageRows.findIndex(row => row.messageId.startsWith(id));
          if (index >= 0) setAnchor({messageId: '__top__', line: Math.max(0, index - 1)});
        }
        return;
      }
      if (request) { setFocus(value => value === 'input' ? 'question' : 'input'); return; }
    }
    if (key.ctrl && input === 'p' && pending.length) {
      const next = pending[(pending.findIndex(item => item.requestId === request?.requestId) + 1) % pending.length];
      if (next) setSelectedRequestId(next.requestId);
      setDetailOffset(0); return;
    }
    if (stage && key.ctrl && (input === 'n' || input === 'o')) {
      if (input === 'n') {
        const index = foldIds.length ? (cardCursor + 1) % foldIds.length : 0;
        setCardCursor(index); setSelectedActivityId(foldActivityId(foldIds[index]));
      } else {const id = foldIds[cardCursor % Math.max(1, foldIds.length)]; if (id) setScene(prev => ({...prev, folds: {...prev.folds, [id]: !stageFoldOpen(snapshot, id, prev.folds)}}));}
      return;
    }
    if (key.ctrl && input === 'n') {
      if (demoScene) {
        setCardCursor(c => (c + 1) % foldableDemoIds.length);
        return;
      }
      if (activities.length) {
        const next = activities[(activities.findIndex(item => item.activityId === activity?.activityId) + 1) % activities.length];
        if (next) setSelectedActivityId(next.activityId);
      }
      return;
    }
    if (key.ctrl && input === 'o') {
      if (demoScene) {
        const id = foldableDemoIds[cardCursor]!;
        setScene(prev => {
          const defaultOpen = defaultSceneFoldOpen(scene, id);
          return {...prev, folds: {...prev.folds, [id]: !isFoldOpen(prev, id, defaultOpen)}};
        });
        return;
      }
      setExpanded(value => !value);
      return;
    }
    if (key.ctrl && input === 'g') {
      if (stage) {const order = Object.keys(roles); switchView(order[(order.indexOf(currentView) + 1) % order.length] ?? DIRECTOR_ID); return;}
      if (demoScene) {
        const order: ActorId[] = ['logox', 'aletheia', 'techne', 'kalon'];
        const next = order[(order.indexOf(scene.view) + 1) % order.length]!;
        switchView(next);
        return;
      }
      const target = activity && Object.hasOwn(roles, activity.ownerId) && !isDirector(activity.ownerId)
        ? activity.ownerId as ActorId
        : isDirector(currentView) ? 'kalon' : DIRECTOR_ID;
      switchView(target);
      return;
    }
    if (!demoScene && focus === 'question' && request?.kind === 'permission' && response) {
      if (response.noting) {
        if (key.escape) {changeResponse(current => ({...current, noting: false, error: ''})); return;}
        if (key.return && !key.shift && !key.meta) {choosePermission(request, 'deny', response.text); return;}
      } else if (!key.ctrl && !key.meta && input.length === 1) {
        const at = optionIndex(approvalModel(request, actorNameOf(request)), input.toLowerCase());
        const option = approvalModel(request, actorNameOf(request)).options[at];
        if (option) {choosePermission(request, option.id); return;}
      }
    }
    if (key.ctrl && input === 'x' && focus === 'question' && request) {
      store.interactions.cancel(request.requestId); setFocus('input'); return;
    }
    if (key.escape) {
      if (stage && focus === 'question' && request) {setScene(prev => ({...prev, folds: {...prev.folds, [request.activityId]: false, [request.requestId]: false}})); setFocus('input'); return;}
      if (editingCustom) { setEditingCustom(false); setFocus('input'); return; }
      if (demoScene && focus === 'question') {
        setScene(prev => ({
          ...prev,
          folds: {
            ...prev.folds,
            ...(request?.kind === 'permission' ? {'main-techne': false, 'history-techne-question': false} : {'main-kalon': false, 'history-kalon-question': false}),
          },
        }));
        setFocus('input');
        return;
      }
      if (focus === 'question') { setFocus('input'); return; }
      if (!isDirector(currentView)) { switchView(DIRECTOR_ID); return; }
      if (focus === 'stop') {setFocus('input'); return;}
      if (selection) { clearSelection(); return; }
      const scope = roundScope(snapshot.activities, sessionId);
      const nameOf = (ownerId: string) => roles[ownerId]?.name ?? ownerId;
      const running = scope.director && !cancelledInputs.current.has(scope.director.activityId) ? scope.director : undefined;
      const others = scope.actors.filter(item => !cancelledInputs.current.has(item.activityId));
      const names = workingNames(others, nameOf);
      const armed = escArmedUntil.current > Date.now();
      escArmedUntil.current = 0;
      if (running) {
        // First Esc: only the Logox round. Its companions keep going; the notice says so and arms the second Esc.
        cancelledInputs.current.add(running.activityId); onCancel(running.activityId);
        if (others.length) escArmedUntil.current = Date.now() + ESC_STOP_WINDOW_MS;
        const original = snapshot.messages.findLast(message => message.sessionId === sessionId && message.activityId === running.activityId &&
          message.role === 'user' && inputKind(message) === 'human' && message.source !== 'steered');
        // Check the updater's draft, not the render's: typing and Esc can be batched.
        // Bumping the revision also protects it from a pending submission acknowledgment.
        setDraft(current => original && !current.text ? insert(emptyDraft, original.text) : current);
        if (others.length) flash(logoxStoppedNotice(names), ESC_STOP_WINDOW_MS, 'warning');
        else if (original && draft.text) flash('■ Logox stopped · your current draft was kept; use Up for earlier input', 3500, 'warning');
        else flash(logoxStoppedNotice([]), 2000, 'warning');
        if (original) setCompletion({query: '', selected: 0, dismissed: true});
      } else if (others.length && armed) {
        // Second Esc inside the window: everything Logox's work still has running or queued, with the user reason.
        for (const item of others) {cancelledInputs.current.add(item.activityId); onCancel(item.activityId);}
        flash(actorsStoppedNotice(names), 3500, 'warning');
      } else if (others.length) {
        escArmedUntil.current = Date.now() + ESC_STOP_WINDOW_MS;
        flash(actorsWorkingNotice(names), ESC_STOP_WINDOW_MS, 'warning');
      }
      return;
    }
    if (key.ctrl && (key.upArrow || key.downArrow) && request) {
      setDetailOffset(value => Math.max(0, Math.min(detailMax, value + (key.upArrow ? -2 : 2)))); return;
    }
    if (key.pageUp || key.pageDown) { scroll((key.pageUp ? -1 : 1) * Math.max(1, timelineHeight - 1)); return; }
    if (key.ctrl && input === 'e') { setAnchor(null); return; }
    if ((key.upArrow || key.downArrow) && editableComposer) {
      const direction = key.upArrow ? -1 : 1;
      const atEdge = direction < 0 ? inputLayout.cursorRow === 0 : inputLayout.cursorRow === inputLayout.lines.length - 1;
      if (!editingCustom && focus === 'input' && !key.shift && !key.ctrl && !key.meta && atEdge) {
        const next = historyFor(currentView).browse(draft, direction);
        edit(() => next);
        const nextQuery = completionQuery(next, currentView);
        setCompletion({query: nextQuery, selected: 0, dismissed: true});
        return;
      }
      const next = navigateDraft(activeDraft, current => moveVertical(current, direction, inputColumns), Boolean(key.shift));
      if (!freeAnswer || next.cursor !== activeDraft.cursor) { edit(() => next); return; }
    }
    if (demoScene && inlineRequest && focus === 'question' && (key.upArrow || key.downArrow)) {
      if (request?.kind === 'permission') {
        setScene(prev => ({...prev, permissionChoice: prev.permissionChoice === 'allow' ? 'deny' : 'allow'}));
        setFocus('question');
        return;
      }
      if (request?.kind === 'question') {
        const order: Array<'minimal' | 'editorial' | 'custom'> = ['minimal', 'editorial', 'custom'];
        const next = order[(order.indexOf(scene.choice) + (key.upArrow ? 2 : 1)) % 3]!;
        setScene(prev => ({...prev, choice: next, customError: false}));
        setEditingCustom(next === 'custom');
        setFocus('question');
        return;
      }
    }
    if ((!inlineRequest || stage) && focus === 'question' && request && response && (key.upArrow || key.downArrow)) {
      changeResponse(current => request.kind === 'permission'
        ? current.noting ? current : (() => {
          const count = approvalModel(request, '').options.length;
          return {...current, selected: ((current.selected + (key.upArrow ? -1 : 1)) % count + count) % count, error: ''};
        })()
        : reduceResponse(request, current, {kind: 'move', delta: key.upArrow ? -1 : 1}));
      return;
    }
    if (questionPanel && focus === 'question' && response && input === ' ' && !key.ctrl && !key.meta
      && questionPanel.questions[response.questionIndex]?.multiSelect) {
      changeResponse(current => reduceResponse(questionPanel, current, {kind: 'select', index: current.selected}));
      return;
    }
    // `Enter key: newline` (settings): Enter inserts a newline in the composer; Ctrl+Enter (terminals that report it) or Ctrl+S sends.
    const newlineMode = uiSettings().enterKey === 'newline' && stage && !demoScene && focus === 'input' && !editingCustom;
    if (newlineMode && key.ctrl && input === 's') {if (draft.text.trim()) sendSceneInput(); return;}
    if (key.ctrl && input === 'j') { edit(current => insert(current, '\n')); return; }
    if (key.return) {
      if (focus === 'stop') {stopActor(focusedStop); setFocus('input'); return;}
      if (key.shift || key.meta) { edit(current => insert(current, '\n')); return; }
      if (newlineMode) {
        if (!key.ctrl) edit(current => insert(current, '\n'));
        else if (draft.text.trim()) sendSceneInput();
        return;
      }
      if (demoScene && key.ctrl) {
        const match = /^main-(aletheia|techne|kalon)$/.exec(foldableDemoIds[cardCursor]!);
        if (match) switchView(match[1] as ActorId);
        return;
      }
      if (demoScene) {
        if (editingCustom || focus === 'question') {
          if (inlineRequest && request?.kind === 'permission') confirmScenePermission();
          else if (inlineRequest && request?.kind === 'question') confirmSceneStyle();
          else commitAnswer();
          return;
        }
        if (draft.text.trim()) {
          sendSceneInput();
          return;
        }
        if (inlineRequest && request?.kind === 'permission') {confirmScenePermission(); return;}
        if (inlineRequest && request?.kind === 'question') {confirmSceneStyle(); return;}
        return;
      }
      if (stage && key.ctrl) {
        const selected = activities.find(item => item.activityId === foldActivityId(foldIds[cardCursor % Math.max(1, foldIds.length)]));
        if (selected && Object.hasOwn(roles, selected.ownerId) && !isDirector(selected.ownerId)) switchView(selected.ownerId as ActorId);
        return;
      }
      if (key.ctrl && activity && Object.hasOwn(roles, activity.ownerId) && !isDirector(activity.ownerId)) {
        switchView(activity.ownerId as ActorId);
        return;
      }
      if (stage && focus === 'input') {sendSceneInput(); return;}
      if (focus === 'question') commitAnswer();
      else if (draft.text.trim()) sendSceneInput();
      return;
    }
    if (key.backspace) { edit(current => erase(current, true)); return; }
    if (key.delete) { edit(current => erase(current, false)); return; }
    if (key.leftArrow || key.rightArrow) {
      const direction = key.leftArrow ? -1 : 1;
      edit(current => navigateDraft(current, value => {
        const range = draftSelection(value);
        if (!key.shift && range) return {text: value.text, cursor: direction < 0 ? range.start : range.end};
        return key.ctrl || key.meta ? moveWord(value, direction) : move(value, direction);
      }, Boolean(key.shift))); return;
    }
    if (key.home || key.end) { edit(current => navigateDraft(current, value => key.ctrl ? move(value, key.home ? -Infinity : Infinity) : moveToLineEdge(value, Boolean(key.end), inputColumns), Boolean(key.shift))); return; }
    if (!key.ctrl && !key.meta && input) edit(current => insert(current, input));
  });
}
