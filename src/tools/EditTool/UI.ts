import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {structuredPatch} from 'diff';
import type {ToolUI} from '../ui-types.js';
import {messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, type ToolView} from '../../tui/timeline/tool-card.js';
import {diffLines} from '../../tui/timeline/tool-code.js';
import {callArgs, formatToolCardTitle} from '../ui-format.js';

/** The edit as a unified patch with real file line numbers: located on disk when the file still holds the new text, otherwise numbered from the snippet. */
function editPatch(path: string, oldText: string, newText: string): {hunks: ReturnType<typeof structuredPatch>['hunks']; offset: number} {
  const name = path || 'file';
  let patch = structuredPatch(name, name, oldText, newText, '', '', {context: 3});
  let offset = 0;
  const resolved = path ? (existsSync(path) ? path : existsSync(resolve(process.cwd(), path)) ? resolve(process.cwd(), path) : undefined) : undefined;
  if (resolved) {
    try {
      const file = readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');
      const next = newText.replace(/\r\n/g, '\n'), previous = oldText.replace(/\r\n/g, '\n');
      let at = next ? file.indexOf(next) : -1;
      const byNew = at >= 0;
      if (at < 0 && previous) at = file.indexOf(previous);
      if (at >= 0) {
        const before = file.slice(0, at).split('\n');
        const contextBefore = before.slice(Math.max(0, before.length - 4), before.length - 1);
        const after = file.slice(at + (byNew ? next.length : previous.length)).split('\n').slice(1, 4);
        const head = contextBefore.length ? contextBefore.join('\n') + '\n' : '', tail = after.length ? '\n' + after.join('\n') : '';
        const wide = structuredPatch(name, name, head + previous + tail, head + next + tail, '', '', {context: 3});
        if (wide.hunks.length) {patch = wide; offset = Math.max(1, before.length - contextBefore.length) - 1;}
      }
    } catch {}
  }
  return {hunks: patch.hunks, offset};
}

/** Edit card view: numbered diff hunks separated by `⋯`, `+3 −1`. */
export function editView(args: Record<string, unknown>): ToolView {
  const path = String(args.file_path ?? args.path ?? '');
  const oldText = typeof args.old_string === 'string' ? args.old_string : typeof args.old_text === 'string' ? args.old_text : '';
  const newText = typeof args.new_string === 'string' ? args.new_string : typeof args.new_text === 'string' ? args.new_text : '';
  const {hunks, offset} = editPatch(path, oldText, newText);
  const {lines, stats} = diffLines(hunks, offset);
  return {
    summary: [summaryPiece('+' + stats.added, 'added'), summaryPiece(' −' + stats.removed, 'removed')],
    body: {lines, empty: 'No changes'},
  };
}

export const UI: ToolUI = {
  visibility: 'visible',
  title(call) {
    return formatToolCardTitle(call);
  },
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    renderToolCard(context, {title: cardTitle(context, call), view: () => editView(callArgs(call))});
  },
};
