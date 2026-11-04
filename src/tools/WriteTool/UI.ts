import {structuredPatch} from 'diff';
import type {ToolUI} from '../ui-types.js';
import {createToolUI, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, diffSummary, renderToolCard, summaryPiece, type ToolView} from '../../tui/timeline/tool-card.js';
import {codeLines, diffLines} from '../../tui/timeline/tool-code.js';
import {callArgs} from '../ui-format.js';
import {lookupWrite} from './record.js';

/** Write card view: a new file shows its head like Read (`new file · N lines`); an overwrite shows the diff against the previous text when it is known. */
export function writeView(args: Record<string, unknown>): ToolView {
  const path = String(args.file_path ?? args.path ?? '');
  const content = typeof args.content === 'string' ? args.content : '';
  const record = lookupWrite(path, content);
  if (record?.existed && record.before !== undefined) {
    const patch = structuredPatch(path || 'file', path || 'file', record.before.replace(/\r\n/g, '\n'), content.replace(/\r\n/g, '\n'), '', '', {context: 3});
    const {lines, stats} = diffLines(patch.hunks);
    return {summary: diffSummary(stats), body: {lines, empty: 'No changes'}};
  }
  const rows = content ? content.replace(/\n$/, '').split(/\r?\n/) : [];
  const count = rows.length;
  const label = `${count} line${count === 1 ? '' : 's'}`;
  return {
    ...(count || record?.existed === false ? {summary: [summaryPiece(record && !record.existed ? (count ? `new file · ${label}` : 'new file') : label)]} : {}),
    body: {lines: codeLines(rows, 1, path), empty: 'Empty file'},
  };
}

export const UI: ToolUI = {
  ...createToolUI(['file_path', 'path']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    renderToolCard(context, {title: cardTitle(context, call), view: () => writeView(callArgs(call))});
  },
};
