// The per-request answer draft kept by `App` (selection, free text, editor, collected answers) and the pure reducers over it.
// The tool-owned interaction UI (`getInteractionUI`) decides every transition; nothing here touches React or the store.
import type {Answer, Interaction} from '../../runtime/contracts.js';
import {getInteractionUI} from '../../tools/ui-registry.js';
import type {ToolInteractionAction} from '../../tools/ui-types.js';
import {emptyDraft, type Draft} from '../input/editor.js';
import type {QuestionDraft} from './choice-style.js';

export interface ResponseDraft extends QuestionDraft {answers: Record<string, Answer>; editor: Draft}
export function interactionState(request: Interaction, response: ResponseDraft) {
  return {request, draft: {...response, text: response.editor.text}, answers: response.answers};
}
export function reduceResponse(request: Interaction, response: ResponseDraft, action: ToolInteractionAction): ResponseDraft {
  const next = getInteractionUI(request)?.reduce(interactionState(request, response), action);
  if (!next) return response;
  return {...response, ...next.draft, answers: next.answers,
    editor: next.draft.questionIndex !== response.questionIndex ? emptyDraft : response.editor};
}
export function initialResponse(request: Interaction): ResponseDraft {
  return {questionIndex: 0, selected: 0, text: '', error: '', answers: {}, editor: emptyDraft};
}
