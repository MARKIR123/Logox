// Answering runtime interactions: editing the current response draft, approving or denying a permission request (Deny
// opens the inline note first), committing question answers, and the scripted demo-scene confirmations. These are plain
// closures over `App`'s state, rebuilt every render exactly as before; nothing here is memoized.
import type {Dispatch, SetStateAction} from 'react';
import type {RuntimeStore} from '../../runtime/store.js';
import {answerEnvelope} from '../../runtime/interactions.js';
import type {Answer, Interaction} from '../../runtime/contracts.js';
import type {PortfolioActivities} from '../../demo/portfolio.js';
import type {DemoSceneState, DemoSceneUi} from '../../demo/scene.js';
import {getInteractionUI} from '../../tools/ui-registry.js';
import {ownerHeader, type ActorStyles} from '../appearance/actor-style.js';
import type {NoticeTone} from '../status/notification-line.js';
import {approvalModel, type ApprovalDecision} from './approval-view.js';
import {initialResponse, interactionState, reduceResponse, type ResponseDraft} from './response-draft.js';

type Setter<T> = Dispatch<SetStateAction<T>>;
export interface AnswerDeps {
  store: RuntimeStore;
  roles: ActorStyles;
  scenario: PortfolioActivities | undefined;
  scene: DemoSceneState;
  request: Interaction | undefined;
  response: ResponseDraft | undefined;
  setResponses: Setter<Record<string, ResponseDraft>>;
  setScene: Setter<DemoSceneUi>;
  setFocus: Setter<'input' | 'question' | 'stop'>;
  setEditingCustom: Setter<boolean>;
  setDetailOffset: Setter<number>;
  setNotice(text: string, tone?: NoticeTone): void;
}

export function createAnswerActions({store, roles, scenario, scene, request, response, setResponses, setScene, setFocus, setEditingCustom, setDetailOffset, setNotice}: AnswerDeps) {
  const changeResponse = (update: (current: ResponseDraft) => ResponseDraft) => {
    if (request) setResponses(previous => ({...previous, [request.requestId]: update(previous[request.requestId] ?? initialResponse(request))}));
  };

  const confirmScenePermission = () => {
    if (!request || request.kind !== 'permission' || request.activityId !== scenario?.techne) return;
    const result = store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: scene.permissionChoice === 'allow' ? 'allow_once' : 'deny'}));
    if (!result.ok) {setNotice(result.reason, 'error'); return;}
    setScene(prev => ({...prev, folds: {...prev.folds, 'main-techne': false, 'history-techne-question': false}}));
    setFocus('input');
  };

  const confirmSceneStyle = () => {
    if (!request || request.kind !== 'question' || request.activityId !== scenario?.kalon) return;
    const custom = scene.custom.trim();
    if (scene.choice === 'custom' && !custom) {setScene(prev => ({...prev, customError: true})); return;}
    const base = scene.choice === 'minimal' ? 'Restrained text portfolio' : scene.choice === 'editorial' ? 'Warm editorial' : custom;
    const answer: Answer = scene.choice === 'custom' || custom
      ? {type: 'text', text: (base + (scene.choice !== 'custom' && custom ? ', ' + custom : '')).slice(0, 500)}
      : {type: 'option', optionId: scene.choice};
    const result = store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {style: answer}}));
    if (!result.ok) {setNotice(result.reason, 'error'); return;}
    setScene(prev => ({...prev, customError: false, folds: {...prev.folds, 'main-kalon': false, 'history-kalon-question': false}}));
    setEditingCustom(false);
    setFocus('input');
  };

  const actorNameOf = (item: Interaction) => ownerHeader(item.ownerId, roles).replace(/^\S+\s+/, '');
  const patchResponse = (item: Interaction, update: (current: ResponseDraft) => ResponseDraft) =>
    setResponses(previous => ({...previous, [item.requestId]: update(previous[item.requestId] ?? initialResponse(item))}));
  /** Sends an approval answer; Deny first opens the inline note and only a second confirmation sends it. */
  const choosePermission = (item: Interaction, decision: ApprovalDecision, note?: string) => {
    if (item.kind !== 'permission') return;
    if (decision === 'deny' && note === undefined) {
      const at = approvalModel(item, actorNameOf(item)).options.findIndex(option => option.id === 'deny');
      patchResponse(item, current => ({...current, selected: at, noting: true, error: ''}));
      setFocus('question');
      return;
    }
    const text = note?.trim();
    const result = store.interactions.respond(answerEnvelope(item, {kind: 'permission', decision, ...(decision === 'deny' && text ? {note: text} : {})}));
    if (result.ok) { setFocus('input'); setDetailOffset(0); }
    else patchResponse(item, current => ({...current, error: result.reason}));
  };
  const commitAnswer = () => {
    if (!request || !response) return;
    if (request.kind === 'permission') {
      const option = approvalModel(request, actorNameOf(request)).options[response.selected];
      if (option) choosePermission(request, option.id, response.noting === true ? response.text : undefined);
      return;
    }
    const transition = getInteractionUI(request)?.reduce(interactionState(request, response), {kind: 'submit'});
    if (!transition) return;
    if (!transition.complete) {
      changeResponse(current => reduceResponse(request, current, {kind: 'submit'}));
      setDetailOffset(0);
      return;
    }
    const result = store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: transition.answers}));
    if (result.ok) { setFocus('input'); setDetailOffset(0); }
    else changeResponse(current => ({...current, error: result.reason}));
  };
  return {changeResponse, confirmScenePermission, confirmSceneStyle, actorNameOf, patchResponse, choosePermission, commitAnswer};
}
