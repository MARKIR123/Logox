import {promisify} from 'node:util';
import {execFile as execFileCb} from 'node:child_process';
import type {Journal, HistoryEntry} from '../store/journal.js';
import type {MemoryStore} from './memory.js';
import type {ModelMessage, Provider} from '../runtime/messages.js';

const execFile = promisify(execFileCb);

export interface RecapSummary {
  oneLineSummary: string;
  whatWasDone: string;
  workingTreeState: string;
  recommendedNextStep: string;
  fullMarkdown: string;
}

export async function getGitStatus(cwd: string): Promise<string> {
  try {
    const {stdout: branch} = await execFile('git', ['branch', '--show-current'], {cwd, timeout: 5000}).catch(() => ({stdout: ''}));
    const {stdout: status} = await execFile('git', ['status', '--porcelain'], {cwd, timeout: 5000}).catch(() => ({stdout: ''}));

    const branchName = branch.trim() || 'detached';
    const lines = status.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return `Branch ${branchName} (clean working tree)`;
    }
    return `Branch ${branchName} (${lines.length} uncommitted changes):\n${lines.slice(0, 10).map(l => '  ' + l).join('\n')}${lines.length > 10 ? `\n  ... and ${lines.length - 10} more` : ''}`;
  } catch {
    return 'Git status unavailable';
  }
}

export const RECAP_SYSTEM_PROMPT = `You are Anamnesis, the autonomous context guardian in LOGOX.
Your task is to summarize the working context for a human developer who just returned to their terminal.
Produce a concise, high-density summary strictly following this 3-part Markdown structure:

### What Was Done
(1-3 bullet points on the latest accomplished tasks and conclusions)

### Working Tree State
(Brief overview of uncommitted modifications or clean state)

### Recommended Next Step
(1-2 clear, actionable recommendations on what to do next)

Keep tone objective, purely technical, and strictly in English.`;

export async function executeRecap(
  options: {
    cwd: string;
    sessionId: string;
    journal: Journal;
    provider?: {
      respond(
        params: {system: string; messages: readonly ModelMessage[]},
        onDelta?: (chunk: any) => void,
        signal?: AbortSignal
      ): Promise<{message: Extract<ModelMessage, {role: 'assistant'}>}>;
    };
  },
  signal: AbortSignal = new AbortController().signal
): Promise<RecapSummary> {
  const gitStatus = await getGitStatus(options.cwd);

  // Gather recent entries from the journal
  const defaultOwners = ['logox', 'techne', 'kalon', 'aletheia'];
  const entries: HistoryEntry[] = [];
  try {
    const tasks = await options.journal.activeTasks?.(options.sessionId) ?? [];
    const allOwners = new Set([...defaultOwners, ...tasks.map(t => t.ownerId)]);
    for (const owner of allOwners) {
      const records = await options.journal.load(options.sessionId, owner);
      entries.push(...records);
    }
  } catch {}

  const recentLines = entries.slice(-15).map(e => `[${e.role.toUpperCase()}]: ${e.text.slice(0, 300)}`).join('\n\n');

  let fullMarkdown = '';

  if (options.provider) {
    const prompt = `Current Working Tree:\n${gitStatus}\n\nRecent Activity History:\n${recentLines || 'No recent transcript entries.'}\n\nPlease generate the 3-part Recap.`;
    const response = await options.provider.respond({
      system: RECAP_SYSTEM_PROMPT,
      messages: [{role: 'user', text: prompt}],
    }, undefined, signal);
    fullMarkdown = response.message.text.trim();
  } else {
    // Fast fallback if provider not supplied
    fullMarkdown = `### What Was Done\nCompleted recent session tasks.\n\n### Working Tree State\n${gitStatus}\n\n### Recommended Next Step\nContinue with next objective.`;
  }

  // Parse 3 parts from markdown
  const doneMatch = /### What Was Done\r?\n([\s\S]*?)(?=### Working Tree State|$)/i.exec(fullMarkdown);
  const treeMatch = /### Working Tree State\r?\n([\s\S]*?)(?=### Recommended Next Step|$)/i.exec(fullMarkdown);
  const nextMatch = /### Recommended Next Step\r?\n([\s\S]*?)$/i.exec(fullMarkdown);

  const whatWasDone = doneMatch?.[1]?.trim() ?? 'Recent tasks completed.';
  const workingTreeState = treeMatch?.[1]?.trim() ?? gitStatus;
  const recommendedNextStep = nextMatch?.[1]?.trim() ?? 'Ready for user input.';

  const firstBullet = whatWasDone.split('\n')[0]?.replace(/^[-*•\d.]\s*/, '').trim() ?? 'Recent work';
  const oneLineSummary = `${firstBullet.slice(0, 50)} · ${workingTreeState.split('\n')[0]?.slice(0, 30)}`;

  return {
    oneLineSummary,
    whatWasDone,
    workingTreeState,
    recommendedNextStep,
    fullMarkdown,
  };
}

