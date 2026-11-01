import type {Message} from '../../runtime/contracts.js';
import {extractNarration, stripNarration} from '../../runtime/narration.js';
import {classifyShellCommand, shellExecutable} from '../../tools/ShellTool/classify.js';
import {shellWords} from '../../permissions/shell.js';
import {messageToolCall} from './tool-ui.js';

export type ToolGroupCategory = 'search' | 'read' | 'list' | 'browse' | 'command';
export interface ToolGroup {
  readonly type: 'group';
  readonly id: string;
  readonly messages: readonly Message[];
  readonly counts: Readonly<Partial<Record<ToolGroupCategory, number>>>;
  readonly targets: readonly string[];
  readonly elapsedMs: number;
  readonly running: boolean;
  readonly active?: {readonly label: string; readonly elapsedMs: number};
  readonly stage?: string;
}
export type TimelineItem = {readonly type: 'message'; readonly message: Message} | ToolGroup;

const categoryOrder: readonly ToolGroupCategory[] = ['search', 'read', 'list', 'browse', 'command'];

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

const isPlaywright = (server: string | undefined) => server !== undefined && /playwright/i.test(server);

/** Name of a browser MCP call: any Playwright-server tool or any `browser_*` tool, via the generic `mcp` tool or a direct `mcp__server__tool` name. */
function browseTool(name: string, args: Record<string, unknown>): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'mcp') {
    const tool = text(args.tool);
    if (tool) return /^browser_/i.test(tool) || isPlaywright(text(args.server)) ? tool : undefined;
    return isPlaywright(text(args.server)) ? text(args.action) ?? 'list' : undefined; // e.g. listing the Playwright tools
  }
  if (lower.startsWith('mcp__') && (isPlaywright(lower.split('__')[1]) || lower.includes('__browser_'))) return lower;
  return undefined;
}

export function categorizeToolMessage(message: Message): ToolGroupCategory | undefined {
  if (message.kind !== 'tool') return undefined;
  const call = messageToolCall(message);
  if (!call) return undefined;
  const args = parseArgs(call.arguments);
  switch (call.name.toLowerCase()) {
    case 'read': return 'read';
    case 'grep':
    case 'glob': return 'search';
    case 'shell': {
      const command = text(args.command);
      return command === undefined ? 'command' : classifyShellCommand(command);
    }
    default: return browseTool(call.name, args) ? 'browse' : undefined;
  }
}

function leaf(value: string): string {
  const name = value.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? value;
  return name.length > 40 ? name.slice(0, 37) + '...' : name;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function shellComment(command: string): string | undefined {
  const match = /^\s*#\s*(.+)/.exec(command);
  return match?.[1]?.trim() || undefined;
}

function shellTarget(command: string, category: ToolGroupCategory): string | undefined {
  const stripped = command.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).join('\n');
  const first = shellWords(stripped.split(/&&|\|\||[;|\n]/)[0] ?? '').words;
  if (!first.length) return undefined;
  if (category === 'command') return shellExecutable(first[0]!) || undefined;
  const last = [...first.slice(1)].reverse().find(word => !word.startsWith('-') && !word.startsWith('$'));
  return last ? leaf(last) : undefined;
}

function callTarget(message: Message, category: ToolGroupCategory): string | undefined {
  const call = messageToolCall(message);
  if (!call) return undefined;
  const args = parseArgs(call.arguments);
  switch (category) {
    case 'browse': {
      const url = text(args.url);
      if (url) return hostOf(url);
      const tool = browseTool(call.name, args);
      return tool ? tool.replace(/^.*browser_/, '').replace(/^mcp__/, '') : undefined;
    }
    case 'command': return undefined; // command names only count in `ran N`, never as targets
    default: {
      if (call.name.toLowerCase() === 'shell') return text(args.command) ? shellTarget(String(args.command), category) : undefined;
      const file = text(args.file_path) ?? text(args.path);
      if (call.name.toLowerCase() === 'read' && file) return leaf(file);
      return text(args.pattern) ?? (file ? leaf(file) : undefined);
    }
  }
}

