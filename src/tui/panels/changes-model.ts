/**
 * What the Changes tab shows: the files this session's completed Edit and Write calls changed, derived from the runtime store's tool messages (no file is read; a
 * Write's previous text comes from `src/tools/WriteTool/record.ts` while this process remembers it). Pure: the same messages give the same list.
 */
import {structuredPatch} from 'diff';
import type {Message} from '../../runtime/contracts.js';
import {lookupWrite} from '../../tools/WriteTool/record.js';
import {callArgs} from '../../tools/ui-format.js';
import {messageToolCall} from '../timeline/tool-ui.js';

export interface FileEdit {
  readonly messageId: string;
  readonly ownerId: string;
  readonly kind: 'edit' | 'write';
  readonly added: number;
  readonly removed: number;
  /** A Write of a file this process did not see before (every line counts as added; an unknown previous text makes the counts approximate). */
  readonly created: boolean;
  readonly approximate: boolean;
  /** The unified diff lines of this call (`+`, `-`, space and `@@` lines), or the head of a new file as `+` lines. */
  readonly patch: readonly string[];
  readonly time: number;
}
export interface FileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly edits: readonly FileEdit[];
  readonly owners: readonly string[];
  /** The time of the newest edit (0 when unknown). */
  readonly time: number;
}
const PATCH_LINES = 400;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function patchOf(path: string, before: string, after: string): {added: number; removed: number; patch: string[]} {
  const hunks = structuredPatch(path || 'file', path || 'file', before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n'), '', '', {context: 3}).hunks;
  let added = 0, removed = 0;
  const patch: string[] = [];
  for (const hunk of hunks) {
    patch.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++; else if (line.startsWith('-')) removed++;
      if (patch.length < PATCH_LINES) patch.push(line);
    }
  }
  return {added, removed, patch};
}
const memo = new WeakMap<Message, {path: string; edit: FileEdit} | null>();
/** The edit one message made (memoised per message object: a store revision re-reads every message, but only new ones are diffed). */
function editOf(message: Message): {path: string; edit: FileEdit} | undefined {
  let known = memo.get(message);
  if (known === undefined) {known = computeEdit(message) ?? null; memo.set(message, known);}
  return known ?? undefined;
}
function computeEdit(message: Message): {path: string; edit: FileEdit} | undefined {
  if (message.kind !== 'tool' || message.step?.state !== 'completed' || message.step.disposition) return undefined;
  const call = messageToolCall(message), name = call?.name.toLowerCase();
  if (!call || name !== 'edit' && name !== 'write') return undefined;
  const args = callArgs(call), path = text(args.file_path) || text(args.path);
  if (!path) return undefined;
  const base = {messageId: message.id, ownerId: message.ownerId, time: message.time ?? 0};
  if (name === 'edit') {
    const result = patchOf(path, text(args.old_string) || text(args.old_text), text(args.new_string) || text(args.new_text));
    return {path, edit: {...base, kind: 'edit', ...result, created: false, approximate: false}};
  }
  const content = text(args.content), record = lookupWrite(path, content);
  if (record?.existed && record.before !== undefined) return {path, edit: {...base, kind: 'write', ...patchOf(path, record.before, content), created: false, approximate: false}};
  const lines = content ? content.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  return {path, edit: {...base, kind: 'write', added: lines.length, removed: 0, created: record?.existed === false, approximate: record === undefined || record.existed,
    patch: lines.slice(0, PATCH_LINES).map(line => '+' + line)}};
}
/** The changed files of `sessionId`, newest edit first. */
export function fileChanges(messages: readonly Message[], sessionId: string): FileChange[] {
  const byPath = new Map<string, FileEdit[]>();
  for (const message of messages) {
    if (message.sessionId !== sessionId) continue;
    const found = editOf(message);
    if (found) byPath.set(found.path, [...byPath.get(found.path) ?? [], found.edit]);
  }
  return [...byPath].map(([path, edits]) => ({path, edits, added: edits.reduce((sum, edit) => sum + edit.added, 0), removed: edits.reduce((sum, edit) => sum + edit.removed, 0),
    owners: [...new Set(edits.map(edit => edit.ownerId))], time: Math.max(...edits.map(edit => edit.time))})).sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
}
/** The detail page of one file as Markdown: one heading and one `diff` fence per call. */
export function changeDetail(change: FileChange, nameOf: (ownerId: string) => string): string {
  const parts = [`${change.edits.length} ${change.edits.length === 1 ? 'edit' : 'edits'} · +${change.added} −${change.removed}`];
  change.edits.forEach((edit, index) => {
    const what = edit.kind === 'edit' ? 'Edit' : edit.created ? 'Write (new file)' : 'Write';
    parts.push(`### ${index + 1}. ${what} by ${nameOf(edit.ownerId)} · +${edit.added} −${edit.removed}${edit.approximate ? ' (approximate)' : ''}`, '```diff\n' + (edit.patch.join('\n') || '(no textual change)') + '\n```');
  });
  return parts.join('\n\n');
}
