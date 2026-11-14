// The docked runtime question region above the composer: the clipped, scrollable box around `ProductionQuestionPanel`
// with its mouse host. Answer edits go back through `reduceResponse`; `App` owns the response drafts and focus.
import type {Dispatch, SetStateAction} from 'react';
import {Box} from 'ink';
import type {Interaction} from '../../runtime/contracts.js';
import {MouseHost, type MouseSubscriber} from '../terminal/mouse.js';
import {ProductionQuestionPanel} from './production-question.js';
import {reduceResponse, type ResponseDraft} from './response-draft.js';

export interface QuestionDockProps {
  panel: Extract<Interaction, {kind: 'question'}>;
  response: ResponseDraft;
  height: number;
  detailStart: number;
  width: number;
  /** Row of the panel's top edge on screen. */
  y: number;
  focused: boolean;
  windowColor: string;
  subscribeMouse: MouseSubscriber;
  setFocus: Dispatch<SetStateAction<'input' | 'question' | 'stop'>>;
  changeResponse(update: (current: ResponseDraft) => ResponseDraft): void;
}

export function QuestionDock({panel: questionPanel, response, height: questionHeight, detailStart, width, y, focused, windowColor, subscribeMouse, setFocus, changeResponse}: QuestionDockProps) {
  return <Box height={questionHeight} flexShrink={0} overflow="hidden" contentOffsetY={detailStart} flexDirection="column">
      <MouseHost subscribe={subscribeMouse} color={windowColor}>
        <ProductionQuestionPanel question={(() => {
          const item = questionPanel.questions[response.questionIndex]!;
          return {header: questionPanel.title
            ? (item.header && item.header !== questionPanel.title ? `${questionPanel.title} · ${item.header}` : questionPanel.title)
            : item.header,
            question: item.question,
            ...(item.detail !== undefined ? {detail: item.detail} : {}),
            ...(item.link !== undefined ? {link: item.link} : {}),
            ...(item.options ? {options: item.options.map(option => ({label: option.label, ...(option.description ? {description: option.description} : {})}))} : {}),
            ...(item.multiSelect !== undefined ? {multiSelect: item.multiSelect} : {}),
            ...(item.secret !== undefined ? {secret: item.secret} : {}),
            ...(item.hideCustomInput !== undefined ? {hideCustomInput: item.hideCustomInput} : {})};
        })()}
          position={response.questionIndex + 1} total={questionPanel.questions.length}
          width={width} height={questionHeight} y={y}
          draft={response} cursor={response.editor.cursor} focused={focused}
          onSelect={index => {setFocus('question'); changeResponse(current => reduceResponse(questionPanel, current, {kind: 'select', index}));}}
          onMove={delta => {setFocus('question'); changeResponse(current => reduceResponse(questionPanel, current, {kind: 'move', delta}));}}
          onFocusInput={() => {setFocus('question'); changeResponse(current =>
            reduceResponse(questionPanel, current, {kind: 'select', index: questionPanel.questions[current.questionIndex]?.options?.length ?? 0}));}}/>
      </MouseHost>
    </Box>;
}
