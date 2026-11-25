import {z} from 'zod';
import type {ImageBlock, ToolDefinition} from '../runtime/messages.js';

// Models sometimes append a space or newline to a path; no real file name worth reaching ends in whitespace, so it is trimmed before use.
export const pathArg = z.string().trim().min(1);

export interface ToolResult {
  text: string;
  isError: boolean;
  disposition?: 'denied' | 'error' | undefined;
  discoveredTools?: readonly string[] | undefined;
  images?: ImageBlock[] | undefined;
  /** Workspace files a foreground Shell command changed (`ShellTool/workspace-diff.ts`), workspace-relative with `/`. */
  changedFiles?: readonly string[] | undefined;
}

export const toolAliases = {
  LoadTools: 'LoadTools',
  loadtools: 'LoadTools',
  load_tools: 'LoadTools',
  SendMessage: 'SendMessage',
  sendmessage: 'SendMessage',
  send_message: 'SendMessage',
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
  shell_job: 'ShellJob',
  shelljob: 'ShellJob',
  ShellJob: 'ShellJob',
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
  list_actors: 'ListActors',
  listactors: 'ListActors',
  ListActors: 'ListActors',
  list_agents: 'ListActors',
  listagents: 'ListActors',
  ListAgents: 'ListActors',
  cancel_actor: 'CancelActor',
  cancelactor: 'CancelActor',
  CancelActor: 'CancelActor',
  task_stop: 'CancelActor',
  taskstop: 'CancelActor',
  TaskStop: 'CancelActor',
  plan: 'Plan',
  Plan: 'Plan',
  automa: 'Automa',
  Automa: 'Automa',
  _GitStatus: '_GitStatus',
  _git_status: '_GitStatus',
  _gitstatus: '_GitStatus',
  git_status: '_GitStatus',
  gitstatus: '_GitStatus',
  GitStatus: '_GitStatus',
} as const;

export type CanonicalToolName = (typeof toolAliases)[keyof typeof toolAliases];

export function canonicalToolName(name: string): CanonicalToolName | undefined {
  return toolAliases[name as keyof typeof toolAliases] ?? toolAliases[name.toLowerCase() as keyof typeof toolAliases];
}

export type {ToolDefinition};
