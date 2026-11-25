/**
 * The conversation Anamnesis reads: what the human said and what the ensemble answered, across every owner that has a journal, in time order.
 * Reminders, runtime notes, assignments and other injected entries are not conversation and are left out. Pure functions over loaded entries.
 */
import {stripNarration} from '../runtime/narration.js';
import {inputKind} from '../runtime/provenance.js';
import type {HistoryEntry} from '../store/journal.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {parseSynopsis} from '../context/synopsis.js';

export const MESSAGE_CAP = 2000;
export const ARGUMENT_CAP = 120;
export const ERROR_CAP = 200;
export const DREAM_TRANSCRIPT_CAP = 60_000;
export const RECAP_TRANSCRIPT_CAP = 16_000;
export const OMITTED_MARKER = '[earlier part of the session omitted]';
export interface OwnerEntries {readonly ownerId: string; readonly entries: readonly HistoryEntry[]}
/** How many journal entries of each owner a run has covered. */
export type Marks = Readonly<Record<string, number>>;
interface Line {readonly time: number; readonly order: number; readonly index: number; readonly text: string}

const clip = (text: string, max: number, marker = ' […]') => text.length > max ? text.slice(0, max) + marker : text;
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/** One line for a tool call's arguments: the argument people read first (path, command, pattern...) or the compact JSON. */
export function argumentSummary(raw: string): string {
  let text = raw;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const key = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'description', 'title'].find(name => typeof record[name] === 'string' && (record[name] as string).trim());
      text = key ? String(record[key]) : JSON.stringify(value);
    }
  } catch {}
  return clip(flat(text), ARGUMENT_CAP, '…');
}

/** True when the entry is something a person said or the ensemble answered, as opposed to a tool step or an injected note. */
export function isConversation(entry: HistoryEntry): boolean {
  if (entry.role === 'user') return inputKind(entry) === 'human' && !!entry.text.trim();
  if (entry.role !== 'assistant') return false;
  const message = entry.message;
  if (message?.role === 'assistant' && (message.textToolCall || message.contextExcluded)) return false;
  return !!stripNarration(entry.text).trim();
}

function entryLines(owner: string, entry: HistoryEntry): string[] {
  const lines: string[] = [];
  if (entry.role === 'user') {
    if (inputKind(entry) === 'human' && entry.text.trim()) lines.push('[' + owner + ' · user] ' + clip(entry.text.trim(), MESSAGE_CAP));
  } else if (entry.role === 'assistant') {
    const message = entry.message?.role === 'assistant' ? entry.message : undefined;
    if (isConversation(entry)) lines.push('[' + owner + ' · assistant] ' + clip(stripNarration(parseSynopsis(entry.text).answer).trim(), MESSAGE_CAP));
    for (const call of message?.toolCalls ?? []) {
      if (isFinishRound(call.name)) continue;
      const summary = argumentSummary(call.arguments);
      lines.push('[' + owner + ' · tool] ' + call.name + (summary ? ' ' + summary : ''));
    }
  } else if (entry.role === 'tool') {
    const message = entry.message?.role === 'tool' ? entry.message : undefined;
    if (message?.isError && !message.unexecuted && !isFinishRound(message.name)) lines.push('[' + owner + ' · tool error] ' + clip(flat(entry.text), ERROR_CAP, '…'));
  }
  return lines;
}

/**
 * Entries of every owner beyond its mark, merged by time (an entry without a time takes the previous one's of its owner; ties keep owner then ledger order).
 * Keeps the newest part within `cap` characters; a first line says when something was cut. Empty when nothing is left to read.
 */
export function buildTranscript(owners: readonly OwnerEntries[], from: Marks, cap: number): string {
  const lines: Line[] = [];
  owners.forEach((owner, order) => {
    let time = 0;
    owner.entries.slice(Math.min(from[owner.ownerId] ?? 0, owner.entries.length)).forEach((entry, index) => {
      time = entry.time ?? time;
      for (const text of entryLines(owner.ownerId, entry)) lines.push({time, order, index, text});
    });
  });
  lines.sort((a, b) => a.time - b.time || a.order - b.order || a.index - b.index);
  const kept: string[] = [];
  let used = 0, cut = false;
  for (let at = lines.length - 1; at >= 0; at--) {
    const cost = lines[at]!.text.length + 1;
    if (used + cost > cap) {cut = true; break;}
    kept.push(lines[at]!.text); used += cost;
  }
  if (!kept.length) return '';
  return (cut ? OMITTED_MARKER + '\n' : '') + kept.reverse().join('\n');
}

/** True when any owner has a human message or an assistant text beyond its mark. */
export function hasNewMaterial(owners: readonly OwnerEntries[], from: Marks): boolean {
  return owners.some(owner => owner.entries.slice(Math.min(from[owner.ownerId] ?? 0, owner.entries.length)).some(isConversation));
}

/** The marks that cover everything loaded. */
export function marksOf(owners: readonly OwnerEntries[]): Record<string, number> {
  return Object.fromEntries(owners.map(owner => [owner.ownerId, owner.entries.length]));
}
