import type {ToolUI} from '../ui-types.js';
import {createToolUI, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, type ToolLine, type ToolView} from '../../tui/timeline/tool-card.js';
import {faintColor} from '../../tui/appearance/colors.js';
import {palette} from '../../tui/appearance/theme.js';
import {callArgs} from '../ui-format.js';

const failureLine = /(error|failed|failure|exception|fatal|denied)|^\s*[✗×]/i;

/** Shell card view: `$ command`, the output tail (stderr and error-looking lines in the error color), `exit N`, `No output`. */
export function shellView(command: string, result: string): ToolView {
  const exit = /^Exit code:\s*(-?\d+)\s*\n?/i.exec(result);
  const output = (exit ? result.slice(exit[0].length) : result).replace(/\s+$/, '');
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
  return {
    ...(code !== undefined ? {summary: [summaryPiece('exit ' + code, code === 0 ? 'success' : 'error')]} : {}),
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
