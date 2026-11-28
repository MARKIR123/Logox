/**
 * The harvest: instead of a cold request over a transcript, the Director's own last request is forked just before its prompt cache expires. The fork is
 * the request exactly as it was sent (system, tools, thinking and cache fields, history), the reply the model gave, and one appended user message with
 * the review instruction, so the provider reads the warm prefix and only the new suffix is paid for. Tool calls in the answer are never executed.
 * Pure helpers here (request, instruction, answer, change list); the run itself is `runner.ts:AnamnesisRunner.harvest()`.
 */
import type {ModelMessage, ModelRequest, Provider} from '../runtime/messages.js';
import {HARVEST_INSTRUCTIONS} from './prompts.js';
import type {SkillChange} from './skills.js';
import type {MemoryRecord, MemoryScope, MemoryType} from './memory.js';
import {parseDreamAnswer, type DreamResult} from './operations.js';

/** Which answers a harvest asks for. Only the Director writes a recap; skills follow the dream switch like memory. Compaction joins here later. */
export interface HarvestParts {readonly recap: boolean; readonly memory: boolean; readonly skills?: boolean}
/** Everything a harvest needs from the actor's last real request. */
export interface HarvestSource {
  /** The request exactly as it was sent. */
  readonly request: ModelRequest;
  /** What the model answered to it. */
  readonly reply: Extract<ModelMessage, {role: 'assistant'}>;
  /** The provider object that answered it (the same one reads the same cache). */
  readonly provider: Provider;
  /** Model identity as usage records carry it. */
  readonly model: string;
  readonly parts: HarvestParts;
  /** The actor whose request this is (default the Director) and its display name. */
  readonly owner?: string;
  readonly ownerName?: string;
}

export const harvestInstruction = (parts: HarvestParts): string =>
  HARVEST_INSTRUCTIONS[[parts.recap && 'recap', parts.memory && 'memory', parts.skills && 'skills'].filter(Boolean).join('+')] ?? HARVEST_INSTRUCTIONS['memory']!;
/** The appended user message: the static instruction, then what the model cannot see in its history (today, the working tree, the memory records' text). */
export function harvestMessage(parts: HarvestParts, data: {today: string; git: string; records: readonly MemoryRecord[]; recordCap: number; skills?: string}): string {
  const lines = [harvestInstruction(parts), 'Today: ' + data.today];
  if (parts.recap && data.git) lines.push('Working tree:\n' + data.git);
  if (parts.memory) lines.push('Current memory records:\n' + (data.records.length
    ? data.records.map(record => '## ' + record.scope + '/' + record.name + ' (' + record.type + ')\n' + record.description + '\n' + record.content.slice(0, data.recordCap)).join('\n\n') : '(none)'));
  if (parts.skills && data.skills) lines.push(data.skills);
  return lines.join('\n\n');
}
/**
 * The fork: the last request untouched (including its `maxTokens`, because a budget-thinking provider derives the thinking budget from it and a
 * changed budget would change the cache key), then the reply and the instruction. `purpose: 'harvest'` only labels the dump and the fingerprint.
 */
export function harvestRequest(source: HarvestSource, text: string): ModelRequest {
  return {...source.request, messages: [...source.request.messages, source.reply, {role: 'user', text}], stream: false, purpose: 'harvest'};
}

