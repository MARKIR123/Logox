import type {ToolInteractionAdapter, ToolUI} from './ui-types.js';
import {canonicalToolName} from './types.js';
import {defaultToolRegistry} from './registry.js';
import {createToolUI, messageToolCall} from '../tui/timeline/tool-ui.js';
import type {Interaction, Message} from '../runtime/contracts.js';
import {UI as Read} from './ReadTool/UI.js';
import {UI as Write} from './WriteTool/UI.js';
import {UI as Edit} from './EditTool/UI.js';
import {UI as Glob} from './GlobTool/UI.js';
import {UI as Grep} from './GrepTool/UI.js';
import {UI as Shell} from './ShellTool/UI.js';
import {UI as AskUserQuestion} from './AskUserQuestionTool/UI.js';
import {UI as WebFetch} from './WebFetchTool/UI.js';
import {UI as Actor} from './orchestration/ActorTool/UI.js';
import {UI as CraftActor} from './orchestration/CraftActorTool/UI.js';
import {UI as ReadActor} from './orchestration/ReadActorTool/UI.js';
import {UI as BorrowSkill} from './coordination/BorrowSkillTool/UI.js';
import {UI as ListActors} from './coordination/ListActorsTool/UI.js';
import {UI as CancelActor} from './orchestration/CancelActorTool/UI.js';
import {UI as UpdateTaskProgress} from './orchestration/UpdateTaskProgressTool/UI.js';
import {UI as SendMessage} from './coordination/SendMessageTool/UI.js';
import {UI as FinishRound} from './protocol/_FinishRoundTool/UI.js';
import {UI as LoadTools} from './protocol/LoadToolsTool/UI.js';
import {UI as GitStatus} from './protocol/_GitStatusTool/UI.js';
import {UI as Automa} from './orchestration/AutomaTool/UI.js';
import {UI as Mcp} from '../extensions/UI.js';

export const toolUIs: Readonly<Record<string, ToolUI>> = {
  Read, Write, Edit, Glob, Grep, Shell, AskUserQuestion, WebFetch, Actor, CraftActor, ReadActor,
  BorrowSkill, ListActors, CancelActor, UpdateTaskProgress, SendMessage, Automa,
  _FinishRound: FinishRound, _GitStatus: GitStatus, LoadTools, mcp: Mcp,
};
const lowercase = new Map(Object.entries(toolUIs).map(([name, ui]) => [name.toLowerCase(), ui]));
const fallback = createToolUI();
export function getToolUI(name: string): ToolUI {
  return toolUIs[canonicalToolName(name) ?? name] ?? lowercase.get(name.toLowerCase()) ?? fallback;
}
export function getInteractionUI(request: Interaction): ToolInteractionAdapter | undefined {
  return request.kind === 'question' ? AskUserQuestion.interaction : undefined;
}
export function isVisibleToolMessage(message: Message): boolean {
  const call = messageToolCall(message);
  if (!call) return true;
  if ((message.step?.terminalVisibility ?? defaultToolRegistry.getTerminalVisibility(call.name)) === 'silent') return false;
  return getToolUI(call.name).visibility !== 'hidden';
}
