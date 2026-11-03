import type {SceneSegment} from '../../tui/timeline/scene.js';
import type {ToolUI} from '../ui-types.js';
import {createToolUI, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, type ToolLine, type ToolView} from '../../tui/timeline/tool-card.js';
import {faintColor} from '../../tui/appearance/colors.js';
import {palette} from '../../tui/appearance/theme.js';
import {callArgs} from '../ui-format.js';
import {pathSegments} from '../GlobTool/UI.js';

interface Hit {readonly line: string; readonly text: string; readonly context: boolean}
interface Group {readonly path: string; readonly hits: Hit[]; count?: number}

/** Parses Grep output (content, files_with_matches or count mode) into per-file groups. */
export function parseGrep(result: string, mode: string): {groups: Group[]; matches: number; limited: boolean} {
  const rows = result.split('\n');
  const limited = rows.at(-1)?.startsWith('(Display limit reached') ?? false;
  if (limited) rows.pop();
  const groups: Group[] = [], byPath = new Map<string, Group>();
  let matches = 0;
  const group = (path: string): Group => {
    let found = byPath.get(path);
    if (!found) {found = {path, hits: []}; byPath.set(path, found); groups.push(found);}
    return found;
  };
  for (const row of rows) {
    if (!row.trim() || row === 'No matches found.') continue;
    if (mode === 'files_with_matches') {group(row); matches++; continue;}
    if (mode === 'count') {
      const at = row.lastIndexOf(':'), count = Number(row.slice(at + 1));
      group(at > 0 ? row.slice(0, at) : row).count = Number.isFinite(count) ? count : 0;
      matches += Number.isFinite(count) ? count : 0; continue;
    }
    const hit = /^(.*?):(\d+): (.*)$/.exec(row);
    const context = hit ? undefined : /^(.*?)-(\d+)- (.*)$/.exec(row);
    const bare = hit || context ? undefined : /^(.*?): (.*)$/.exec(row);
    if (hit) {group(hit[1]!).hits.push({line: hit[2]!, text: hit[3]!, context: false}); matches++;}
    else if (context) group(context[1]!).hits.push({line: context[2]!, text: context[3]!, context: true});
    else if (bare) {group(bare[1]!).hits.push({line: '', text: bare[2]!, context: false}); matches++;}
  }
  return {groups, matches, limited};
}

/** Splits `text` so every match of `pattern` is bold in the warm highlight color. */
export function highlightMatches(text: string, pattern: RegExp | undefined, base: Omit<SceneSegment, 'text'>): SceneSegment[] {
  if (!pattern) return [{...base, text}];
  const parts: SceneSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    if (match.index > cursor) parts.push({...base, text: text.slice(cursor, match.index)});
    parts.push({...base, text: match[0], color: palette.highlight, bold: true});
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({...base, text: text.slice(cursor)});
  return parts.length ? parts : [{...base, text}];
}

const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;

/** Grep card view: hits grouped by file (path plus faint count), matched text highlighted; files-only and count modes list files. */
export function grepView(args: Record<string, unknown>, result: string): ToolView {
  const mode = typeof args.output_mode === 'string' ? args.output_mode : 'files_with_matches';
  const parsed = parseGrep(result, mode);
  if (!parsed.groups.length) return {body: {lines: [], empty: 'No matches'}};
  let pattern: RegExp | undefined;
  try {pattern = new RegExp(String(args.pattern ?? ''), 'g' + (args['-i'] === true ? 'i' : '') + 'u');} catch {pattern = undefined;}
  const faint = faintColor();
  const lines: ToolLine[] = [];
  const width = Math.max(1, ...parsed.groups.flatMap(group => group.hits.map(hit => hit.line.length)));
  for (const group of parsed.groups) {
    const count = mode === 'count' ? group.count ?? 0 : group.hits.filter(hit => !hit.context).length;
    lines.push({segments: [...pathSegments(group.path), ...(mode === 'files_with_matches' ? [] : [{text: '  ' + count, color: faint}])]});
    for (const hit of group.hits) lines.push({segments: [
      {text: '  ' + hit.line.padStart(width) + '  ', color: faint},
      ...(hit.context ? [{text: hit.text, color: palette.muted}] : highlightMatches(hit.text, pattern, {color: palette.fg}))]});
  }
  const summary = mode === 'files_with_matches' ? plural(parsed.groups.length, 'file') : `${plural(parsed.matches, 'match', 'matches')} in ${plural(parsed.groups.length, 'file')}`;
  return {summary: [summaryPiece(summary + (parsed.limited ? ' · limit reached' : ''))], body: {lines}};
}

export const UI: ToolUI = {
  ...createToolUI(['pattern', 'path']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const args = callArgs(call);
    renderToolCard(context, {title: cardTitle(context, call), view: result => grepView(args, result)});
  },
};