const tagged = (text: string, tag: string): string | undefined => new RegExp('<' + tag + '>([\\s\\S]*?)(?:</' + tag + '>|$)', 'i').exec(text)?.[1]?.trim();
/** The operations list of a `<memory>` block: a JSON array (fenced or not), or the dream's `{"operations": [...]}` object. Undefined when it cannot be read. */
function memoryOperations(raw: string): unknown[] | undefined {
  const unfenced = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  if (!unfenced) return [];
  const start = unfenced.indexOf('['), end = unfenced.lastIndexOf(']'), brace = unfenced.indexOf('{');
  if (start >= 0 && end > start && (brace < 0 || start < brace)) {
    try {
      const value: unknown = JSON.parse(unfenced.slice(start, end + 1));
      return Array.isArray(value) ? value : undefined;
    } catch {return undefined;}
  }
  return parseDreamAnswer(unfenced);
}
export interface HarvestAnswer {readonly recap?: string; readonly memory?: unknown[]; readonly skills?: unknown[]}
/** The blocks the run asked for that could be read; undefined when none could (an answer of only tool calls has no text and lands here). */
export function parseHarvestAnswer(text: string, parts: HarvestParts): HarvestAnswer | undefined {
  const recap = parts.recap ? tagged(text, 'recap') : undefined;
  const raw = parts.memory ? tagged(text, 'memory') : undefined;
  const memory = raw === undefined ? undefined : memoryOperations(raw);
  const rawSkills = parts.skills ? tagged(text, 'skills') : undefined;
  const skills = rawSkills === undefined ? undefined : memoryOperations(rawSkills);
  if (!recap && memory === undefined && skills === undefined) return undefined;
  return {...(recap ? {recap} : {}), ...(memory !== undefined ? {memory} : {}), ...(skills !== undefined ? {skills} : {})};
}

/** One memory change of a harvest, with the text before and after so the person can read what happened. */
export interface MemoryChange {
  readonly kind: 'created' | 'updated' | 'deleted';
  readonly scope: MemoryScope; readonly name: string; readonly type: MemoryType;
  readonly before?: {readonly description: string; readonly content: string};
  readonly after?: {readonly description: string; readonly content: string};
}
const slot = (record: {scope: MemoryScope; name: string}) => record.scope + '/' + record.name;
/** What `applyOperations` changed, from the records before and after it ran; a save that changed nothing is not a change. */
export function memoryChanges(before: readonly MemoryRecord[], after: readonly MemoryRecord[], result: DreamResult): MemoryChange[] {
  const old = new Map(before.map(record => [slot(record), record])), next = new Map(after.map(record => [slot(record), record]));
  const changes: MemoryChange[] = [];
  const text = (record: MemoryRecord) => ({description: record.description, content: record.content});
  for (const saved of result.saved) {
    const was = old.get(slot(saved)), now = next.get(slot(saved));
    if (!now) continue;
    if (!was) changes.push({kind: 'created', scope: now.scope, name: now.name, type: now.type, after: text(now)});
    else if (was.description !== now.description || was.content !== now.content || was.type !== now.type) changes.push({kind: 'updated', scope: now.scope, name: now.name, type: now.type, before: text(was), after: text(now)});
  }
  for (const gone of result.deleted) {
    const was = old.get(slot(gone));
    if (was) changes.push({kind: 'deleted', scope: was.scope, name: was.name, type: was.type, before: text(was)});
  }
  return changes;
}
/** Markdown for the notice's page: created, updated (before then after) and deleted records, in the order the model gave them. */
export function changesPage(changes: readonly MemoryChange[]): string {
  const quote = (text: string) => text.split(/\r?\n/).map(line => '> ' + line).join('\n');
  return changes.map(change => {
    const head = '## ' + change.kind[0]!.toUpperCase() + change.kind.slice(1) + ' · ' + slot(change) + ' (' + change.type + ')';
    if (change.kind === 'created') return head + '\n\n' + change.after!.description + '\n\n' + quote(change.after!.content);
    if (change.kind === 'deleted') return head + '\n\n' + change.before!.description + '\n\n' + quote(change.before!.content);
    return head + '\n\nBefore: ' + change.before!.description + '\n\n' + quote(change.before!.content) + '\n\nAfter: ' + change.after!.description + '\n\n' + quote(change.after!.content);
  }).join('\n\n');
}
/** What a finished harvest reports to the application: when it ended, whether it wrote a recap, and which memory records changed. */
export interface HarvestReport {
  readonly at: number; readonly recap: boolean; readonly changes: readonly MemoryChange[];
  /** The actor that was harvested and its display name. */
  readonly owner: string; readonly ownerName: string;
  readonly skills: readonly SkillChange[];
}
