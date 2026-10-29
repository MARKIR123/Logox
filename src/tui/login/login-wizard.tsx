import {useRef} from 'react';
import {Box, type DOMElement} from 'ink';
import {useContentHeight} from '../terminal/metrics.js';
import {QuestionPanel, type QuestionSelection, type PanelQuestion} from '../interactions/question-panel.js';
import type {LoginFlow, LoginState, WizardDraft} from '../../providers/login.js';
import {readQuestionClipboard} from '../terminal/clipboard.js';

/** The accepted interactive panel, not the runtime tool-answer reducer. */
export function LoginWizardPanel({flow, state, width, height, y}: {
  flow: LoginFlow; state: LoginState; width: number; height: number; y: number;
}) {
  const wizard = state.wizard!;
  const question = wizard.questions[wizard.index]!;
  const options = question.options ?? [];
  const fromPanel = (answer: QuestionSelection): WizardDraft => ({
    selected: answer.selected.map(label => options.find(option => option.label === label)?.id ?? label),
    ...(answer.custom !== undefined ? {custom: answer.custom} : {}),
  });
  const toPanel = (answer: WizardDraft): QuestionSelection => ({
    selected: answer.selected.map(id => options.find(option => option.id === id)?.label ?? id),
    ...(answer.custom !== undefined ? {custom: answer.custom} : {}),
  });
  const initialDraft = flow.wizardDraft();
  const panel: PanelQuestion = {question: question.question, header: question.title, inputLabel: 'Input',
    ...(question.detail !== undefined ? {detail: question.detail} : {}),
    ...(question.options ? {options: question.options.map(({label, description}) => ({label, description}))} : {}),
    ...(question.secret !== undefined ? {secret: question.secret} : {}),
    ...(question.multiSelect !== undefined ? {multiSelect: question.multiSelect} : {}),
    ...(question.hideCustomInput !== undefined ? {hideCustomInput: question.hideCustomInput} : {}),
    ...(question.allowEmpty !== undefined ? {allowEmpty: question.allowEmpty} : {}),
    ...(question.defaultSelected ? {defaultSelected: question.defaultSelected.map(id => options.find(option => option.id === id)?.label ?? id)} : {}),
  };
  const panelRef = useRef<DOMElement>(null), panelHeight = useContentHeight(panelRef);
  return <Box width={width} height={height} flexDirection="column" justifyContent="flex-end" overflow="hidden">
    <Box ref={panelRef} flexDirection="column" flexShrink={0}><QuestionPanel key={`${wizard.key}:${wizard.index}`} question={panel} position={wizard.index + 1}
    total={wizard.questions.length} answered={wizard.answered} width={width} height={height} y={y + Math.max(0, height - panelHeight)}
    collapsed={Boolean(state.collapsed)} onToggleFold={flow.toggleWizardFold}
    {...(initialDraft ? {initialDraft: toPanel(initialDraft)} : {})}
    onDraftChange={answer => flow.keepWizardDraft(fromPanel(answer))}
    onAnswer={answer => flow.answerWizard(fromPanel(answer))} onCancel={() => flow.cancel()}
    onBack={wizard.index > 0 ? answer => flow.navigateWizard(-1, fromPanel(answer)) : undefined}
    onForward={wizard.index + 1 < wizard.questions.length ? answer => flow.navigateWizard(1, fromPanel(answer)) : undefined}
    readClipboard={readQuestionClipboard}/></Box></Box>;
}
