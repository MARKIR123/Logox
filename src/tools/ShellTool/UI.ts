import type {ToolUI} from '../ui-types.js';
import {createToolUI, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, type ToolLine, type ToolView} from '../../tui/timeline/tool-card.js';
import {faintColor} from '../../tui/appearance/colors.js';
import {palette} from '../../tui/appearance/theme.js';
import {callArgs} from '../ui-format.js';
import {SHELL_CUT_SHORT_LINE} from './prompt.js';

const failureLine = /(error|failed|failure|exception|fatal|denied)|^\s*[✗×]/i;

/** Shell card view: `$ command`, the output tail (stderr and error-looking lines in the error color), red `exit N` only on failure, `No output`. */
export function shellView(command: string, result: string): ToolView {
  // A deliberate stop is a neutral outcome, not a failure: one muted reason, the partial output still below.
  const stopped = /^Stopped by (user|Director)\./.exec(result);
  const cut = stopped ? result.indexOf(SHELL_CUT_SHORT_LINE) : -1;
  const exit = stopped ? null : /^Exit code:\s*(-?\d+)\s*\n?/i.exec(result);
  const output = (stopped ? cut >= 0 ? result.slice(cut + SHELL_CUT_SHORT_LINE.length) : '' : exit ? result.slice(exit[0].length) : result).replace(/^\n|\s+$/g, '');
  const rows = output ? output.split(/\r?\n/) : [];
  let stderr = false;
  const lines: ToolLine[] = [];
  for (const row of rows) {
    if (/^Stderr:$/.test(row)) {stderr = true; continue;}
    lines.push({prose: row, color: stderr || failureLine.test(row) ? palette.error : palette.muted});
  }
  const head: ToolLine[] = command.split(/\r?\n/).filter(line => line.trim()).slice(0, 3).map((line, index) =>
    ({segments: [{text: index === 0 ? '$ ' : '  ', color: faintColor()}, {text: line, color: palette.path}]}));
  const code = exit ? Number(exit[1]) : undefined;
  if (stopped) return {summary: [summaryPiece('Stopped by ' + stopped[1], 'muted')], quietFault: true, markColor: palette.muted,
    body: {head, lines, tail: true, empty: 'No output'}};
  return {
    // Success is quiet: only a non-zero exit says anything.
    ...(code !== undefined && code !== 0 ? {summary: [summaryPiece('exit ' + code, 'error')]} : {}),
    quietFault: true,
    body: {head, lines, tail: true, empty: 'No output'},
  };
}

export const UI: ToolUI = {
  ...createToolUI(['command']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const command = String(callArgs(call).command ?? '');
    renderToolCard(context, {title: cardTitle(context, call), handlesFailure: true, view: result => shellView(command, result)});
  },
};
