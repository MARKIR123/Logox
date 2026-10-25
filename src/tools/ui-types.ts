import type {ReactNode} from 'react';
import type {Answer, Interaction, Message} from '../runtime/contracts.js';
import type {ToolCall} from '../runtime/messages.js';
import type {ToolResult} from './types.js';
import type {QuestionDraft} from '../tui/cards.js';
import type {createBuilder, insetFrame} from '../tui/scene.js';
import type {ActorActivityContext} from './orchestration/ActorTool/UI.js';

export type ToolFrame = Parameters<typeof insetFrame>[0];
export interface ToolRenderContext {
  builder: ReturnType<typeof createBuilder>;
  message: Message;
  call?: ToolCall;
  result?: ToolResult;
  frame?: ToolFrame;
  open: boolean;
  accent: string;
}
export interface ToolInteractionState {
  request: Interaction;
  draft: QuestionDraft;
  answers: Readonly<Record<string, Answer>>;
}
export interface ToolInteractionContext extends ToolInteractionState {
  builder: ReturnType<typeof createBuilder>;
  frame?: ToolFrame;
  open: boolean;
  accent: string;
}
export type ToolInteractionAction =
  | {kind: 'submit' | 'defer'}
  | {kind: 'select'; index: number}
  | {kind: 'move'; delta: number}
  | {kind: 'text'; text: string};
export interface ToolInteractionTransition {
  draft: QuestionDraft;
  answers: Record<string, Answer>;
  complete?: boolean;
  deferred?: boolean;
}
export interface ToolInteractionAdapter {
  describe(context: ToolInteractionState): {editing: boolean; hint: string};
  render(context: ToolInteractionContext): void;
  renderInline?(context: {request: Interaction; draft: QuestionDraft; focused: boolean}): ReactNode;
  reduce(context: ToolInteractionState, action: ToolInteractionAction): ToolInteractionTransition;
}
export interface ToolUI {
  readonly visibility: 'visible' | 'hidden';
  title(call: ToolCall): string;
  render?(context: ToolRenderContext): void;
  renderActivity?(context: ActorActivityContext): void;
  readonly interaction?: ToolInteractionAdapter;
}
