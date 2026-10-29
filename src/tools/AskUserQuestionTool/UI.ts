import {createElement} from 'react';
import {QuestionCard} from './QuestionCard.js';
import type {ToolInteractionAdapter, ToolInteractionContext, ToolInteractionTransition, ToolUI} from '../ui-types.js';
import {createToolUI} from '../../tui/timeline/tool-ui.js';
import {insetFrame, type SceneAction} from '../../tui/timeline/scene.js';
import {choiceStyle} from '../../tui/interactions/choice-style.js';
import {palette} from '../../tui/appearance/theme.js';

function renderQuestion(context: ToolInteractionContext): void {
  const {builder, request, draft, accent, frame: parent} = context;
  if (request.kind !== 'question') return;
  builder.pushOrdinaryCard({id: request.requestId, kind: 'Question', title: request.title, status: 'Pending',
    bodyLines: [], open: context.open, railColor: accent, ...(parent ? {parentFrame: parent} : {})});
  if (!context.open) return;
  const frame = insetFrame(parent ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth}, parent?.bg);
  const question = request.questions[draft.questionIndex];
  const multi = question?.multiSelect === true;
  builder.pushBlank(accent, frame);
  builder.pushProse(request.requestId + '-question', (draft.questionIndex + 1) + '/' + request.questions.length + ' · ' + (question?.question ?? ''), accent, 'body', frame);
  const options = [...question?.options ?? []];
  const optionCount = options.length;
  const customRow = !question?.hideCustomInput || optionCount === 0;
  if (customRow) options.push({id: 'custom', label: 'Custom input', description: draft.text || 'Enter your answer in the input area.'});
  for (const [index, option] of options.entries()) {
    const checked = multi && index < optionCount ? draft.checked?.includes(index) === true : index === draft.selected;
    const style = choiceStyle(index === draft.selected, accent, palette.fg, palette.muted, multi ? checked : undefined);
    const action: SceneAction = {kind: 'select_answer', requestId: request.requestId, value: String(index)};
    builder.pushBlank(accent, frame, action);
    builder.pushFramedLine(request.requestId + '-option-' + index, accent, [
      {text: style.marker, color: style.markerColor, selectionOffset: 0},
      {text: option.label, color: style.color, selectionOffset: style.marker.length},
    ], frame, action);
    builder.pushProse(request.requestId + '-description-' + index, ' '.repeat(style.indent) + option.description, accent, 'body', frame, action, style.descriptionColor);
  }
  builder.pushBlank(accent, frame);
  if (draft.error) builder.pushProse(request.requestId + '-error', draft.error, accent, 'body', frame, undefined, palette.error);
  builder.pushProse(request.requestId + '-confirm', multi ? 'Space/Enter to toggle · Enter on Custom to confirm · Esc to defer' : 'Enter to confirm · Esc to defer · Tab to change focus', accent, 'body', frame,
    {kind: 'confirm_answer', requestId: request.requestId}, accent);
  builder.pushBlank(accent, frame);
}

export const interaction: ToolInteractionAdapter = {
  describe({request, draft}) {
    if (request.kind !== 'question') return {editing: false, hint: ''};
    const question = request.questions[draft.questionIndex];
    const optionCount = question?.options?.length ?? 0;
    const customRow = !question?.hideCustomInput || optionCount === 0;
    if (question?.multiSelect === true) {
      return {editing: customRow && draft.selected === optionCount,
        hint: 'Selected: ' + (draft.checked?.length ?? 0) + ' option(s) · Enter to confirm'};
    }
    return {editing: customRow && draft.selected === optionCount,
      hint: 'Selected: ' + (question?.options?.[draft.selected]?.label ?? 'Custom input') + ' · Enter to confirm'};
  },
  render: renderQuestion,
  renderInline: context => createElement(QuestionCard, context),
  reduce({request, draft, answers}, action): ToolInteractionTransition {
    const current = {draft, answers: {...answers}};
    if (request.kind !== 'question') return current;
    const question = request.questions[draft.questionIndex];
    if (!question) return current;
    const multi = question.multiSelect === true;
    const optionCount = question.options?.length ?? 0;
    const customRow = !question.hideCustomInput || optionCount === 0;
    const count = Math.max(1, optionCount + (customRow ? 1 : 0));
    if (action.kind === 'defer') return {...current, deferred: true};
    if (action.kind === 'select') {
      const index = Math.max(0, Math.min(count - 1, action.index));
      if (multi && index < optionCount) {
        const checked = new Set(draft.checked ?? []);
        if (checked.has(index)) checked.delete(index); else checked.add(index);
        return {...current, draft: {...draft, selected: index, checked: [...checked].sort((a, b) => a - b), error: ''}};
      }
      return {...current, draft: {...draft, selected: index, error: ''}};
    }
    if (action.kind === 'move') return {...current, draft: {...draft, selected: ((draft.selected + action.delta) % count + count) % count, error: ''}};
    if (action.kind === 'text') {
      if (!customRow) return current;
      return {...current, draft: {...draft, selected: count - 1, text: action.text, error: ''}};
    }
    const customSelected = customRow && draft.selected === optionCount;
    if (customSelected && draft.text.trim()) {
      const nextAnswers = {...answers, [question.id]: {type: 'text' as const, text: draft.text}};
      if (draft.questionIndex + 1 < request.questions.length) return {answers: nextAnswers,
        draft: {questionIndex: draft.questionIndex + 1, selected: 0, text: '', error: '', checked: []}};
      return {draft: {...draft, error: ''}, answers: nextAnswers, complete: true};
    }
    if (multi) {
      const optionIds = (draft.checked ?? []).map(index => question.options?.[index]?.id).filter((id): id is string => !!id);
      if (!optionIds.length) return {...current, draft: {...draft, error: 'Select at least one option.'}};
      const nextAnswers = {...answers, [question.id]: {type: 'options' as const, optionIds}};
      if (draft.questionIndex + 1 < request.questions.length) return {answers: nextAnswers,
        draft: {questionIndex: draft.questionIndex + 1, selected: 0, text: '', error: '', checked: []}};
      return {draft: {...draft, error: ''}, answers: nextAnswers, complete: true};
    }
    const option = question.options?.[draft.selected];
    const answer = option ? {type: 'option' as const, optionId: option.id} : draft.text.trim() ? {type: 'text' as const, text: draft.text} : undefined;
    if (!answer) return {...current, draft: {...draft, error: 'Enter an answer.'}};
    const nextAnswers = {...answers, [question.id]: answer};
    if (draft.questionIndex + 1 < request.questions.length) return {answers: nextAnswers,
      draft: {questionIndex: draft.questionIndex + 1, selected: 0, text: '', error: ''}};
    return {draft: {...draft, error: ''}, answers: nextAnswers, complete: true};
  },
};
const base = createToolUI();
export const UI: ToolUI = {...base, interaction, title(call) {
  try {
    const args: unknown = JSON.parse(call.arguments);
    const questions = args && typeof args === 'object' ? (args as Record<string, unknown>).questions : undefined;
    const header = Array.isArray(questions) && questions[0] && typeof questions[0] === 'object'
      ? (questions[0] as Record<string, unknown>).header : undefined;
    if (typeof header === 'string' && header.trim()) return 'AskUserQuestion · ' + header.trim();
  } catch {}
  return base.title(call);
}};
