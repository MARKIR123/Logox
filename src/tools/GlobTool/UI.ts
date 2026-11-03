import type {SceneSegment} from '../../tui/timeline/scene.js';
import type {ToolUI} from '../ui-types.js';
import {createToolUI, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, type ToolView} from '../../tui/timeline/tool-card.js';
import {faintColor} from '../../tui/appearance/colors.js';
import {palette} from '../../tui/appearance/theme.js';

/** A path with its directory part faint and the file name in the path color. */
export function pathSegments(path: string): SceneSegment[] {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return [...(at >= 0 ? [{text: path.slice(0, at + 1), color: faintColor()}] : []), {text: path.slice(at + 1), color: palette.path}];
}

/** Glob card view: one path per row, directory faint, `N files`. */
export function globView(result: string): ToolView {
  const rows = result.split('\n').filter(row => row.trim());
  const limited = rows.at(-1)?.startsWith('(Showing first') ?? false;
  if (limited) rows.pop();
  const files = rows.filter(row => !/^(?:No files|0 files|No matching)/i.test(row));
  if (!files.length) return {body: {lines: [], empty: 'No files matched'}};
  return {
    summary: [summaryPiece(`${files.length}${limited ? '+' : ''} file${files.length === 1 ? '' : 's'}`)],
    body: {lines: files.map(file => ({segments: pathSegments(file)}))},
  };
}

export const UI: ToolUI = {
  ...createToolUI(['pattern', 'path']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    renderToolCard(context, {title: cardTitle(context, call), view: globView});
  },
};