export const DREAM_SYSTEM_PROMPT = `You are Anamnesis, the autonomous memory consolidation unit in LOGOX.
Your task is to analyze recent session transcripts and extract high-confidence, persistent facts.
Categories to extract:
- 'user': Explicit user preferences, roles, or communication habits.
- 'feedback': Technical corrections, negative rules, or confirmed approaches.
- 'project': Architecture facts, goals, constraints not derivable from code alone.
- 'reference': Important URLs, issue tickets, or dashboard links.

Rules:
1. ONLY extract high-confidence, lasting facts. Do NOT record ephemeral code edits or temporary calculations.
2. Return strictly a JSON array of objects with fields:
   [
     {
       "name": "short-kebab-slug",
       "description": "one-line description",
       "type": "user" | "feedback" | "project" | "reference",
       "content": "detailed fact explanation"
     }
   ]
3. If there are no high-confidence lasting facts, return: []`;

export async function executeAutoDream(
  options: {
    cwd: string;
    sessionId: string;
    journal: Journal;
    memoryStore: MemoryStore;
    provider?: {
      respond(
        params: {system: string; messages: readonly ModelMessage[]},
        onDelta?: (chunk: any) => void,
        signal?: AbortSignal
      ): Promise<{message: Extract<ModelMessage, {role: 'assistant'}>}>;
    };
  },
  signal: AbortSignal = new AbortController().signal
): Promise<{consolidated: number; records: string[]}> {
  if (!options.provider) {
    return {consolidated: 0, records: []};
  }

  // Gather recent entries
  const defaultOwners = ['logox', 'techne', 'kalon', 'aletheia'];
  const entries: HistoryEntry[] = [];
  try {
    const tasks = await options.journal.activeTasks?.(options.sessionId) ?? [];
    const allOwners = new Set([...defaultOwners, ...tasks.map(t => t.ownerId)]);
    for (const owner of allOwners) {
      const records = await options.journal.load(options.sessionId, owner);
      entries.push(...records);
    }
  } catch {}

  const transcript = entries.slice(-30).map(e => `[${e.role.toUpperCase()}]: ${e.text}`).join('\n\n');
  if (!transcript.trim()) {
    return {consolidated: 0, records: []};
  }

  const response = await options.provider.respond({
    system: DREAM_SYSTEM_PROMPT,
    messages: [{role: 'user', text: `Please analyze this transcript and extract persistent memory facts:\n\n${transcript}`}],
  }, undefined, signal);

  let rawJson = response.message.text.trim();
  // Strip markdown code fences if present
  if (rawJson.startsWith('```')) {
    rawJson = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }

  let items: any[] = [];
  try {
    items = JSON.parse(rawJson);
    if (!Array.isArray(items)) items = [];
  } catch {
    return {consolidated: 0, records: []};
  }

  const recordedNames: string[] = [];
  for (const item of items) {
    signal.throwIfAborted();
    if (!item.name || !item.description || !item.content) continue;
    const type = ['user', 'feedback', 'project', 'reference'].includes(item.type) ? item.type : 'project';
    const scope = type === 'user' ? 'user' : 'project';
    await options.memoryStore.save({
      name: String(item.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64),
      description: String(item.description).slice(0, 200),
      type,
      content: String(item.content),
    }, scope);
    recordedNames.push(item.name);
  }

  return {
    consolidated: recordedNames.length,
    records: recordedNames,
  };
}
