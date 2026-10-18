import {z} from 'zod';
import type {ImageBlock, ToolDefinition} from '../runtime/messages.js';

export const pathArg = z.string().min(1);

export interface ToolResult {
  text: string;
  isError: boolean;
  disposition?: 'denied' | 'error' | undefined;
  images?: ImageBlock[] | undefined;
}

export const toolAliases = {
  read: 'Read',
  Read: 'Read',
  write: 'Write',
  Write: 'Write',
  edit: 'Edit',
  Edit: 'Edit',
  glob: 'Glob',
  Glob: 'Glob',
  grep: 'Grep',
  Grep: 'Grep',
  shell: 'Shell',
  Shell: 'Shell',
  bash: 'Shell',
  Bash: 'Shell',
  ask_user: 'AskUserQuestion',
  askuserquestion: 'AskUserQuestion',
  AskUserQuestion: 'AskUserQuestion',
  web_fetch: 'WebFetch',
  webfetch: 'WebFetch',
  WebFetch: 'WebFetch',
  actor: 'Actor',
  Actor: 'Actor',
  dispatch_role: 'Actor',
  dispatchrole: 'Actor',
  DispatchRole: 'Actor',
  craft_actor: 'CraftActor',
  craftactor: 'CraftActor',
  CraftActor: 'CraftActor',
  read_actor: 'ReadActor',
  readactor: 'ReadActor',
  ReadActor: 'ReadActor',
  borrow_skill: 'BorrowSkill',
  borrowskill: 'BorrowSkill',
  BorrowSkill: 'BorrowSkill',
} as const;

export type CanonicalToolName = (typeof toolAliases)[keyof typeof toolAliases];

export function canonicalToolName(name: string): CanonicalToolName | undefined {
  return toolAliases[name as keyof typeof toolAliases] ?? toolAliases[name.toLowerCase() as keyof typeof toolAliases];
}

export type {ToolDefinition};