function activeLabel(message: Message): string | undefined {
  const call = messageToolCall(message);
  if (!call) return undefined;
  const args = parseArgs(call.arguments);
  const name = call.name.toLowerCase();
  const clip = (value: string) => value.length > 80 ? value.slice(0, 77) + '...' : value;
  if (name === 'shell') {
    const command = text(args.command);
    if (!command) return 'Shell';
    const comment = shellComment(command);
    if (comment) return clip(comment);
    return clip('$ ' + (command.split(/\r?\n/).find(line => line.trim() && !line.trim().startsWith('#'))?.trim() ?? command.trim()));
  }
  if (name === 'read') return 'Read ' + leaf(text(args.file_path) ?? text(args.path) ?? '');
  if (name === 'grep' || name === 'glob') return `${name === 'grep' ? 'Grep' : 'Glob'} ${clip(text(args.pattern) ?? '')}`.trim();
  const tool = browseTool(call.name, args);
  return tool ? 'Browse ' + clip(text(args.url) ? hostOf(String(args.url)) : tool.replace(/^.*browser_/, '')) : undefined;
}

function isFailed(message: Message): boolean {
  return Boolean(message.step?.disposition) || message.step?.state === 'failed' || message.step?.state === 'cancelled';
}

/** Invisible or empty entries that never break a run: thinking, silent tools, empty assistant text. */
function isNeutral(message: Message): boolean {
  if (message.kind === 'thinking') return true;
  if (message.kind === 'tool') return message.step?.terminalVisibility === 'silent';
  return message.role === 'assistant' && !message.kind && !stripNarration(message.text).trim();
}

function buildGroup(messages: readonly Message[], stage: string | undefined, now: number): ToolGroup {
  const counts: Partial<Record<ToolGroupCategory, number>> = {};
  const targets: string[] = [];
  let elapsedMs = 0, running = false;
  let active: ToolGroup['active'];
  for (const message of messages) {
    const category = categorizeToolMessage(message);
    if (!category || message.kind !== 'tool') continue;
    counts[category] = (counts[category] ?? 0) + 1;
    const target = callTarget(message, category);
    if (target && !targets.includes(target)) targets.push(target);
    elapsedMs += message.step?.elapsedMs ?? 0;
    if (message.step?.state === 'running') {
      running = true;
      const label = activeLabel(message);
      if (label) {
        const since = message.step.runningSince;
        active = {label, elapsedMs: since ? Math.max(message.step.elapsedMs, now - since) : message.step.elapsedMs};
      }
    }
  }
  return {type: 'group', id: messages[0]!.id + '-group', messages, counts, targets, elapsedMs, running,
    ...(active ? {active} : {}), ...(stage ? {stage} : {})};
}

export function groupToolMessages(messages: readonly Message[], options: {stages?: boolean} = {}): TimelineItem[] {
  const items: TimelineItem[] = [];
  const now = Date.now();
  let calls: Message[] = [];   // collapsible calls plus absorbed neutral messages, in order
  let callCount = 0;
  let pending: Message[] = []; // neutral messages after the last call, not yet known to be inside the group
  let stage: string | undefined;

  const flush = () => {
    if (callCount >= 2) items.push(buildGroup(calls, stage, now));
    else for (const message of calls) items.push({type: 'message', message});
    if (callCount > 0) stage = undefined;
    for (const message of pending) items.push({type: 'message', message});
    calls = [];
    callCount = 0;
    pending = [];
  };
  const emit = (message: Message) => items.push({type: 'message', message});

  for (const message of messages) {
    if ((message.role as string) === 'context') continue;
    const narration = options.stages && message.role === 'assistant' && !message.kind ? extractNarration(message.text)?.narration : undefined;
    if (!narration && isNeutral(message)) {
      if (callCount > 0) pending.push(message); else emit(message);
      continue;
    }
    if (message.kind === 'tool') {
      const category = categorizeToolMessage(message);
      if (category && !isFailed(message)) {
        calls.push(...pending, message);
        pending = [];
        callCount++;
        continue;
      }
      flush();
      emit(message);
      if (!category) stage = undefined;
      continue;
    }
    flush();
    emit(message);
    stage = narration;
  }
  flush();
  return items;
}

export function summarizeGroup(group: ToolGroup): string {
  const parts: string[] = [];
  for (const category of categoryOrder) {
    const n = group.counts[category];
    if (!n) continue;
    switch (category) {
      case 'search': parts.push(`searched ${n}`); break;
      case 'read': parts.push(`read ${n} ${n === 1 ? 'file' : 'files'}`); break;
      case 'list': parts.push(`listed ${n}`); break;
      case 'browse': parts.push(`browsed ${n}`); break;
      case 'command': parts.push(`ran ${n}`); break;
    }
  }
  return parts.join(' · ');
}
