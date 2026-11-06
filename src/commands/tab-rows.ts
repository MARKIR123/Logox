import type {TabLine, TabRow} from '../runtime/command-surface.js';

/** Explicit row constructors: producers say what a row is, so renderers never guess from the text. */
export const row = {
  heading: (text: string): TabRow => ({kind: 'heading', text}),
  field: (label: string, value: string | number): TabRow => ({kind: 'field', label, value: String(value)}),
  text: (text: string): TabRow => ({kind: 'text', text}),
  muted: (text: string): TabRow => ({kind: 'text', text, tone: 'muted'}),
  bullet: (text: string): TabRow => ({kind: 'text', text: '• ' + text, indent: 2}),
  rule: (title?: string): TabRow => ({kind: 'rule', ...(title ? {title} : {})}),
  blank: (): TabRow => ({kind: 'blank'}),
};
export function rowText(value: TabLine): string {
  if (typeof value === 'string') return value;
  if (value.kind === 'field') return value.label + ': ' + value.value;
  if (value.kind === 'rule') return value.title ? '── ' + value.title + ' ──' : '──────────';
  if (value.kind === 'blank') return '';
  return ' '.repeat(value.kind === 'text' ? value.indent ?? 0 : 0) + value.text;
}
/** Plain `lines` for copy, search and legacy consumers; `rows` only when some line is structured. */
export function tabContent(lines: readonly TabLine[]): {lines: string[]; rows?: TabRow[]} {
  const plain = lines.map(rowText);
  if (lines.every(line => typeof line === 'string')) return {lines: plain};
  return {lines: plain, rows: lines.map(line => typeof line === 'string' ? row.text(line) : line)};
}
