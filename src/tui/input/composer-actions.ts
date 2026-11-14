// What the composer does with its draft: submit it (queue or steer), complete a slash command, route an edit to the right
// draft (custom answer, approval note, question answer or the composer itself), and the pending-message controls (Send now,
// the `×` take-back, Ctrl+T steering). Closures over `App` state, rebuilt every render exactly as the inline versions were.
import {useRef} from 'react';
import {isDirector} from '../../runtime/director-id.js';
import type {Activity, Interaction, PendingInput} from '../../runtime/contracts.js';
import type {SubmitDelivery} from '../../application.js';
import type {DemoSceneUi} from '../../demo/scene.js';
import {applyCommandSuggestion, completionQuery, type CommandSuggestion} from '../commands/completion.js';
import {reduceResponse, type ResponseDraft} from '../interactions/response-draft.js';
import type {NoticeTone} from '../status/notification-line.js';
import {emptyDraft, graphemes, insert, type Draft, type InputHistory} from './editor.js';
import type {FocusTarget, Setter} from './shell-context.js';

type MutableRef<T> = {current: T};
export interface ComposerDeps {
  draft: Draft;
  activities: readonly Activity[];
  currentView: string;
  stage: boolean;
  demoScene: boolean;
  onSubmit(text: string, source?: string, delivery?: SubmitDelivery): Promise<void>;
  onDraft: (() => void) | undefined;
  onSendPending: ((id: string) => Promise<void> | void) | undefined;
  onDiscardPending: ((id: string) => string | undefined) | undefined;
  setComposerMode: Setter<{sessionId: string; ownerId: string; scrollOffset: number | null} | null>;
  setNotice(text: string, tone?: NoticeTone): void;
  flash(text: string, duration?: number, tone?: NoticeTone): void;
  draftRevisions: MutableRef<Map<string, number>>;
  historyFor(ownerId: string): InputHistory;
  setDrafts: Setter<Record<string, Draft>>;
  setAnchor(next: null): void;
  setDraft(fn: (current: Draft) => Draft): void;
  setCompletion: Setter<{query: string; selected: number; dismissed: boolean}>;
  completion: {query: string; selected: number; dismissed: boolean};
  editingCustom: boolean;
  setCustomDraft: Setter<Draft>;
  setScene: Setter<DemoSceneUi>;
  focus: FocusTarget;
  setFocus: Setter<FocusTarget>;
  request: Interaction | undefined;
  response: ResponseDraft | undefined;
  changeResponse(update: (current: ResponseDraft) => ResponseDraft): void;
  inlineRequest: unknown;
  setPendingHover: Setter<{id: string; control: 'send' | 'discard'} | null>;
  pendingAll: readonly PendingInput[];
  steerTarget: Activity | undefined;
  selectedActivityId: string;
}

export function useComposerActions({draft, activities, currentView, stage, demoScene, onSubmit, onDraft, onSendPending, onDiscardPending, setComposerMode, setNotice, flash,
  draftRevisions, historyFor, setDrafts, setAnchor, setDraft, setCompletion, completion, editingCustom, setCustomDraft, setScene, focus, setFocus, request, response,
  changeResponse, inlineRequest, setPendingHover, pendingAll, steerTarget, selectedActivityId}: ComposerDeps) {
  const submitting = useRef(false);
  const sendSceneInput = (text = draft.text, delivery: SubmitDelivery = {mode: 'queue'}) => {
    if (!text.trim() || submitting.current) return;
    submitting.current = true;
    setComposerMode(null);
    setNotice('');
    const source = delivery.mode === 'steer' ? activities.find(item => item.activityId === delivery.activityId)?.ownerId ?? currentView : currentView;
    const payload = delivery.mode === 'queue' && !stage && !demoScene && !isDirector(source) && !/^[@/]/.test(text) ? `@${source} ${text}` : text;
    const revision = draftRevisions.current.get(currentView) ?? 0;
    const history = historyFor(currentView);
    void onSubmit(payload, source, delivery).then(() => {
      history.record(text);
      setDrafts(prev => ({...prev, [currentView]: prev[currentView]?.text === text && (draftRevisions.current.get(currentView) ?? 0) === revision ? emptyDraft : prev[currentView] ?? emptyDraft}));
      if (!text.trim().startsWith('/')) setAnchor(null);
    }, error => {flash(error instanceof Error ? error.message : String(error), 3500, 'error');}).finally(() => {submitting.current = false;});
  };

  const complete = (suggestion: CommandSuggestion, execute: boolean) => {
    const next = applyCommandSuggestion(draft, suggestion);
    setDraft(() => next);
    onDraft?.();
    setCompletion({query: completionQuery(next, currentView), selected: 0,
      dismissed: suggestion.kind === 'argument' || !next.text.endsWith(' ')});
    if (execute && suggestion.execute) sendSceneInput(next.text);
  };

  const edit = (fn: (current: Draft) => Draft) => {
    if (editingCustom) {
      setCustomDraft(prev => {
        const next = fn(prev);
        setScene(s => ({...s, choice: 'custom', custom: next.text.slice(0, 500), customError: false}));
        return next;
      });
      return;
    }
    if (!demoScene && focus === 'question' && request?.kind === 'permission' && response?.noting) {
      changeResponse(current => {
        const editor = fn(current.editor);
        return {...current, editor, text: editor.text.replace(/[\r\n]+/g, ' ').slice(0, 500)};
      });
    } else if ((!inlineRequest || stage) && focus === 'question' && request?.kind === 'question' && response) {
      changeResponse(current => {
        const editor = fn(current.editor);
        return reduceResponse(request, {...current, editor, text: editor.text}, {kind: 'text', text: editor.text});
      });
    } else {
      setFocus('input');
      if (completion.query) setCompletion({query: '', selected: 0, dismissed: false});
      setDraft(fn);
      onDraft?.();
    }
  };
  const sendPending = (id: string) => {
    setPendingHover(null);
    void Promise.resolve(onSendPending?.(id)).catch(error => flash(error instanceof Error ? error.message : String(error), 3500, 'error'));
  };
  /** The `×` control: the message leaves the pending list and returns to the composer for editing (appended when the draft holds text). */
  const takePendingBack = (id: string) => {
    setPendingHover(null);
    const text = onDiscardPending?.(id);
    if (text) edit(current => current.text ? insert({...current, cursor: graphemes(current.text).length, anchor: graphemes(current.text).length}, '\n' + text) : insert(emptyDraft, text));
  };
  const steerInput = () => {
    if (focus !== 'input' || editingCustom) return;
    if (!draft.text.trim()) {
      // Nothing typed: Ctrl+T sends the newest pending message of this window now.
      const newest = pendingAll[pendingAll.length - 1];
      if (newest) sendPending(newest.id);
      return;
    }
    if (/^[@/]/.test(draft.text.trim())) {flash('Steering cannot execute commands or actor-routing syntax. Use Queue instead.', 3500, 'warning'); return;}
    if (!steerTarget) {flash(selectedActivityId ? 'The selected task is no longer active. The draft was retained.' : 'Select an active task with Ctrl+N before steering.'); return;}
    sendSceneInput(draft.text, {mode: 'steer', activityId: steerTarget.activityId});
  };
  return {sendSceneInput, complete, edit, sendPending, takePendingBack, steerInput};
}
