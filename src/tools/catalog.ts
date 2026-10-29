import {z} from 'zod';
import {schemas, descriptions} from './index.js';
import {sendMessageTool} from './coordination/SendMessageTool/SendMessageTool.js';
import type {ToolDefinition} from '../runtime/messages.js';
import type {ToolMetadataInput, ToolMetadata} from './metadata.js';
import {metadata as meta0} from './ReadTool/ReadTool.js';
import {metadata as meta1} from './WriteTool/WriteTool.js';
import {metadata as meta2} from './EditTool/EditTool.js';
import {metadata as meta3} from './GlobTool/GlobTool.js';
import {metadata as meta4} from './GrepTool/GrepTool.js';
import {metadata as meta5} from './ShellTool/ShellTool.js';
import {metadata as meta6} from './AskUserQuestionTool/AskUserQuestionTool.js';
import {metadata as meta7} from './WebFetchTool/WebFetchTool.js';
import {metadata as meta8} from './protocol/_FinishRoundTool/_FinishRoundTool.js';
import {metadata as meta9} from './protocol/_GitStatusTool/_GitStatusTool.js';
import {metadata as meta10} from './coordination/SendMessageTool/SendMessageTool.js';
import {metadata as meta11} from './coordination/ListActorsTool/ListActorsTool.js';
import {metadata as meta12} from './coordination/BorrowSkillTool/BorrowSkillTool.js';
import {metadata as meta13} from './orchestration/ActorTool/ActorTool.js';
import {metadata as meta14} from './orchestration/CraftActorTool/CraftActorTool.js';
import {metadata as meta15} from './orchestration/ReadActorTool/ReadActorTool.js';
import {metadata as meta16} from './orchestration/CancelActorTool/CancelActorTool.js';
import {metadata as meta17} from './orchestration/UpdateTaskProgressTool/UpdateTaskProgressTool.js';
import {metadata as loadToolsMetadata} from './protocol/LoadToolsTool/LoadToolsTool.js';
import {metadata as meta18} from './orchestration/AutomaTool/AutomaTool.js';

export interface ToolRegistration {metadata: ToolMetadataInput; definition: ToolDefinition}
export interface ResolvedTool {metadata: ToolMetadata; definition: ToolDefinition}

export function builtinToolRegistrations(): readonly ToolRegistration[] {
  return [meta0, meta1, meta2, meta3, meta4, meta5, meta6, meta7, meta8, meta9, meta10, meta11, meta12, meta13, meta14, meta15, meta16, meta17, meta18, loadToolsMetadata].map(metadata => ({metadata, definition: metadata.name === 'SendMessage' ? sendMessageTool : {
    name: metadata.name,
    description: descriptions[metadata.name as keyof typeof descriptions],
    parameters: z.toJSONSchema(schemas[metadata.name as keyof typeof schemas], {io: 'input'}),
  }}));
}
